/**
 * Codex CLI SDK wrapper.
 *
 * Provides the same semantic interface as claude.ts and opencode.ts for session
 * management, invocation, and streaming — adapted for the Codex SDK's subprocess
 * model.
 *
 * Key characteristics (mirrors Claude Code, not OpenCode):
 * - No server URL — Codex runs `codex exec` as a subprocess
 * - Session liveness tracked locally via in-process Set (no REST health endpoint)
 * - Busy state tracked via in-process Set (no status API)
 * - Streaming via JSONL events on stdout (not SSE)
 *
 * Codex-specific differences from Claude Code:
 * - Uses "threads" instead of "sessions" (but we expose the same interface)
 * - Resume via `codex.resumeThread(threadId)` (threads persist to ~/.codex/sessions/)
 * - Events are structured JSONL: thread.started, turn.*, item.* (not stream_event)
 * - Text comes from `item.completed` where item.type === "agent_message"
 * - Streaming text comes from `item.updated` where item.type === "agent_message"
 * - Usage comes from `turn.completed` events
 */

import { Codex } from "@openai/codex-sdk";
import type {
  Turn,
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  Usage,
  TurnCompletedEvent,
  TurnFailedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  ThreadStartedEvent,
  ThreadErrorEvent,
  ThreadOptions,
  CodexOptions,
} from "@openai/codex-sdk";

// Re-export useful types for consumers
export type {
  Turn,
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  Usage,
  TurnCompletedEvent,
  TurnFailedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  ThreadStartedEvent,
  ThreadErrorEvent,
  ThreadOptions,
  CodexOptions,
};

// Default timeout for prompt calls (10 minutes — matches opencode.ts and claude.ts)
const PROMPT_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Codex client singleton
// ---------------------------------------------------------------------------

/** Lazy-initialized Codex client instance. */
let codexClient: Codex | null = null;

/**
 * Get the shared Codex client, creating it on first call.
 * Unlike OpenCode (which caches per server URL), Codex is always local.
 */
function getClient(): Codex {
  if (!codexClient) {
    codexClient = new Codex({
      // Agent mode: bypass all approval prompts, full filesystem access
    });
  }
  return codexClient;
}

// ---------------------------------------------------------------------------
// Thread state tracking — in-process (no REST API available)
// ---------------------------------------------------------------------------

/**
 * Set of thread IDs that are currently being prompted.
 * Since Codex runs as subprocesses, there's no REST status endpoint.
 * We track busy state locally.
 */
const busyThreads = new Set<string>();

/**
 * Set of thread IDs known to be alive (registered or successfully prompted).
 * Cleared on TalkTo restart — agents become ghosts until re-register.
 */
const knownAliveThreads = new Set<string>();

/**
 * Mark a thread as known-alive (e.g., after successful registration or prompt).
 */
export function markSessionAlive(threadId: string): void {
  knownAliveThreads.add(threadId);
}

/**
 * Mark a thread as dead (e.g., after failed prompt or deregistration).
 */
export function markSessionDead(threadId: string): void {
  knownAliveThreads.delete(threadId);
  busyThreads.delete(threadId);
}

// ---------------------------------------------------------------------------
// Session operations — mirror opencode.ts / claude.ts interface
// ---------------------------------------------------------------------------

/**
 * Check if a Codex thread is alive.
 *
 * Since Codex has no REST API for thread lookups, we rely on local tracking.
 * A thread is considered alive if it was successfully registered or has
 * completed a prompt since the last TalkTo restart.
 */
export async function isSessionAlive(threadId: string): Promise<boolean> {
  return knownAliveThreads.has(threadId);
}

/**
 * Check if a Codex thread is currently busy (processing a prompt).
 */
export async function isSessionBusy(threadId: string): Promise<boolean> {
  return busyThreads.has(threadId);
}

// ---------------------------------------------------------------------------
// Invocation — send a prompt to an agent's Codex thread
// ---------------------------------------------------------------------------

/** Default thread options for TalkTo agent invocations. */
const AGENT_THREAD_OPTIONS: ThreadOptions = {
  approvalPolicy: "never",
  sandboxMode: "danger-full-access",
  skipGitRepoCheck: true,
};

/**
 * Send a prompt to a Codex thread and wait for the response.
 *
 * Uses the Codex SDK's thread.run() which spawns a `codex exec` subprocess.
 * The thread is resumed by ID so the agent retains conversation history.
 *
 * Includes a timeout (default 10 minutes) as a safety net.
 */
