/**
 * Agent invocation — send messages to agents and post their responses.
 *
 * Communication protocol:
 * - All replies use session.prompt() via the OpenCode SDK
 * - TalkTo extracts the response text and posts it to the channel as the agent
 * - Agents never need the send_message MCP tool for replies (only for proactive messages)
 * - Text deltas stream to the frontend via agent_streaming WebSocket events
 *
 * Agent-to-agent chaining:
 * - When an agent's response contains @mentions, those agents are automatically invoked
 * - Chain depth is tracked and capped at MAX_CHAIN_DEPTH to prevent infinite loops
 * - Each chained invocation includes recent channel context so agents see the conversation
 *
 * DMs: prompt with just the message — the agent's own session has its context
 * @mentions: prompt with last 5 channel messages as context
 *
 * Invocations run as fire-and-forget background tasks with typing state broadcasts.
 */

import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import { agents, messages, users } from "../db/schema";
import {
  broadcastEvent,
  newMessageEvent,
  agentTypingEvent,
  agentStreamingEvent,
} from "./broadcaster";
import { getAgentInvocationInfo } from "./agent-discovery";
import {
  promptSessionWithEvents,
  isSessionBusy,
} from "../sdk/opencode";

// Maximum depth for agent-to-agent invocation chains.
// Prevents infinite loops when agents keep @mentioning each other.
const MAX_CHAIN_DEPTH = 5;

// ---------------------------------------------------------------------------
// @mention extraction from raw text
// ---------------------------------------------------------------------------

/**
 * Extract @mentions from message text and validate them against registered agents.
 *
 * Matches patterns like @spicy-bat, @silly-narwhal, @the_creator.
 * Only returns names that correspond to actual registered agents.
 * Excludes the sender to prevent self-invocation.
 */
function extractMentionsFromText(text: string, excludeSender?: string): string[] {
  // Match @word patterns (agent names are adjective-animal with hyphens/underscores)
  const mentionPattern = /@([\w-]+)/g;
  const mentioned = new Set<string>();
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    const name = match[1];
    if (name !== excludeSender) {
      mentioned.add(name);
    }
  }

  if (mentioned.size === 0) return [];

  // Validate against registered agents
  const db = getDb();
  const validAgents: string[] = [];

  for (const name of mentioned) {
    const agent = db
      .select({ agentName: agents.agentName })
      .from(agents)
      .where(eq(agents.agentName, name))
      .get();
    if (agent) {
      validAgents.push(agent.agentName);
    }
  }

  return validAgents;
}

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
 * - Chain depth tracked to prevent infinite agent-to-agent loops
 *
 * @param depth - Current chain depth (0 = human-initiated, 1+ = agent-chained)
 */
export function invokeForMessage(
  senderName: string,
  channelId: string,
  channelName: string,
  content: string,
  mentions: string[] | null,
  depth: number = 0
): void {
  if (depth >= MAX_CHAIN_DEPTH) {
    console.log(
      `[INVOKE] Chain depth ${depth} reached max ${MAX_CHAIN_DEPTH} — stopping chain`
    );
    return;
  }

  spawnBackgroundTask(async () => {
    await _invokeForMessage(senderName, channelId, channelName, content, mentions, depth);
  });
}

async function _invokeForMessage(
  senderName: string,
  channelId: string,
  channelName: string,
  content: string,
  mentions: string[] | null,
  depth: number
): Promise<void> {
  console.log(
    `[INVOKE] Starting: sender=${senderName} channel=${channelName} mentions=${JSON.stringify(mentions)} depth=${depth}`
  );
  const invoked = new Set<string>();

  // DM channel → invoke the target agent
  if (channelName.startsWith("#dm-")) {
    const target = channelName.replace("#dm-", "");
    if (target === senderName) {
      console.log(`[INVOKE] Skipping self-invocation for '${target}'`);
    } else {
      await invokeAgent(target, channelId, channelName, content, /* isDm */ true, depth);
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
        await invokeAgent(mentioned, channelId, channelName, prompt, /* isDm */ false, depth);
        invoked.add(mentioned);
      });

    await Promise.allSettled(tasks);
  }

  console.log(
    `[INVOKE] Complete. Invoked agents: ${invoked.size > 0 ? [...invoked].join(", ") : "none"} (depth=${depth})`
  );
}

// ---------------------------------------------------------------------------
// Single agent invocation
// ---------------------------------------------------------------------------

/**
 * Invoke a single agent via OpenCode SDK and post the response.
 *
 * Uses session.prompt() with SSE event callbacks for real-time streaming.
 * Text deltas stream to the frontend via `agent_streaming` WebSocket events.
 *
 * Note: TUI injection was investigated but OpenCode TUI terminals run without
 * an HTTP server by default (they use in-process RPC via Web Workers). The TUI
 * APIs on the `opencode serve` port publish to a separate Bus instance that
 * doesn't reach the TUI terminal. session.prompt() works reliably and the TUI
 * still sees the conversation via the shared database.
 *
 * Flow:
 * 1. Broadcast agent_typing (start)
 * 2. Look up invocation info (server_url + session_id)
 * 3. Check if session is busy — log warning but still proceed (will queue)
 * 4. Send prompt via session.prompt() with SSE callbacks
 * 5. Extract text from response
 * 6. Post message in channel as the agent
 * 7. Broadcast new_message + agent_typing (stop)
 *
 * On error: broadcast agent_typing with error message.
 */
