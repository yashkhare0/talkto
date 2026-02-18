/**
 * Claude Code SDK wrapper.
 *
 * Provides the same semantic interface as opencode.ts for session management,
 * invocation, and streaming — adapted for the Claude Agent SDK's subprocess
 * model (vs OpenCode's REST client-server model).
 *
 * Key differences from OpenCode:
 * - No server URL — Claude runs as a subprocess via query()
 * - Session liveness tracked locally (no REST health endpoint)
 * - Busy state tracked via in-process Set (no status API)
 * - Streaming via async generator messages (not SSE)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  Query,
} from "@anthropic-ai/claude-agent-sdk";

// Re-export useful types for consumers
export type {
  SDKMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  Query,
};

// Default timeout for prompt calls (10 minutes — matches opencode.ts)
const PROMPT_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Session state tracking — in-process (no REST API available)
// ---------------------------------------------------------------------------

/**
 * Set of session IDs that are currently being prompted.
 * Since Claude runs as subprocesses, there's no REST status endpoint.
 * We track busy state locally.
 */
const busySessions = new Set<string>();

/**
 * Set of session IDs known to be alive (successfully prompted at least once).
 * Cleared on TalkTo restart — agents become ghosts until re-register.
 */
const knownAliveSessions = new Set<string>();

/**
 * Mark a session as known-alive (e.g., after successful registration or prompt).
 */
export function markSessionAlive(sessionId: string): void {
  knownAliveSessions.add(sessionId);
}

/**
 * Mark a session as dead (e.g., after failed prompt or deregistration).
 */
export function markSessionDead(sessionId: string): void {
  knownAliveSessions.delete(sessionId);
  busySessions.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Session operations — mirror opencode.ts interface
// ---------------------------------------------------------------------------

/**
 * Check if a Claude Code session is alive.
 *
 * Since Claude has no REST API for session lookups, we rely on local tracking.
 * A session is considered alive if it was successfully registered or has
 * completed a prompt since the last TalkTo restart.
 */
export async function isSessionAlive(sessionId: string): Promise<boolean> {
  return knownAliveSessions.has(sessionId);
}

/**
 * Check if a Claude Code session is currently busy (processing a prompt).
 */
export async function isSessionBusy(sessionId: string): Promise<boolean> {
  return busySessions.has(sessionId);
}

// ---------------------------------------------------------------------------
// Invocation — send a prompt to an agent's Claude Code session
// ---------------------------------------------------------------------------

/**
 * Send a prompt to a Claude Code session and wait for the response.
 *
 * Uses the Claude Agent SDK's query() function which spawns a subprocess.
 * The session is resumed by ID so the agent retains conversation history.
 *
 * Includes a timeout (default 10 minutes) as a safety net.
 */
export async function promptSession(
  sessionId: string,
  text: string,
  timeoutMs: number = PROMPT_TIMEOUT_MS
): Promise<{ text: string; cost: number; tokens: { input: number; output: number } } | null> {
  busySessions.add(sessionId);

  try {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const conversation = query({
      prompt: text,
      options: {
        resume: sessionId,
        abortController,
        permissionMode: "bypassPermissions",
      },
    });

    let result: { text: string; cost: number; tokens: { input: number; output: number } } | null = null;

    try {
      for await (const message of conversation) {
        if (message.type === "result") {
          const resultMsg = message as SDKResultMessage;
          if (resultMsg.subtype === "success") {
            const success = resultMsg as SDKResultSuccess;
            result = {
              text: success.result,
              cost: success.total_cost_usd ?? 0,
              tokens: {
                input: success.usage?.input_tokens ?? 0,
                output: success.usage?.output_tokens ?? 0,
              },
            };
          } else {
            const error = resultMsg as SDKResultError;
            console.error(
              `[CLAUDE] Session ${sessionId} returned error: ${error.subtype}`,
              error.errors?.join(", ") ?? ""
            );
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (result) {
      markSessionAlive(sessionId);
    }

    return result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[CLAUDE] Prompt timed out after ${timeoutMs}ms for session ${sessionId}`);
    } else {
      console.error(`[CLAUDE] Failed to prompt session ${sessionId}:`, err);
    }
    return null;
  } finally {
    busySessions.delete(sessionId);
  }
}

/**
 * Prompt a session with real-time event callbacks.
 *
 * Like promptSession() but accepts callbacks that fire as streaming events
 * arrive during processing. This enables real-time typing indicators
 * and streaming text in the TalkTo UI.
 *
 * Uses query() with includePartialMessages:true to get stream_event messages
 * containing text deltas.
 *
 * @param onTypingStart - Called when the session starts processing
 * @param onTextDelta - Called with incremental text as the agent generates it
 * @param onComplete - Called when the session finishes
 * @param onError - Called if the session encounters an error
 */
export async function promptSessionWithEvents(
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
  busySessions.add(sessionId);

  try {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    const conversation = query({
      prompt: text,
      options: {
        resume: sessionId,
        abortController,
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
      },
    });

    let result: { text: string; cost: number; tokens: { input: number; output: number } } | null = null;
    let typingStarted = false;

    try {
      for await (const message of conversation) {
        switch (message.type) {
          case "system": {
            // Init message — session has started
            const sysMsg = message as SDKSystemMessage;
            if (sysMsg.subtype === "init" && !typingStarted) {
              typingStarted = true;
              callbacks.onTypingStart?.();
            }
            break;
          }

          case "assistant": {
            // Full assistant message — typing has started
            if (!typingStarted) {
              typingStarted = true;
              callbacks.onTypingStart?.();
            }
            break;
          }

          case "stream_event": {
            // Streaming text delta from partial messages
            if (!typingStarted) {
              typingStarted = true;
              callbacks.onTypingStart?.();
            }
            const streamEvent = message as SDKPartialAssistantMessage;
            const event = streamEvent.event;
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              callbacks.onTextDelta?.(event.delta.text);
            }
            break;
          }

          case "result": {
            const resultMsg = message as SDKResultMessage;
            if (resultMsg.subtype === "success") {
              const success = resultMsg as SDKResultSuccess;
              result = {
                text: success.result,
                cost: success.total_cost_usd ?? 0,
                tokens: {
                  input: success.usage?.input_tokens ?? 0,
                  output: success.usage?.output_tokens ?? 0,
                },
              };
            } else {
              const error = resultMsg as SDKResultError;
              const errorMsg = error.errors?.join(", ") ?? error.subtype;
              console.error(`[CLAUDE] Session ${sessionId} error: ${errorMsg}`);
              callbacks.onError?.(errorMsg);
            }
            callbacks.onComplete?.();
            break;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    if (result) {
      markSessionAlive(sessionId);
    }

    return result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[CLAUDE] Prompt timed out after ${timeoutMs}ms for session ${sessionId}`);
      callbacks.onError?.(`Prompt timed out after ${timeoutMs}ms`);
    } else {
      console.error(`[CLAUDE] Failed promptWithEvents for ${sessionId}:`, err);
      callbacks.onError?.(err instanceof Error ? err.message : "Unknown error");
    }
    return null;
  } finally {
    busySessions.delete(sessionId);
  }
}

/**
 * Extract text from a Claude SDK result message.
 * The result.result field already contains the extracted text response.
 */
export function extractTextFromResult(result: SDKResultSuccess): string {
  return result.result?.trim() ?? "";
}
