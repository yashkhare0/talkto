/**
 * OpenCode SDK client manager.
 *
 * Manages cached client instances per server URL and provides typed
 * wrappers around the OpenCode SDK for session management, invocation,
 * and event subscription.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/client";
import type {
  Session,
  Part,
  TextPart,
  AssistantMessage,
  SessionStatus,
  Event as OpenCodeEvent,
  EventSessionStatus,
  EventSessionIdle,
  EventSessionError,
  EventMessageUpdated,
  EventMessagePartUpdated,
} from "@opencode-ai/sdk";

/**
 * Event type for streaming text deltas from the OpenCode SSE stream.
 * 
 * The v2 SDK defines this as `EventMessagePartDelta` but doesn't export it
 * from a public path. The v1 SDK doesn't define it at all, even though
 * the server sends these events. We define it here for type safety.
 * 
 * IMPORTANT: The SSE event type is `message.part.delta` — NOT `message.part.updated`.
 * `message.part.updated` contains the full accumulated text snapshot (no delta).
 * `message.part.delta` contains the incremental text fragment for streaming.
 */
interface EventMessagePartDelta {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
}

// Re-export useful types for consumers
export type {
  Session,
  Part,
  TextPart,
  AssistantMessage,
  SessionStatus,
  OpenCodeEvent,
  EventSessionStatus,
  EventSessionIdle,
  EventSessionError,
  EventMessageUpdated,
  EventMessagePartUpdated,
};

// Default timeout for session.prompt() calls (10 minutes)
const PROMPT_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Client cache — one client per server URL
// ---------------------------------------------------------------------------

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

const clients = new Map<string, OpencodeClient>();

