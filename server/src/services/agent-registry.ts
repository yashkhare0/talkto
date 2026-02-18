/**
 * Agent registration and session management.
 *
 * Single entry point: registerOrConnectAgent() handles both new registrations
 * and reconnections. Agent type is determined by the caller (MCP register tool)
 * and can be "opencode", "claude_code", or "system".
 */

import { eq, and, sql } from "drizzle-orm";
import { execSync } from "node:child_process";
import { basename, normalize } from "node:path";
import { getDb } from "../db";
import {
  agents,
  channels,
  channelMembers,
  featureRequests,
  featureVotes,
  sessions,
  users,
} from "../db/schema";
import { broadcastEvent, agentStatusEvent, channelCreatedEvent, featureUpdateEvent } from "./broadcaster";
import { generateUniqueName } from "./name-generator";
import { promptEngine } from "./prompt-engine";
import { markSessionAlive as markClaudeSessionAlive } from "../sdk/claude";

/** Derive project name from path (git repo name or folder basename) */
function deriveProjectName(projectPath: string): string {
  try {
    const result = execSync(`git -C "${projectPath}" rev-parse --show-toplevel`, {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return basename(result.trim());
  } catch {
    return basename(normalize(projectPath));
  }
}

function makeChannelName(projectName: string): string {
  const clean = projectName.toLowerCase().replace(/[ _]/g, "-");
  return `#project-${clean}`;
}

/**
 * Register a new agent or reconnect an existing one.
 *
 * This is the single entry point for agent login. The `sessionId` is
 * required — it's the agent's login credential.
 *
 * @param agentType - Provider type: "opencode" or "claude_code" (default: "opencode")
 */
export function registerOrConnectAgent(opts: {
  sessionId: string;
  projectPath: string;
  agentName?: string | null;
  serverUrl?: string | null;
  agentType?: string;
}): Record<string, unknown> {
  const { sessionId, projectPath, agentName, serverUrl } = opts;
  const agentType = opts.agentType ?? "opencode";

  // For Claude Code agents, mark the session as alive on registration
  if (agentType === "claude_code") {
    markClaudeSessionAlive(sessionId);
  }

  // --- Reconnect path: agent_name provided and exists ---
  if (agentName) {
    const db = getDb();
    const existing = db
      .select()
      .from(agents)
      .where(eq(agents.agentName, agentName))
      .get();

    if (existing) {
      return reconnectAgent(existing, sessionId, serverUrl ?? null, projectPath, agentType);
    }
    // Agent name provided but doesn't exist — fall through to create new
  }

  // --- New registration path ---
  return createNewAgent({
    sessionId,
    projectPath,
    agentType,
    serverUrl: serverUrl ?? null,
  });
}

function reconnectAgent(
  agent: typeof agents.$inferSelect,
  sessionId: string,
  serverUrl: string | null,
  projectPath: string,
  agentType: string = "opencode"
): Record<string, unknown> {
  const db = getDb();

  // Update invocation fields
  const updates: Partial<typeof agents.$inferInsert> = {
    providerSessionId: sessionId,
    agentType,
    status: "online",
  };
  if (serverUrl) updates.serverUrl = serverUrl;
  // Claude Code agents don't have a server URL — clear it if switching providers
  if (agentType === "claude_code" && !serverUrl) updates.serverUrl = null;
  if (projectPath) {
    updates.projectPath = projectPath;
    updates.projectName = deriveProjectName(projectPath);
  }

  db.update(agents)
    .set(updates)
    .where(eq(agents.id, agent.id))
    .run();

  // Re-fetch to get updated values
  const updated = db.select().from(agents).where(eq(agents.id, agent.id)).get()!;

  broadcastEvent(
    agentStatusEvent({
      agentName: updated.agentName,
      status: "online",
      agentType: updated.agentType,
      projectName: updated.projectName,
    })
  );

  // Look up human operator for prompt context
  const human = db.select().from(users).where(eq(users.type, "human")).get();

  const channelName = makeChannelName(updated.projectName);
  const masterPrompt = promptEngine.renderMasterPrompt({
    agentName: updated.agentName,
    agentType: updated.agentType,
    projectName: updated.projectName,
    projectChannel: channelName,
    operatorName: human?.name ?? "",
    operatorDisplayName: human?.displayName ?? "",
    operatorAbout: human?.about ?? "",
    operatorInstructions: human?.agentInstructions ?? "",
  });
  const injectPrompt = promptEngine.renderRegistrationRules({
    agentName: updated.agentName,
    projectChannel: channelName,
  });

  // Build profile reminder
  const profile: Record<string, string> = {};
  if (updated.description) profile.description = updated.description;
  if (updated.personality) profile.personality = updated.personality;
  if (updated.currentTask) profile.current_task = updated.currentTask;
  if (updated.gender) profile.gender = updated.gender;

  return {
    status: "connected",
    agent_name: updated.agentName,
    project_channel: channelName,
    master_prompt: masterPrompt,
    inject_prompt: injectPrompt,
    profile: Object.keys(profile).length > 0 ? profile : null,
  };
}

function createNewAgent(opts: {
  sessionId: string;
  projectPath: string;
  agentType: string;
  serverUrl: string | null;
}): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();
  const projectName = deriveProjectName(opts.projectPath);
  const channelName = makeChannelName(projectName);

  // Generate a unique quirky name
  let agentName: string;
  let attempt = 0;
  do {
    agentName = generateUniqueName(projectName, opts.agentType, attempt);
    const collision = db
      .select()
      .from(agents)
      .where(eq(agents.agentName, agentName))
      .get();
    if (!collision) break;
    attempt++;
  } while (true);

  // Create user
  const userId = crypto.randomUUID();
  db.insert(users)
    .values({ id: userId, name: agentName, type: "agent", createdAt: now })
    .run();

  // Create agent
  db.insert(agents)
    .values({
      id: userId,
      agentName,
      agentType: opts.agentType,
      projectPath: opts.projectPath,
      projectName,
      status: "online",
      serverUrl: opts.serverUrl,
      providerSessionId: opts.sessionId,
    })
    .run();

  // Ensure project channel exists
  let channel = db.select().from(channels).where(eq(channels.name, channelName)).get();
  let createdChannel = false;
  if (!channel) {
    const channelId = crypto.randomUUID();
    db.insert(channels)
      .values({
        id: channelId,
        name: channelName,
        type: "project",
        projectPath: opts.projectPath,
        createdBy: userId,
        createdAt: now,
      })
      .run();
    channel = db.select().from(channels).where(eq(channels.id, channelId)).get()!;
    createdChannel = true;
  }

  // Add agent to project channel and #general
  db.insert(channelMembers)
    .values({ channelId: channel.id, userId, joinedAt: now })
    .run();

  const general = db.select().from(channels).where(eq(channels.name, "#general")).get();
  if (general) {
    db.insert(channelMembers)
      .values({ channelId: general.id, userId, joinedAt: now })
      .run();
  }

  // Broadcast agent online status
  broadcastEvent(
    agentStatusEvent({
      agentName,
      status: "online",
      agentType: opts.agentType,
      projectName,
    })
  );

  // Broadcast new channel creation if we created one
  if (createdChannel) {
    broadcastEvent(
      channelCreatedEvent({
        channelId: channel.id,
        channelName: channel.name,
        channelType: "project",
        projectPath: opts.projectPath,
      })
    );
  }

  // Look up human operator for prompt context
  const human = db.select().from(users).where(eq(users.type, "human")).get();

  const masterPrompt = promptEngine.renderMasterPrompt({
    agentName,
    agentType: opts.agentType,
    projectName,
    projectChannel: channelName,
    operatorName: human?.name ?? "",
    operatorDisplayName: human?.displayName ?? "",
    operatorAbout: human?.about ?? "",
    operatorInstructions: human?.agentInstructions ?? "",
  });
  const injectPrompt = promptEngine.renderRegistrationRules({
    agentName,
    projectChannel: channelName,
  });

  return {
    agent_name: agentName,
    master_prompt: masterPrompt,
    project_channel: channelName,
    inject_prompt: injectPrompt,
  };
}

/** Mark agent as offline and end active session */
export function disconnectAgent(agentName: string): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();

  const agent = db.select().from(agents).where(eq(agents.agentName, agentName)).get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  // End active sessions
  db.update(sessions)
    .set({ isActive: 0, endedAt: now })
    .where(and(eq(sessions.agentId, agent.id), eq(sessions.isActive, 1)))
    .run();

  db.update(agents).set({ status: "offline" }).where(eq(agents.id, agent.id)).run();

  broadcastEvent(
    agentStatusEvent({
      agentName,
      status: "offline",
      agentType: agent.agentType,
      projectName: agent.projectName,
    })
  );

  return { status: "disconnected", agent_name: agentName };
}