async function invokeAgent(
  agentName: string,
  channelId: string,
  channelName: string,
  prompt: string,
  isDm: boolean,
  depth: number = 0
): Promise<void> {
  console.log(
    `[INVOKE] Invoking '${agentName}' in ${channelName} (${isDm ? "DM" : "@mention"})`
  );

  // Broadcast typing start
  broadcastEvent(agentTypingEvent(agentName, channelId, true));

  try {
    // Look up invocation info — the agent's registered server_url + session_id
    const info = await getAgentInvocationInfo(agentName);
    if (!info) {
      console.warn(`[INVOKE] '${agentName}' is not invocable`);
      broadcastEvent(
        agentTypingEvent(agentName, channelId, false, `${agentName} is not reachable`)
      );
      return;
    }

    // Check if session is currently busy
    const busy = await isSessionBusy(info.serverUrl, info.sessionId);
    if (busy) {
      console.warn(`[INVOKE] '${agentName}' session is busy — prompt will queue`);
    }

    // SSE callbacks — stream real-time events to the frontend
    const callbacks = {
      onTypingStart: () => {
        // Re-broadcast typing to confirm agent is actively processing
        broadcastEvent(agentTypingEvent(agentName, channelId, true));
      },
      onTextDelta: (delta: string) => {
        // Stream each text fragment to the frontend in real-time
        broadcastEvent(agentStreamingEvent(agentName, channelId, delta));
      },
      onError: (error: string) => {
        console.error(`[INVOKE] SSE error for '${agentName}':`, error);
      },
    };

    console.log(
      `[INVOKE] Prompting '${agentName}' session=${info.sessionId} server=${info.serverUrl}`
    );

    const result = await promptSessionWithEvents(
      info.serverUrl,
      info.sessionId,
      prompt,
      callbacks
    );

    if (!result || !result.text) {
      console.warn(`[INVOKE] No response from '${agentName}'`);
      broadcastEvent(
        agentTypingEvent(agentName, channelId, false, `${agentName} did not respond`)
      );
      return;
    }

    console.log(
      `[INVOKE] Got response from '${agentName}' (${result.text.length} chars, cost: $${result.cost.toFixed(4)})`
    );

    // Post the agent's response as a message in the channel
    // Also triggers agent-to-agent chaining if the response contains @mentions
    postAgentResponse(agentName, channelId, channelName, result.text, depth);

    // Broadcast typing stop (success)
    broadcastEvent(agentTypingEvent(agentName, channelId, false));
  } catch (err) {
    console.error(`[INVOKE] Error invoking '${agentName}':`, err);
    broadcastEvent(
      agentTypingEvent(agentName, channelId, false, `${agentName} encountered an error`)
    );
  }
}

// ---------------------------------------------------------------------------
// Post agent response to channel
// ---------------------------------------------------------------------------

/**
 * Create a message in a channel as an agent and broadcast it.
 * This is how SDK-native responses get posted to TalkTo.
 *
 * Also handles agent-to-agent chaining: if the response contains @mentions
 * of other agents, those agents are automatically invoked (up to MAX_CHAIN_DEPTH).
 */
function postAgentResponse(
  agentName: string,
  channelId: string,
  channelName: string,
  content: string,
  depth: number = 0
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

  // Extract @mentions from the response text
  const mentionedAgents = extractMentionsFromText(content, agentName);
  const mentionsJson = mentionedAgents.length > 0 ? JSON.stringify(mentionedAgents) : null;

  const msgId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(messages)
    .values({
      id: msgId,
      channelId,
      senderId: agent.id,
      content,
      mentions: mentionsJson,
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
      mentions: mentionedAgents.length > 0 ? mentionedAgents : null,
      createdAt: now,
      senderType: "agent",
    })
  );

  console.log(
    `[INVOKE] Posted response from '${agentName}' to ${channelName} (${content.length} chars, mentions: ${mentionedAgents.length > 0 ? mentionedAgents.join(", ") : "none"})`
  );

  // Agent-to-agent chaining: if the response @mentions other agents, invoke them
  if (mentionedAgents.length > 0 && depth + 1 < MAX_CHAIN_DEPTH) {
    console.log(
      `[INVOKE] Agent-to-agent chain: '${agentName}' mentioned ${mentionedAgents.join(", ")} (depth ${depth} → ${depth + 1})`
    );
    invokeForMessage(agentName, channelId, channelName, content, mentionedAgents, depth + 1);
  } else if (mentionedAgents.length > 0) {
    console.log(
      `[INVOKE] Agent-to-agent chain stopped: depth ${depth + 1} would exceed max ${MAX_CHAIN_DEPTH}`
    );
  }
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
 * the agent's own session has its own conversation history.
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