/**
 * Get or create an OpenCode SDK client (v1) for a given server URL.
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

/** Remove cached clients (e.g., when server becomes unreachable). */
export function removeClient(serverUrl: string): void {
  const normalized = serverUrl.replace(/\/$/, "");
  clients.delete(normalized);
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
// Session status — busy/idle detection
// ---------------------------------------------------------------------------

/**
 * Get status for all sessions on an OpenCode server.
 *
 * Returns a map of sessionId → SessionStatus.
 * Only sessions with non-default (non-idle) status appear in the response.
 * If a session is NOT in the map, it is idle.
 */
export async function getSessionStatuses(
  serverUrl: string
): Promise<Record<string, SessionStatus>> {
  try {
    const client = getClient(serverUrl);
    const result = await client.session.status();
    return (result.data ?? {}) as Record<string, SessionStatus>;
  } catch (err) {
    console.error(`[OPENCODE] Failed to get session statuses at ${serverUrl}:`, err);
    return {};
  }
}

/**
 * Get the status of a specific session.
 *
 * Returns the session's status. If the session is not in the status map,
 * it's assumed idle (this is the OpenCode API behavior — idle sessions
 * are simply absent from the response).
 *
 * Returns null if the server is unreachable or the session doesn't exist.
 */
export async function getSessionStatus(
  serverUrl: string,
  sessionId: string
): Promise<SessionStatus | null> {
  try {
    // First verify the session exists
    const session = await getSession(serverUrl, sessionId);
    if (!session) return null;

    const statuses = await getSessionStatuses(serverUrl);
    return statuses[sessionId] ?? { type: "idle" };
  } catch {
    return null;
  }
}

/**
 * Check if a session is currently busy (processing a prompt).
 */
export async function isSessionBusy(
  serverUrl: string,
  sessionId: string
): Promise<boolean> {
  const status = await getSessionStatus(serverUrl, sessionId);
  return status?.type === "busy";
}

// ---------------------------------------------------------------------------
// Event subscription — SSE stream from OpenCode server
// ---------------------------------------------------------------------------

/**
 * Subscribe to the SSE event stream from an OpenCode server.
 *
 * Returns an async generator that yields typed OpenCode events.
 * The stream auto-reconnects on disconnect (built into the SDK).
 *
 * Events include:
 * - session.status — session busy/idle transitions
 * - session.idle — session became idle
 * - session.error — agent error
 * - message.updated — full message when complete
 * - message.part.updated — streaming text delta
 *
 * Caller is responsible for consuming the generator. To stop, use
 * generator.return() or break from the for-await loop.
 */
export async function subscribeToEvents(
  serverUrl: string
): Promise<AsyncGenerator<OpenCodeEvent, void, unknown> | null> {
  try {
    const client = getClient(serverUrl);
    const result = await client.event.subscribe();
    // The SDK returns { stream: AsyncGenerator } at the top level
    const stream = (result as { stream?: AsyncGenerator<OpenCodeEvent, void, unknown> }).stream;
    if (!stream) {
      console.error("[OPENCODE] event.subscribe() returned no stream");
      return null;
    }
    return stream;
  } catch (err) {
    console.error(`[OPENCODE] Failed to subscribe to events at ${serverUrl}:`, err);
    return null;
  }
}

/**
 * Filter an event stream for events related to a specific session.
 *
 * Yields only events that have a sessionID property matching the target,
 * or events that relate to a message in that session.
 */
export async function* filterEventsBySession(
  stream: AsyncGenerator<OpenCodeEvent, void, unknown>,
  sessionId: string
): AsyncGenerator<OpenCodeEvent, void, unknown> {
  for await (const event of stream) {
    if (isEventForSession(event, sessionId)) {
      yield event;
    }
  }
}

/**
 * Check if an event relates to a specific session.
 */
function isEventForSession(event: OpenCodeEvent, sessionId: string): boolean {
  const props = (event as { properties?: Record<string, unknown> }).properties;
  if (!props) return false;

  // Direct sessionID field
  if (props.sessionID === sessionId) return true;

  // Message events have sessionID inside info
  if (props.info && typeof props.info === "object") {
    const info = props.info as Record<string, unknown>;
    if (info.sessionID === sessionId) return true;
  }

  // Part events: check for sessionID in the part
  if (props.part && typeof props.part === "object") {
    const part = props.part as Record<string, unknown>;
    if (part.sessionID === sessionId) return true;
  }

  return false;
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
 * Prompt a session with real-time event callbacks.
 *
 * Like promptSession() but accepts callbacks that fire as SSE events
 * arrive during processing. This enables real-time typing indicators
 * and streaming text in the TalkTo UI.
 *
 * Uses session.prompt() (blocking) in parallel with event.subscribe()
 * to capture intermediate events while waiting for the final response.
 *
 * @param onTypingStart - Called when the session becomes busy
 * @param onTextDelta - Called with incremental text as the agent generates it
 * @param onComplete - Called when the session returns to idle
 * @param onError - Called if the session encounters an error
 */
export async function promptSessionWithEvents(
  serverUrl: string,
  sessionId: string,
  text: string,
  callbacks: {
    onTypingStart?: () => void;
    onTextDelta?: (delta: string) => void;
    onComplete?: () => void;
    onError?: (error: string) => void;
  } = {},
  timeoutMs: number = PROMPT_TIMEOUT_MS
): Promise<{ text: string; cost: number; tokens: { input: number; output: number } } | null> {
  // Start the event stream before sending the prompt so we don't miss events
  let eventStream: AsyncGenerator<OpenCodeEvent, void, unknown> | null = null;
  let eventLoopDone = false;

  try {
    eventStream = await subscribeToEvents(serverUrl);

    // Start consuming events in the background
    const eventLoop = (async () => {
      if (!eventStream) return;
      try {
        for await (const event of eventStream) {
          if (eventLoopDone) break;
          if (!isEventForSession(event, sessionId)) continue;

          switch (event.type) {
            case "session.status": {
              const status = (event as EventSessionStatus).properties.status;
              if (status.type === "busy") {
                callbacks.onTypingStart?.();
              } else if (status.type === "idle") {
                callbacks.onComplete?.();
              }
              break;
            }
            case "session.idle":
              callbacks.onComplete?.();
              break;
            case "message.part.delta": {
              // Streaming text delta — the primary source for real-time text
              const deltaEvent = event as unknown as EventMessagePartDelta;
              if (deltaEvent.properties.field === "text" && deltaEvent.properties.delta) {
                callbacks.onTextDelta?.(deltaEvent.properties.delta);
              }
              break;
            }
            case "message.part.updated": {
              // Fallback: v1 type says delta might be here (legacy compat)
              const delta = (event as EventMessagePartUpdated).properties.delta;
              if (delta) {
                callbacks.onTextDelta?.(delta);
              }
              break;
            }
            case "session.error": {
              const err = (event as EventSessionError).properties.error;
              const msg = err && "name" in err ? err.name : "Unknown error";
              callbacks.onError?.(msg ?? "Unknown error");
              break;
            }
          }
        }
      } catch {
        // Stream ended or errored — this is expected when we clean up
      }
    })();

    // Send the prompt (blocks until response)
    const result = await promptSession(serverUrl, sessionId, text, timeoutMs);

    // Clean up the event stream
    eventLoopDone = true;
    if (eventStream) {
      eventStream.return(undefined).catch(() => {});
    }
    await eventLoop.catch(() => {});

    return result;
  } catch (err) {
    eventLoopDone = true;
    if (eventStream) {
      eventStream.return(undefined).catch(() => {});
    }
    console.error(`[OPENCODE] Failed promptWithEvents for ${sessionId}:`, err);
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
// Discovery — find OpenCode servers and match sessions to projects
// ---------------------------------------------------------------------------

/**
 * Normalize a file path for cross-platform comparison.
 * Converts backslashes to forward slashes and strips trailing slashes.
 * This ensures Windows paths (C:\Users\...) match Unix paths (C:/Users/...).
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/$/, "");
}

/**
 * Find a session matching a project path from a list of sessions.
 * Matches by the session's `directory` field.
 * Cross-platform: normalizes path separators before comparison.
 */
export function matchSessionByProject(
  sessions: Session[],
  projectPath: string
): Session | null {
  const normalized = normalizePath(projectPath);

  // Exact match first
  const exact = sessions.find(
    (s) => normalizePath(s.directory ?? "") === normalized
  );
  if (exact) return exact;

  // Parent directory match (project is a subdirectory of the session's cwd)
  const parent = sessions.find((s) =>
    normalized.startsWith(normalizePath(s.directory ?? "") + "/")
  );
  if (parent) return parent;

  // Child directory match (session's cwd is inside the project)
  const child = sessions.find((s) =>
    normalizePath(s.directory ?? "").startsWith(normalized + "/")
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
