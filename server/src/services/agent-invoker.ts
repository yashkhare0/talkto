/**
 * Agent invocation — send messages to agents and post their responses.
 *
 * Communication protocol:
 * - All replies use SDK-native responses (session.prompt() returns the response)
 * - TalkTo extracts the response text and posts it to the channel as the agent
 * - Agents never need the send_message MCP tool for replies (only for proactive messages)
 *
 * DMs: session.prompt() with just the message — OpenCode session has its own history
 * @mentions: session.prompt() with last 5-10 channel messages as context
 *
 * Invocations run as fire-and-forget background tasks with typing state broadcasts.
 */

import { eq, desc, sql, ne, and } from "drizzle-orm";
import { getDb } from "../db";
import { agents, channels, messages, users } from "../db/schema";
import { broadcastEvent, newMessageEvent, agentTypingEvent } from "./broadcaster";
import { getAgentInvocationInfo } from "./agent-discovery";
import { promptSession, getOrCreateInvocationSession } from "../sdk/opencode";

// ---------------------------------------------------------------------------
// Background task tracking — prevents GC of fire-and-forget promises
// ---------------------------------------------------------------------------

const _backgroundTasks = new Set<Promise<void>>();

function spawnBackgroundTask(fn: () => Promise<void>): void {
  const task = fn().catch((err) =>
    console.error("[INVOKE] Background task failed:", err)
  );
  _backgroundTasks.add(task);
  task.finally(() => _backgroundTasks.delete(task));
}

// ---------------------------------------------------------------------------
// Invocation orchestrator
// ---------------------------------------------------------------------------

/**
 * Invoke agents based on DM channel or @mentions.
 *
 * This is the main entry point called from message handlers.
 * It spawns a background task (fire-and-forget) so the HTTP response
 * returns immediately to the human.
 *
 * - DM channel (#dm-{agent_name}): invoke the target agent directly
 * - @mentions: invoke each mentioned agent with channel context
 * - Never invokes the sender (prevents self-invocation loops)
 */
export function invokeForMessage(
  senderName: string,
  channelId: string,
  channelName: string,
  content: string,
  mentions: string[] | null
): void {
  spawnBackgroundTask(async () => {
    await _invokeForMessage(senderName, channelId, channelName, content, mentions);
  });
}

async function _invokeForMessage(
  senderName: string,
  channelId: string,
  channelName: string,
  content: string,
  mentions: string[] | null
): Promise<void> {
  console.log(
    `[INVOKE] Starting: sender=${senderName} channel=${channelName} mentions=${JSON.stringify(mentions)}`
  );
  const invoked = new Set<string>();

  // DM channel → invoke the target agent
  if (channelName.startsWith("#dm-")) {
    const target = channelName.replace("#dm-", "");
    if (target === senderName) {
      console.log(`[INVOKE] Skipping self-invocation for '${target}'`);
    } else {
      await invokeAgent(target, channelId, channelName, content, /* isDm */ true);
      invoked.add(target);
    }
  }

  // @mentions → invoke each mentioned agent
  if (mentions && mentions.length > 0) {
    // For @mentions, build context from recent channel messages
    const context = fetchRecentContext(channelId, 5);

    // Invoke mentioned agents in parallel
    const tasks = mentions
      .filter((name) => !invoked.has(name) && name !== senderName)
      .map(async (mentioned) => {
        const prompt = formatChannelPrompt(
          senderName,
          channelName,
          content,
          context
        );
        await invokeAgent(mentioned, channelId, channelName, prompt, /* isDm */ false);
        invoked.add(mentioned);
      });

    await Promise.allSettled(tasks);
  }

  console.log(
    `[INVOKE] Complete. Invoked agents: ${invoked.size > 0 ? [...invoked].join(", ") : "none"}`
  );
}

// ---------------------------------------------------------------------------
// Single agent invocation
// ---------------------------------------------------------------------------

/**
 * Invoke a single agent via OpenCode SDK and post the response.
 *
 * Flow:
 * 1. Broadcast agent_typing (start)
 * 2. Look up invocation info (server_url + session_id)
 * 3. Call session.prompt() via SDK
 * 4. Extract text from response
 * 5. Create message in channel as the agent
 * 6. Broadcast new_message + agent_typing (stop)
 *
 * On error: broadcast agent_typing with error message.
 */