export async function promptSession(
  threadId: string,
  text: string,
  timeoutMs: number = PROMPT_TIMEOUT_MS
): Promise<{
  text: string;
  cost: number;
  tokens: { input: number; output: number };
} | null> {
  busyThreads.add(threadId);

  try {
    const client = getClient();
    const thread = client.resumeThread(threadId, AGENT_THREAD_OPTIONS);

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    let turn: Turn;
    try {
      turn = await thread.run(text, { signal: abortController.signal });
    } finally {
      clearTimeout(timeout);
    }

    const result = {
      text: turn.finalResponse?.trim() ?? "",
      cost: 0, // Codex SDK doesn't expose cost in the same way
      tokens: {
        input: turn.usage?.input_tokens ?? 0,
        output: turn.usage?.output_tokens ?? 0,
      },
    };

    markSessionAlive(threadId);
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(
        `[CODEX] Prompt timed out after ${timeoutMs}ms for thread ${threadId}`
      );
    } else {
      console.error(`[CODEX] Failed to prompt thread ${threadId}:`, err);
    }
    return null;
  } finally {
    busyThreads.delete(threadId);
  }
}

/**
 * Prompt a thread with real-time event callbacks.
 *
 * Like promptSession() but accepts callbacks that fire as streaming events
 * arrive during processing. This enables real-time typing indicators
 * and streaming text in the TalkTo UI.
 *
 * Uses thread.runStreamed() to get JSONL events containing text deltas.
 *
 * @param onTypingStart - Called when the thread starts processing
 * @param onTextDelta - Called with incremental text as the agent generates it
 * @param onComplete - Called when the thread finishes
 * @param onError - Called if the thread encounters an error
 */
export async function promptSessionWithEvents(
  threadId: string,
  text: string,
  callbacks: {
    onTypingStart?: () => void;
    onTextDelta?: (delta: string) => void;
    onComplete?: () => void;
    onError?: (error: string) => void;
  } = {},
  timeoutMs: number = PROMPT_TIMEOUT_MS
): Promise<{
  text: string;
  cost: number;
  tokens: { input: number; output: number };
} | null> {
  busyThreads.add(threadId);

  try {
    const client = getClient();
    const thread = client.resumeThread(threadId, AGENT_THREAD_OPTIONS);

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    let finalText = "";
    let usage: Usage | null = null;
    let typingStarted = false;
    let lastAgentText = "";

    try {
      const streamed = await thread.runStreamed(text, {
        signal: abortController.signal,
      });

      for await (const event of streamed.events) {
        switch (event.type) {
          case "thread.started":
          case "turn.started": {
            if (!typingStarted) {
              typingStarted = true;
              callbacks.onTypingStart?.();
            }
            break;
          }

          case "item.started": {
            if (!typingStarted) {
              typingStarted = true;
              callbacks.onTypingStart?.();
            }
            // Reset tracking for new agent message
            if (event.item.type === "agent_message") {
              lastAgentText = "";
            }
            break;
          }

          case "item.updated": {
            // Streaming text delta — agent_message items get progressively updated
            if (event.item.type === "agent_message") {
              const currentText = (event.item as AgentMessageItem).text;
              // Compute the delta: new text since last update
              if (currentText.length > lastAgentText.length) {
                const delta = currentText.slice(lastAgentText.length);
                callbacks.onTextDelta?.(delta);
              }
              lastAgentText = currentText;
            }
            break;
          }

          case "item.completed": {
            if (event.item.type === "agent_message") {
              finalText = (event.item as AgentMessageItem).text;
            }
            break;
          }

          case "turn.completed": {
            usage = (event as TurnCompletedEvent).usage;
            callbacks.onComplete?.();
            break;
          }

          case "turn.failed": {
            const errorMsg = (event as TurnFailedEvent).error.message;
            console.error(`[CODEX] Thread ${threadId} turn failed: ${errorMsg}`);
            callbacks.onError?.(errorMsg);
            callbacks.onComplete?.();
            break;
          }

          case "error": {
            const errorMsg = (event as ThreadErrorEvent).message;
            console.error(`[CODEX] Thread ${threadId} error: ${errorMsg}`);
            callbacks.onError?.(errorMsg);
            break;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    const result = {
      text: finalText?.trim() ?? "",
      cost: 0, // Codex SDK doesn't expose cost
      tokens: {
        input: usage?.input_tokens ?? 0,
        output: usage?.output_tokens ?? 0,
      },
    };

    if (result.text) {
      markSessionAlive(threadId);
    }

    return result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error(
        `[CODEX] Prompt timed out after ${timeoutMs}ms for thread ${threadId}`
      );
      callbacks.onError?.(`Prompt timed out after ${timeoutMs}ms`);
    } else {
      console.error(
        `[CODEX] Failed promptWithEvents for ${threadId}:`,
        err
      );
      callbacks.onError?.(
        err instanceof Error ? err.message : "Unknown error"
      );
    }
    return null;
  } finally {
    busyThreads.delete(threadId);
  }
}

/**
 * Extract the final text response from a completed Codex turn.
 * Looks for the last agent_message item in the turn's items array.
 */
export function extractTextFromTurn(turn: Turn): string {
  // turn.finalResponse is the primary source
  if (turn.finalResponse) {
    return turn.finalResponse.trim();
  }

  // Fallback: scan items for the last agent_message
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const item = turn.items[i];
    if (item.type === "agent_message") {
      return (item as AgentMessageItem).text?.trim() ?? "";
    }
  }

  return "";
}