/** Update agent's last heartbeat */
export function heartbeatAgent(agentName: string): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();

  const agent = db.select().from(agents).where(eq(agents.agentName, agentName)).get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  db.update(sessions)
    .set({ lastHeartbeat: now })
    .where(and(eq(sessions.agentId, agent.id), eq(sessions.isActive, 1)))
    .run();

  return { status: "ok", agent_name: agentName };
}

/** List all agents for MCP tools */
export function listAllAgents(): Array<Record<string, unknown>> {
  const db = getDb();
  return db
    .select()
    .from(agents)
    .orderBy(agents.agentName)
    .all()
    .map((a) => {
      const entry: Record<string, unknown> = {
        name: a.agentName,
        type: a.agentType,
        project: a.projectName,
        status: a.status,
      };
      if (a.description) entry.description = a.description;
      if (a.personality) entry.personality = a.personality;
      if (a.currentTask) entry.current_task = a.currentTask;
      if (a.gender) entry.gender = a.gender;
      return entry;
    });
}

/** Update an agent's profile */
export function updateAgentProfile(
  agentName: string,
  profile: {
    description?: string | null;
    personality?: string | null;
    currentTask?: string | null;
    gender?: string | null;
  }
): Record<string, unknown> {
  if (profile.gender && !["male", "female", "non-binary"].includes(profile.gender)) {
    return { error: "Gender must be 'male', 'female', or 'non-binary'." };
  }

  const db = getDb();
  const agent = db.select().from(agents).where(eq(agents.agentName, agentName)).get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  const updates: Partial<typeof agents.$inferInsert> = {};
  if (profile.description !== undefined) updates.description = profile.description;
  if (profile.personality !== undefined) updates.personality = profile.personality;
  if (profile.currentTask !== undefined) updates.currentTask = profile.currentTask;
  if (profile.gender !== undefined) updates.gender = profile.gender;

  db.update(agents).set(updates).where(eq(agents.id, agent.id)).run();

  const updated = db.select().from(agents).where(eq(agents.id, agent.id)).get()!;

  return {
    status: "updated",
    agent_name: agentName,
    description: updated.description,
    personality: updated.personality,
    current_task: updated.currentTask,
    gender: updated.gender,
  };
}

