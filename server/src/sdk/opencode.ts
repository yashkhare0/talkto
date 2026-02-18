/**
 * OpenCode SDK client manager.
 *
 * Manages cached client instances per server URL and provides typed
 * wrappers around the OpenCode SDK for session management, invocation,
 * and event subscription.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/client";
import type { Session, Part, TextPart, AssistantMessage } from "@opencode-ai/sdk";

// Re-export useful types for consumers
export type { Session, Part, TextPart, AssistantMessage };

// Default timeout for session.prompt() calls (3 minutes)
const PROMPT_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Client cache — one client per server URL
// ---------------------------------------------------------------------------

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

const clients = new Map<string, OpencodeClient>();

/**
 * Get or create an OpenCode SDK client for a given server URL.
 * Clients are cached per URL to avoid creating new connections per call.
 */
export function getClient(serverUrl: string): OpencodeClient {
  const normalized = serverUrl.replace(/\/$/, "");
  let client = clients.get(normalized);
  if (!client) {
    client = createOpencodeClient({ baseUrl: normalized });
    clients.set(normalized, client);
  }
  return client;
}

/** Remove a cached client (e.g., when server becomes unreachable). */
export function removeClient(serverUrl: string): void {
  clients.delete(serverUrl.replace(/\/$/, ""));
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

/**
 * List all sessions on an OpenCode server.
 * NOTE: This is project-scoped — only returns sessions for the server's
 * current project context. Use getSession() for cross-project lookups.
 * Returns an empty array if the server is unreachable.
 */
export async function listSessions(serverUrl: string): Promise<Session[]> {
  try {
    const client = getClient(serverUrl);
    const result = await client.session.list();
    return (result.data ?? []) as Session[];
  } catch (err) {
    console.error(`[OPENCODE] Failed to list sessions at ${serverUrl}:`, err);
    return [];
  }
}

/**
 * Get a specific session by ID.
 * Works cross-project — returns the session regardless of which project it
 * belongs to (unlike session.list which is project-scoped).
 * Returns null if the session doesn't exist or the server is unreachable.
 */
export async function getSession(
  serverUrl: string,
  sessionId: string
): Promise<Session | null> {
  try {
    const client = getClient(serverUrl);
    const result = await client.session.get({ path: { id: sessionId } });
    return (result.data ?? null) as Session | null;
  } catch {
    return null;
  }
}

/**
 * Check if a session is alive on an OpenCode server.
 * Uses session.get() (direct lookup) instead of session.list() because
 * session.list() is project-scoped and won't see cross-project sessions.
 */
export async function isSessionAlive(
  serverUrl: string,
  sessionId: string
): Promise<boolean> {
  const session = await getSession(serverUrl, sessionId);
  return session !== null;
}

/**
 * Check if an OpenCode server is reachable.
 * Uses session.list() as a health check since client.global.health doesn't exist.
 */
export async function isServerHealthy(serverUrl: string): Promise<boolean> {
  try {
    const client = getClient(serverUrl);
    const result = await client.session.list();
    return Array.isArray(result.data);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Invocation — send a prompt to an agent's registered session
// ---------------------------------------------------------------------------

/**
 * Send a prompt to an OpenCode session and wait for the response.
 *
 * Uses session.prompt() which blocks until the AI finishes processing.
 * The session ID should be the agent's registered session — their own
 * running OpenCode instance. This works cross-project.
 *
 * Includes a timeout (default 3 minutes) as a safety net.
 */
export async function promptSession(
  serverUrl: string,
  sessionId: string,
  text: string,
  timeoutMs: number = PROMPT_TIMEOUT_MS
): Promise<{ text: string; cost: number; tokens: { input: number; output: number } } | null> {
  try {
    const client = getClient(serverUrl);

    // Race the SDK call against a timeout
    const promptPromise = client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text }],
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Prompt timed out after ${timeoutMs}ms`)), timeoutMs)
    );

    const result = await Promise.race([promptPromise, timeoutPromise]);

    if (!result.data) {
      console.error("[OPENCODE] No data in prompt response");
      return null;
    }

    // result.data is { info: AssistantMessage, parts: Part[] }
    const data = result.data as { info: AssistantMessage; parts: Part[] };

    // Check for errors in the assistant message
    if (data.info.error) {
      console.error(
        "[OPENCODE] Agent error:",
        data.info.error.name,
        "data" in data.info.error ? (data.info.error as { data: { message: string } }).data.message : ""
      );
      return null;
    }

    // Extract text from response parts
    const responseText = extractTextFromParts(data.parts);

    return {
      text: responseText,
      cost: data.info.cost ?? 0,
      tokens: {
        input: data.info.tokens?.input ?? 0,
        output: data.info.tokens?.output ?? 0,
      },
    };
  } catch (err) {
    console.error(`[OPENCODE] Failed to prompt session ${sessionId}:`, err);
    return null;
  }
}

/**
 * Extract readable text content from an array of response parts.
 * Filters for TextPart entries and concatenates their text.
 */
export function extractTextFromParts(parts: Part[]): string {
  const textParts = parts.filter(
    (p): p is TextPart => p.type === "text" && !p.ignored
  );
  return textParts.map((p) => p.text).join("\n").trim();
}

// ---------------------------------------------------------------------------
// TUI operations (for Phase 4 — active TUI session support)
// ---------------------------------------------------------------------------

/**
 * Append text to the TUI prompt and submit it.
 * Used for active TUI sessions where we want the agent to see the
 * message naturally in their terminal.
 *
 * Returns true if both operations succeeded.
 */
export async function tuiPrompt(
  serverUrl: string,
  text: string
): Promise<boolean> {
  try {
    const client = getClient(serverUrl);
    const appendResult = await client.tui.appendPrompt({ body: { text } });
    if (!appendResult.data) return false;
    const submitResult = await client.tui.submitPrompt();
    return submitResult.data === true;
  } catch (err) {
    console.error("[OPENCODE] TUI prompt failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discovery — find OpenCode servers and match sessions to projects
// ---------------------------------------------------------------------------

/**
 * Find a session matching a project path from a list of sessions.
 * Matches by the session's `directory` field.
 */
export function matchSessionByProject(
  sessions: Session[],
  projectPath: string
): Session | null {
  const normalized = projectPath.replace(/\/$/, "");

  // Exact match first
  const exact = sessions.find(
    (s) => s.directory?.replace(/\/$/, "") === normalized
  );
  if (exact) return exact;

  // Parent directory match (project is a subdirectory of the session's cwd)
  const parent = sessions.find((s) =>
    normalized.startsWith(s.directory?.replace(/\/$/, "") + "/")
  );
  if (parent) return parent;

  // Child directory match (session's cwd is inside the project)
  const child = sessions.find((s) =>
    s.directory?.replace(/\/$/, "").startsWith(normalized + "/")
  );
  if (child) return child;

  return null;
}

/**
 * Discover an OpenCode session for a given project path on a server.
 * Lists all sessions and matches by directory.
 *
 * Optionally excludes sessions already claimed by other agents.
 */
export async function discoverSession(
  serverUrl: string,
  projectPath: string,
  excludeSessionIds?: Set<string>
): Promise<Session | null> {
  const sessions = await listSessions(serverUrl);
  const filtered = excludeSessionIds
    ? sessions.filter((s) => !excludeSessionIds.has(s.id))
    : sessions;

  // Only match root sessions (no parentID) — child sessions are sub-agents
  const rootSessions = filtered.filter((s) => !s.parentID);
  return matchSessionByProject(rootSessions, projectPath);
}
