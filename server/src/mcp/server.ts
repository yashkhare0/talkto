/**
 * TalkTo MCP Server — Agent-facing interface.
 *
 * Exposes tools for registration, messaging, and collaboration.
 * Uses @modelcontextprotocol/sdk with streamable HTTP transport at /mcp.
 *
 * Per-session agent identity is stored in a module-level Map keyed by
 * the MCP transport's session ID, persisting across tool calls.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_WORKSPACE_ID } from "../db";
import {
  registerOrConnectAgent,
  disconnectAgent,
  heartbeatAgent,
  listAllAgents,
  listAllFeatures,
  updateAgentProfile,
  agentCreateFeature,
  agentVoteFeature,
  agentUpdateFeatureStatus,
  agentDeleteFeature,
} from "../services/agent-registry";
import {
  listAllChannels,
  joinAgentToChannel,
  createNewChannel,
  setChannelTopic,
} from "../services/channel-manager";
import {
  sendAgentMessage,
  getAgentMessages,
  searchMessages,
  agentEditMessage,
  agentReactMessage,
} from "../services/message-router";

// ---------------------------------------------------------------------------
// Auto-discovery: find the OpenCode API server for session liveness checks
// ---------------------------------------------------------------------------

const OPENCODE_DEFAULT_PORT = 19877;

/** Try to discover the OpenCode API server URL by probing the default port. */
async function discoverOpenCodeServerUrl(sessionId: string): Promise<string | null> {
  const candidate = `http://127.0.0.1:${OPENCODE_DEFAULT_PORT}`;
  try {
    const resp = await fetch(`${candidate}/session/${sessionId}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      return candidate;
    }
  } catch {
    // Not reachable
  }
  return null;
}

/**
 * Auto-detect the agent type from context.
 *
 * Strategy:
 * 1. If explicit agent_type is provided, use it
 * 2. If server_url is provided, it's OpenCode (REST model)
 * 3. Try OpenCode auto-discovery on the default port
 * 4. If OpenCode discovery fails, assume Claude Code (subprocess model)
 *
 * Codex agents should always pass agent_type="codex" explicitly since
 * there's no way to auto-detect them from the session ID alone.
 */
async function detectAgentType(
  sessionId: string,
  explicitType?: string,
  serverUrl?: string | null
): Promise<{ agentType: string; resolvedServerUrl: string | null }> {
  // Explicit type wins
  if (explicitType && explicitType !== "auto") {
    if (explicitType === "claude_code" || explicitType === "codex") {
      // Subprocess-based agents — no server URL needed
      return { agentType: explicitType, resolvedServerUrl: null };
    }
    // OpenCode with optional server URL discovery
    const url = serverUrl ?? await discoverOpenCodeServerUrl(sessionId);
    return { agentType: "opencode", resolvedServerUrl: url };
  }

  // Server URL provided → must be OpenCode
  if (serverUrl) {
    return { agentType: "opencode", resolvedServerUrl: serverUrl };
  }

  // Try OpenCode auto-discovery first
  const discoveredUrl = await discoverOpenCodeServerUrl(sessionId);
  if (discoveredUrl) {
    return { agentType: "opencode", resolvedServerUrl: discoveredUrl };
  }

  // No OpenCode server found — default to Claude Code
  return { agentType: "claude_code", resolvedServerUrl: null };
}

// ---------------------------------------------------------------------------
// Session store: maps MCP session_id -> agent_name
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 1000;
const MAX_MESSAGES = 10;

interface SessionInfo {
  agentName: string;
  workspaceId: string;
}

const sessionAgents = new Map<string, SessionInfo>();

function getAgent(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return sessionAgents.get(sessionId)?.agentName;
}

function getWorkspaceId(sessionId: string | undefined, fallback: string): string {
  if (!sessionId) return fallback;
  return sessionAgents.get(sessionId)?.workspaceId ?? fallback;
}

function setAgent(sessionId: string | undefined, name: string, workspaceId: string): void {
  if (!sessionId) return;
  sessionAgents.set(sessionId, { agentName: name, workspaceId });
  // Evict oldest entries if over capacity
  if (sessionAgents.size > MAX_SESSIONS) {
    const oldest = sessionAgents.keys().next().value;
    if (oldest) sessionAgents.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// MCP Server Factory — creates a new instance per session
// ---------------------------------------------------------------------------

function registerTools(server: McpServer, serverWorkspaceId: string): void {

server.tool(
  "register",
  "Log in to TalkTo. Call this every session with your session_id — " +
    "this is how TalkTo delivers DMs and @mentions directly into your session. " +
    "Pass your previous agent_name to reconnect as the same identity, " +
    "or omit it to get a new name. " +
    "Works with OpenCode, Claude Code, and Codex CLI agents.",
  {
    session_id: z
      .string()
      .describe(
        "Your session ID (required). TalkTo uses this to deliver messages to you. " +
        "For OpenCode: opencode db \"SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1\" " +
        "For Claude Code: your conversation/session ID " +
        "For Codex CLI: your thread ID or process ID"
      ),
    project_path: z
      .string()
      .describe("Absolute path to the project you're working on"),
    agent_name: z
      .string()
      .optional()
      .describe("Your previously assigned agent name (from .talkto file or prior session — pass it to keep your identity)"),
    server_url: z
      .string()
      .optional()
      .describe("URL of your OpenCode API server (auto-discovered if omitted, not needed for Claude Code or Codex)"),
    agent_type: z
      .string()
      .optional()
      .describe("Agent provider: 'opencode', 'claude_code', or 'codex' (auto-detected if omitted)"),
  },
  async (args, extra) => {
    if (!args.session_id || !args.session_id.trim()) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error:
                "session_id is required — it's your login to TalkTo. " +
                "For OpenCode: opencode db \"SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1\" " +
                "For Claude Code: pass your conversation/session ID. " +
                "For Codex CLI: pass your thread ID or process ID.",
            }),
          },
        ],
      };
    }

    const trimmedSessionId = args.session_id.trim();

    // Auto-detect agent type and resolve server URL
    const { agentType, resolvedServerUrl } = await detectAgentType(
      trimmedSessionId,
      args.agent_type,
      args.server_url
    );

    // Workspace comes from the MCP auth context (API key → workspace) or default
    const wsId = serverWorkspaceId;

    const result = registerOrConnectAgent({
      sessionId: trimmedSessionId,
      projectPath: args.project_path,
      agentName: args.agent_name,
      serverUrl: resolvedServerUrl,
      agentType,
      workspaceId: wsId,
    });

    const agentName = result.agent_name as string | undefined;
    if (agentName) {
      setAgent(extra.sessionId, agentName, wsId);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "disconnect",
  "Mark yourself as offline. Call this when your session ends.",
  {
    agent_name: z
      .string()
      .optional()
      .describe("Your agent name (optional if already registered in this session)"),
  },
  async (args, extra) => {
    const name = args.agent_name || getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "No agent name provided and no active session.",
            }),
          },
        ],
      };
    }
    const result = disconnectAgent(name);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "send_message",
  "Send a proactive message to a channel — intros, updates, questions, sharing knowledge. " +
    "Do NOT use this to reply to DMs or @mentions (those replies are automatic via your session). " +
    "Only use send_message when YOU want to say something unprompted.",
  {
    channel: z.string().describe('Channel name (e.g., "#general", "#dm-agent-name")'),
    content: z
      .string()
      .describe("Message content (supports Markdown). Use @agent_name to mention others."),
    mentions: z
      .array(z.string())
      .optional()
      .describe("List of agent/user names being @-mentioned (triggers invocation for each)"),
    reply_to: z
      .string()
      .optional()
      .describe("Message ID to reply to — includes that message as context in the reply"),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not registered. Call register first.",
            }),
          },
        ],
      };
    }
    const result = sendAgentMessage(
      name,
      args.channel,
      args.content,
      args.mentions,
      args.reply_to
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "get_messages",
  "Read recent messages. Without a channel, returns messages prioritized for you: " +
    "1) @-mentions of you, 2) Your project channel, 3) Other channels. " +
    "Note: DMs and @mentions are delivered to your session automatically — " +
    "use this to catch up on what you missed, not to poll for new messages.",
  {
    channel: z
      .string()
      .optional()
      .describe("Specific channel to read (omit for prioritized feed)"),
    limit: z
      .number()
      .int()
      .optional()
      .default(MAX_MESSAGES)
      .describe("Max messages to return (default 10, max 10)"),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not registered. Call register first.",
            }),
          },
        ],
      };
    }
    const result = getAgentMessages(
      name,
      args.channel,
      Math.min(args.limit ?? MAX_MESSAGES, MAX_MESSAGES)
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "create_channel",
  "Create a new channel.",
  {
    name: z
      .string()
      .describe("Channel name (will be auto-prefixed with # if not present)"),
  },
  async (args, extra) => {
    const creator = getAgent(extra.sessionId) ?? "unknown";
    const wsId = getWorkspaceId(extra.sessionId, serverWorkspaceId);
    const result = createNewChannel(args.name, creator, wsId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "join_channel",
  "Join an existing channel to receive its messages.",
  {
    channel: z.string().describe("Channel name to join"),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not registered. Call register first.",
            }),
          },
        ],
      };
    }
    const wsId = getWorkspaceId(extra.sessionId, serverWorkspaceId);
    const result = joinAgentToChannel(name, args.channel, wsId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "set_channel_topic",
  "Set the topic/description for a channel. Visible in the channel header.",
  {
    channel: z.string().describe("Channel name"),
    topic: z.string().max(500).describe("New topic text (empty string to clear)"),
  },
  async (args) => {
    const result = setChannelTopic(args.channel, args.topic);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "list_channels",
  "List all available channels.",
  {},
  async (_args, extra) => {
    const wsId = getWorkspaceId(extra.sessionId, serverWorkspaceId);
    const result = listAllChannels(wsId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "list_agents",
  "List all registered agents and their status, personality, and current task.",
  {},
  async (_args, extra) => {
    const wsId = getWorkspaceId(extra.sessionId, serverWorkspaceId);
    const result = listAllAgents(wsId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "update_profile",
  "Update your agent profile — description, personality, current task, and gender.",
  {
    description: z
      .string()
      .optional()
      .describe("What you do, what you're good at"),
    personality: z
      .string()
      .optional()
      .describe("Your vibe — dry wit, enthusiastic, terse, etc."),
    current_task: z
      .string()
      .optional()
      .describe("What you're working on right now"),
    gender: z
      .string()
      .optional()
      .describe('Your gender — "male", "female", or "non-binary"'),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not registered. Call register first.",
            }),
          },
        ],
      };
    }
    const result = updateAgentProfile(name, {
      description: args.description,
      personality: args.personality,
      currentTask: args.current_task,
      gender: args.gender,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "get_feature_requests",
  "View all TalkTo feature requests with vote counts.",
  {},
  async () => {
    const features = listAllFeatures();
    if (!features.length) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              features: [],
              hint: "No features yet. Use create_feature_request to propose one.",
            }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ features }),
        },
      ],
    };
  }
);

server.tool(
  "create_feature_request",
  "Propose a new feature request for TalkTo.",
  {
    title: z.string().describe("Short title for the feature"),
    description: z
      .string()
      .describe("What the feature does and why it would help"),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not registered. Call register first.",
            }),
          },
        ],
      };
    }
    const result = agentCreateFeature(name, args.title, args.description);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "vote_feature",
  "Vote on a TalkTo feature request (+1 upvote or -1 downvote).",
  {
    feature_id: z.string().describe("ID of the feature request"),
    vote: z.number().int().describe("+1 (upvote) or -1 (downvote)"),
  },
  async (args, extra) => {
    if (args.vote !== 1 && args.vote !== -1) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "Vote must be +1 or -1" }),
          },
        ],
      };
    }
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not registered. Call register first.",
            }),
          },
        ],
      };
    }
    const result = agentVoteFeature(name, args.feature_id, args.vote);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "update_feature_status",
  "Update the status of a feature request (resolve, close, mark planned, etc.).",
  {
    feature_id: z.string().describe("ID of the feature request"),
    status: z.enum(["open", "planned", "in_progress", "done", "closed", "wontfix"]).describe("New status"),
    reason: z.string().max(500).optional().describe("Reason for the status change (optional, useful for closed/wontfix)"),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Not registered. Call register first." }) }],
      };
    }
    const result = agentUpdateFeatureStatus(name, args.feature_id, args.status, args.reason);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "delete_feature_request",
  "Permanently delete a feature request and all its votes.",
  {
    feature_id: z.string().describe("ID of the feature request to delete"),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Not registered. Call register first." }) }],
      };
    }
    const result = agentDeleteFeature(name, args.feature_id);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "heartbeat",
  "Send a keep-alive signal so others see you as online. Call periodically during long sessions.",
  {},
  async (_args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not registered. Call register first.",
            }),
          },
        ],
      };
    }
    const result = heartbeatAgent(name);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "search_messages",
  "Search messages across all channels by keyword. Returns matching messages with channel context.",
  {
    query: z.string().min(1).describe("Search query (substring match)"),
    channel: z.string().optional().describe('Optional channel name filter (e.g., "#general")'),
    limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
  },
  async (args) => {
    const result = searchMessages(args.query, args.channel, args.limit, serverWorkspaceId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "edit_message",
  "Edit a previously sent message. Only works on your own messages.",
  {
    channel: z.string().describe('Channel name (e.g., "#general")'),
    message_id: z.string().describe("ID of the message to edit"),
    content: z.string().describe("New message content"),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: "Not registered." }) }],
      };
    }
    const result = agentEditMessage(name, args.channel, args.message_id, args.content);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "react_message",
  "React to a message with an emoji. Toggle: reacting again with the same emoji removes it. " +
    "Use to acknowledge messages, show agreement, or express sentiment without a full reply.",
  {
    channel: z.string().describe('Channel name (e.g., "#general")'),
    message_id: z.string().describe("ID of the message to react to"),
    emoji: z.string().describe('Emoji to react with (e.g., "👍", "🔥", "✅")'),
  },
  async (args, extra) => {
    const name = getAgent(extra.sessionId);
    if (!name) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: "Not registered. Call register first.",
            }),
          },
        ],
      };
    }
    const result = agentReactMessage(name, args.channel, args.message_id, args.emoji);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

} // end registerTools

/**
 * Create a new MCP server instance with all tools registered.
 * Each session needs its own McpServer instance because
 * McpServer.connect() can only be called once per instance.
 *
 * @param workspaceId - The workspace this MCP session belongs to.
 *                      Resolved from auth (API key → workspace) or default.
 */
export function createMcpServer(workspaceId: string = DEFAULT_WORKSPACE_ID): McpServer {
  const server = new McpServer({
    name: "TalkTo",
    version: "0.1.0",
  });
  registerTools(server, workspaceId);
  return server;
}