async function invokeAgent(
  agentName: string,
  channelId: string,
  channelName: string,
  prompt: string,
  isDm: boolean
): Promise<void> {
  console.log(
    `[INVOKE] Invoking '${agentName}' in ${channelName} (${isDm ? "DM" : "@mention"})`
  );

  // Broadcast typing start
  broadcastEvent(agentTypingEvent(agentName, channelId, true));

  try {
    // Look up invocation info (server URL + liveness check)
    const info = await getAgentInvocationInfo(agentName);
    if (!info) {
      console.warn(`[INVOKE] '${agentName}' is not invocable`);
      broadcastEvent(
        agentTypingEvent(agentName, channelId, false, `${agentName} is not reachable`)
      );
      return;
    }

    // Get or create a dedicated invocation session for this agent.
    // We don't use the agent's registered session (which may be their active TUI
    // session and would hang on prompt()). Instead, each agent gets a dedicated
    // invocation session that maintains its own conversation history.
    //
    // On first creation, we inject system context (agent identity, TalkTo info,
    // operator info) via noReply so the agent knows who it is.
    const db = getDb();
    const agent = db
      .select()
      .from(agents)
      .where(eq(agents.agentName, agentName))
      .get();
    const projectDir = agent?.projectPath ?? process.cwd();

    const systemContext = buildSystemContext(agentName, agent);

    const invocationSessionId = await getOrCreateInvocationSession(
      info.serverUrl,
      agentName,
      projectDir,
      systemContext
    );
    if (!invocationSessionId) {
      console.warn(`[INVOKE] Could not create invocation session for '${agentName}'`);
      broadcastEvent(
        agentTypingEvent(agentName, channelId, false, `${agentName} session unavailable`)
      );
      return;
    }

    // Send prompt via SDK and wait for response (with timeout)
    const result = await promptSession(info.serverUrl, invocationSessionId, prompt);
    if (!result || !result.text) {
      console.warn(`[INVOKE] No response from '${agentName}'`);
      broadcastEvent(
        agentTypingEvent(
          agentName,
          channelId,
          false,
          `${agentName} did not respond`
        )
      );
      return;
    }

    console.log(
      `[INVOKE] Got response from '${agentName}' (${result.text.length} chars, cost: $${result.cost.toFixed(4)})`
    );

    // Post the agent's response as a message in the channel
    postAgentResponse(agentName, channelId, channelName, result.text);

    // Broadcast typing stop (success)
    broadcastEvent(agentTypingEvent(agentName, channelId, false));
  } catch (err) {
    console.error(`[INVOKE] Error invoking '${agentName}':`, err);
    broadcastEvent(
      agentTypingEvent(
        agentName,
        channelId,
        false,
        `${agentName} encountered an error`
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Post agent response to channel
// ---------------------------------------------------------------------------

/**
 * Create a message in a channel as an agent and broadcast it.
 * This is how SDK-native responses get posted to TalkTo.
 */
function postAgentResponse(
  agentName: string,
  channelId: string,
  channelName: string,
  content: string
): void {
  const db = getDb();

  // Look up agent's user ID
  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();
  if (!agent) {
    console.error(`[INVOKE] Agent '${agentName}' not found — cannot post response`);
    return;
  }

  const msgId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(messages)
    .values({
      id: msgId,
      channelId,
      senderId: agent.id,
      content,
      createdAt: now,
    })
    .run();

  // Broadcast to WebSocket clients
  broadcastEvent(
    newMessageEvent({
      messageId: msgId,
      channelId,
      senderId: agent.id,
      senderName: agentName,
      content,
      createdAt: now,
      senderType: "agent",
    })
  );

  console.log(
    `[INVOKE] Posted response from '${agentName}' to ${channelName} (${content.length} chars)`
  );
}

// ---------------------------------------------------------------------------
// Context and prompt formatting
// ---------------------------------------------------------------------------

/**
 * Fetch the last N messages from a channel as formatted context text.
 * Returns a string like:
 *   Bossu: fix the auth bug
 *   plucky-sparrow: I'll look into it
 */
function fetchRecentContext(channelId: string, limit: number = 5): string {
  const db = getDb();

  const rows = db
    .select({
      senderName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
      content: messages.content,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(eq(messages.channelId, channelId))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();

  if (rows.length === 0) return "";

  // Reverse to chronological order
  rows.reverse();
  return rows.map((r) => `  ${r.senderName}: ${r.content}`).join("\n");
}

/**
 * Format a prompt for @mention invocations in channels.
 *
 * Includes recent channel messages as context so the agent knows
 * what the conversation is about. For DMs, we don't use this —
 * the OpenCode session has its own conversation history.
 */
function formatChannelPrompt(
  senderName: string,
  channelName: string,
  content: string,
  recentContext: string
): string {
  const lines: string[] = [
    `[TalkTo] ${senderName} mentioned you in ${channelName}.`,
    "",
  ];

  if (recentContext) {
    lines.push("Recent messages in the channel:");
    lines.push(recentContext);
    lines.push("");
  }

  lines.push(`${senderName}: ${content}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// System context — injected into new invocation sessions via noReply
// ---------------------------------------------------------------------------

/**
 * Build the system context string injected into a newly created invocation
 * session. This gives the agent its identity, project info, and knowledge
 * of TalkTo before it receives its first real prompt.
 *
 * Only called once per session creation (not on every message).
 */
function buildSystemContext(
  agentName: string,
  agent: typeof agents.$inferSelect | undefined
): string {
  const db = getDb();

  // Look up the human operator
  const operator = db
    .select()
    .from(users)
    .where(eq(users.type, "human"))
    .get();

  const operatorName = operator?.displayName ?? operator?.name ?? "the Boss";

  // Look up agent's user record for display name
  const agentUser = agent
    ? db.select().from(users).where(eq(users.id, agent.id)).get()
    : undefined;
  const displayName = agentUser?.displayName ?? agentName;

  // Build compact but informative system context
  const lines: string[] = [
    `# TalkTo — System Context`,
    ``,
    `You are **${displayName}** (agent name: \`${agentName}\`), an AI agent on TalkTo.`,
    ``,
    `## What is TalkTo?`,
    `TalkTo is a local-first messaging platform for AI agents — like Slack, but every team member is an AI agent. A human operator oversees everything through a real-time web UI. No cloud, no auth — everything stays on the local machine.`,
    ``,
    `## Your Human Operator`,
    `Your boss is **${operatorName}**. You call them Boss. Their instructions take priority.`,
  ];

  if (operator?.about) {
    lines.push(`About the Boss: ${operator.about}`);
  }
  if (operator?.agentInstructions) {
    lines.push(`Standing orders: ${operator.agentInstructions}`);
  }

  lines.push(``);
  lines.push(`## Your Profile`);

  if (agent) {
    lines.push(`- **Project**: ${agent.projectName}`);
    if (agent.description) lines.push(`- **Description**: ${agent.description}`);
    if (agent.personality) lines.push(`- **Personality**: ${agent.personality}`);
    if (agent.currentTask) lines.push(`- **Current task**: ${agent.currentTask}`);
  }

  // List other known agents so this agent knows its coworkers
  const otherAgents = db
    .select({
      name: agents.agentName,
      project: agents.projectName,
      description: agents.description,
    })
    .from(agents)
    .where(
      and(
        ne(agents.agentName, agentName),
        ne(agents.agentType, "system")
      )
    )
    .all();

  if (otherAgents.length > 0) {
    lines.push(``);
    lines.push(`## Other Agents on TalkTo`);
    for (const a of otherAgents) {
      const d = a.description ? ` — ${a.description}` : "";
      lines.push(`- **${a.name}** (${a.project})${d}`);
    }
  }

  // List channels (channels table has no description column)
  const allChannels = db
    .select({ name: channels.name, type: channels.type })
    .from(channels)
    .all();

  if (allChannels.length > 0) {
    lines.push(``);
    lines.push(`## Channels`);
    for (const ch of allChannels) {
      lines.push(`- ${ch.name} (${ch.type})`);
    }
  }

  lines.push(``);
  lines.push(`## Guidelines`);
  lines.push(`- Be yourself. You have a personality — use it.`);
  lines.push(`- When replying in DMs, you're having a direct conversation with the sender.`);
  lines.push(`- When replying to @mentions in channels, other agents can see your response.`);
  lines.push(`- Keep responses helpful and natural. You're a coworker, not a search engine.`);
  lines.push(`- If someone asks about TalkTo or the project, you know about it — use this context.`);

  return lines.join("\n");
}
