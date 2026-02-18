/**
 * Agent discovery — find OpenCode servers and resolve invocation info.
 *
 * Simplified from the Python backend's 4-strategy approach:
 * - Uses OpenCode SDK's session.list() instead of ps/process-tree walking
 * - Keeps lsof for server port discovery (SDK needs a baseUrl)
 * - session_id is required at registration, so discovery is mostly
 *   about verifying liveness and recovering from stale credentials
 */

import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { agents } from "../db/schema";
import {
  isSessionAlive,
  isServerHealthy,
  discoverSession,
  listSessions,
  removeClient,
} from "../sdk/opencode";

// ---------------------------------------------------------------------------
// Server discovery — find running OpenCode servers via lsof
// ---------------------------------------------------------------------------

/**
 * Find a running OpenCode serve process and return its URL.
 *
 * Scans `lsof -i -P -n` for opencode processes listening on 127.0.0.1.
 * Only needed when an agent didn't provide server_url at registration.
 */
export function discoverOpenCodeServer(): string | null {
  try {
    const output = execSync("lsof -i -P -n", {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Match: opencode  20636  user  10u  IPv4 ...  TCP 127.0.0.1:19877 (LISTEN)
    const pattern = /opencode.*TCP\s+127\.0\.0\.1:(\d+)\s+\(LISTEN\)/;
    for (const line of output.split("\n")) {
      const match = pattern.exec(line);
      if (match) {
        const url = `http://127.0.0.1:${match[1]}`;
        console.log(`[DISCOVERY] Found OpenCode server at ${url}`);
        return url;
      }
    }
  } catch {
    // lsof not available or timed out
  }

  console.log("[DISCOVERY] No running OpenCode server found");
  return null;
}

// ---------------------------------------------------------------------------
// Invocation info resolution
// ---------------------------------------------------------------------------

export interface InvocationInfo {
  serverUrl: string;
  sessionId: string;
  projectPath: string;
}

/**
 * Look up an agent's invocation details and verify they're still valid.
 *
 * Flow:
 * 1. Read server_url + provider_session_id from DB
 * 2. If both exist, verify session is alive via SDK
 * 3. If stale (session dead), clear credentials and attempt discovery
 * 4. If missing, attempt discovery (lsof for server, session.list() for session)
 *
 * Returns invocation info or null if agent is not invocable.
 */
export async function getAgentInvocationInfo(
  agentName: string
): Promise<InvocationInfo | null> {
  const db = getDb();

  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();

  if (!agent) {
    console.log(`[DISCOVERY] Agent '${agentName}' not found in DB`);
    return null;
  }

  if (agent.agentType === "system") {
    console.log(`[DISCOVERY] '${agentName}' is a system agent — not invocable`);
    return null;
  }

  let serverUrl = agent.serverUrl;
  let sessionId = agent.providerSessionId;

  // If we have credentials, verify liveness
  if (serverUrl && sessionId) {
    const alive = await isSessionAlive(serverUrl, sessionId);
    if (alive) {
      console.log(
        `[DISCOVERY] '${agentName}' is alive: server=${serverUrl} session=${sessionId}`
      );
      return { serverUrl, sessionId, projectPath: agent.projectPath };
    }

    // Session is dead — clear stale credentials
    console.log(
      `[DISCOVERY] '${agentName}' session ${sessionId} is DEAD — clearing stale credentials`
    );
    clearStaleCredentials(agentName);
    serverUrl = null;
    sessionId = null;
  }

  // Attempt auto-discovery
  console.log(
    `[DISCOVERY] Attempting auto-discovery for '${agentName}'...`
  );

  // Step 1: Find server URL
  if (!serverUrl) {
    serverUrl = discoverOpenCodeServer();
    if (!serverUrl) {
      console.log(
        `[DISCOVERY] No OpenCode server found for '${agentName}'`
      );
      return null;
    }
  }

  // Step 2: Verify server is healthy
  const healthy = await isServerHealthy(serverUrl);
  if (!healthy) {
    console.log(`[DISCOVERY] Server ${serverUrl} is not healthy`);
    removeClient(serverUrl);
    return null;
  }

  // Step 3: Find matching session by project path
  // Collect sessions already claimed by other agents to exclude them
  const allAgents = db.select().from(agents).all();
  const excludeSessionIds = new Set<string>();
  for (const a of allAgents) {
    if (
      a.agentName !== agentName &&
      a.providerSessionId &&
      a.providerSessionId.trim()
    ) {
      excludeSessionIds.add(a.providerSessionId);
    }
  }

  const session = await discoverSession(
    serverUrl,
    agent.projectPath,
    excludeSessionIds
  );

  if (!session) {
    console.log(
      `[DISCOVERY] No matching session found for '${agentName}' (project: ${agent.projectPath})`
    );
    return null;
  }

  sessionId = session.id;

  // Persist discovered credentials
  db.update(agents)
    .set({ serverUrl, providerSessionId: sessionId })
    .where(eq(agents.id, agent.id))
    .run();

  console.log(
    `[DISCOVERY] Auto-discovered for '${agentName}': server=${serverUrl} session=${sessionId} (persisted)`
  );

  return { serverUrl, sessionId, projectPath: agent.projectPath };
}

/**
 * Clear server_url and provider_session_id for an agent with a dead session.
 */
export function clearStaleCredentials(agentName: string): void {
  const db = getDb();
  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();

  if (agent) {
    db.update(agents)
      .set({ serverUrl: null, providerSessionId: null })
      .where(eq(agents.id, agent.id))
      .run();
    console.log(
      `[DISCOVERY] Cleared stale credentials for '${agentName}'`
    );
  }
}

/**
 * Check if an agent is a ghost (unreachable, stale registration).
 *
 * A ghost has no valid invocation credentials and no live session.
 * System agents (the_creator) are never ghosts.
 */
export async function isAgentGhost(agentName: string): Promise<boolean> {
  const db = getDb();

  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();

  if (!agent) return false;
  if (agent.agentType === "system") return false;

  // If agent has credentials, check if session is alive
  if (agent.serverUrl && agent.providerSessionId) {
    const alive = await isSessionAlive(agent.serverUrl, agent.providerSessionId);
    if (alive) return false;
    // Session is dead — agent is a ghost
    return true;
  }

  // No credentials at all — ghost
  return true;
}
