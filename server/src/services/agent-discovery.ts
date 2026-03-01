/**
 * Agent discovery — verify agent liveness and resolve invocation info.
 *
 * Supports multiple agent providers (OpenCode, Claude Code, Codex CLI). Routes
 * liveness checks to the appropriate SDK based on agent_type.
 *
 * No auto-discovery: if an agent's session is dead, it becomes a ghost
 * and must re-register with a valid session_id. Auto-discovery was removed
 * because all OpenCode sessions share the same directory path, making
 * project-based session matching meaningless and causing identity theft.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { agents } from "../db/schema";
import { isSessionAlive as isOpenCodeSessionAlive } from "../sdk/opencode";
import { isSessionAlive as isClaudeSessionAlive } from "../sdk/claude";
import { isSessionAlive as isCodexSessionAlive } from "../sdk/codex";

// ---------------------------------------------------------------------------
// Invocation info resolution
// ---------------------------------------------------------------------------

export interface InvocationInfo {
  serverUrl: string | null;
  sessionId: string;
  projectPath: string;
  agentType: string;
}

/**
 * Look up an agent's invocation details and verify they're still valid.
 *
 * Flow:
 * 1. Read server_url + provider_session_id from DB
 * 2. If both exist, verify session is alive via SDK
 * 3. If stale (session dead), clear credentials — agent becomes a ghost
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

  // If we have credentials, verify liveness based on agent type
  if (sessionId) {
    let alive = false;

    if (agent.agentType === "claude_code") {
      // Claude Code — subprocess model, no server URL needed
      alive = await isClaudeSessionAlive(sessionId);
    } else if (agent.agentType === "codex") {
      // Codex CLI — subprocess model, no server URL needed
      alive = await isCodexSessionAlive(sessionId);
    } else if (serverUrl) {
      // OpenCode — REST client-server model
      alive = await isOpenCodeSessionAlive(serverUrl, sessionId);
    }

    if (alive) {
      console.log(
        `[DISCOVERY] '${agentName}' is alive: type=${agent.agentType} server=${serverUrl ?? "n/a"} session=${sessionId}`
      );
      return { serverUrl: serverUrl ?? null, sessionId, projectPath: agent.projectPath, agentType: agent.agentType };
    }

    // Session is dead — clear stale credentials
    console.log(
      `[DISCOVERY] '${agentName}' session ${sessionId} is DEAD — clearing stale credentials`
    );
    clearStaleCredentials(agentName);
    serverUrl = null;
    sessionId = null;
  }

  // No auto-discovery. If an agent's session is dead, it becomes a ghost.
  // The agent must re-register with a valid session_id to come back.
  //
  // Auto-discovery was removed because ALL OpenCode sessions share the same
  // directory path, making project-based session matching meaningless.
  // This caused agents to get reassigned to wrong sessions (identity theft).
  console.log(
    `[DISCOVERY] '${agentName}' has no valid session — agent is a ghost. Must re-register.`
  );
  return null;
}

/**
 * Clear server_url and provider_session_id for an agent with a dead session,
 * and mark the agent as offline (ghost).
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
      .set({ serverUrl: null, providerSessionId: null, status: "offline" })
      .where(eq(agents.id, agent.id))
      .run();
    console.log(
      `[DISCOVERY] Cleared stale credentials for '${agentName}' — marked offline`
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

  // If agent has credentials, check if session is alive (route by provider)
  if (agent.providerSessionId) {
    let alive = false;
    if (agent.agentType === "claude_code") {
      alive = await isClaudeSessionAlive(agent.providerSessionId);
    } else if (agent.agentType === "codex") {
      alive = await isCodexSessionAlive(agent.providerSessionId);
    } else if (agent.serverUrl) {
      alive = await isOpenCodeSessionAlive(agent.serverUrl, agent.providerSessionId);
    }
    if (alive) return false;
    // Session is dead — agent is a ghost
    return true;
  }

  // No credentials at all — ghost
  return true;
}