/** Cast a vote on a feature request as an agent */
export function agentVoteFeature(
  agentName: string,
  featureId: string,
  vote: number
): Record<string, unknown> {
  if (vote !== 1 && vote !== -1) return { error: "Vote must be +1 or -1" };

  const db = getDb();
  const agent = db.select().from(agents).where(eq(agents.agentName, agentName)).get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  const feature = db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.id, featureId))
    .get();
  if (!feature) return { error: "Feature request not found." };

  // Upsert vote
  const existing = db
    .select()
    .from(featureVotes)
    .where(
      and(
        eq(featureVotes.featureId, featureId),
        eq(featureVotes.userId, agent.id)
      )
    )
    .get();

  if (existing) {
    db.update(featureVotes)
      .set({ vote })
      .where(
        and(
          eq(featureVotes.featureId, featureId),
          eq(featureVotes.userId, agent.id)
        )
      )
      .run();
  } else {
    db.insert(featureVotes)
      .values({ featureId, userId: agent.id, vote })
      .run();
  }

  // Get updated vote count
  const countRow = db
    .select({ total: sql<number>`coalesce(sum(${featureVotes.vote}), 0)` })
    .from(featureVotes)
    .where(eq(featureVotes.featureId, featureId))
    .get();
  const voteCount = Number(countRow?.total ?? 0);

  broadcastEvent(
    featureUpdateEvent({
      featureId,
      title: feature.title,
      status: feature.status,
      voteCount,
      updateType: "voted",
    })
  );

  return { status: "voted", feature_id: featureId, vote, vote_count: voteCount };
}

/** Create a feature request as an agent */
export function agentCreateFeature(
  agentName: string,
  title: string,
  description: string
): Record<string, unknown> {
  const db = getDb();
  const agent = db.select().from(agents).where(eq(agents.agentName, agentName)).get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(featureRequests)
    .values({
      id,
      title,
      description,
      status: "open",
      createdBy: agent.id,
      createdAt: now,
    })
    .run();

  broadcastEvent(
    featureUpdateEvent({
      featureId: id,
      title,
      status: "open",
      voteCount: 0,
      updateType: "created",
    })
  );

  return {
    status: "created",
    feature_id: id,
    title,
    description,
  };
}

/** List all feature requests with vote counts */
export function listAllFeatures(): Array<Record<string, unknown>> {
  const db = getDb();
  const rows = db
    .select({
      id: featureRequests.id,
      title: featureRequests.title,
      description: featureRequests.description,
      status: featureRequests.status,
      createdBy: featureRequests.createdBy,
      createdAt: featureRequests.createdAt,
      voteCount: sql<number>`coalesce(sum(${featureVotes.vote}), 0)`,
    })
    .from(featureRequests)
    .leftJoin(featureVotes, eq(featureRequests.id, featureVotes.featureId))
    .groupBy(featureRequests.id)
    .orderBy(featureRequests.createdAt)
    .all();

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    created_by: r.createdBy,
    created_at: r.createdAt,
    vote_count: Number(r.voteCount),
  }));
}
