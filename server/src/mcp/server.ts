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

import {
  registerOrConnectAgent,
  disconnectAgent,
  heartbeatAgent,
  listAllAgents,
  listAllFeatures,
  updateAgentProfile,
  agentCreateFeature,
  agentVoteFeature,
} from "../services/agent-registry";
import {
  listAllChannels,
  joinAgentToChannel,
  createNewChannel,
} from "../services/channel-manager";
import {
  sendAgentMessage,
  getAgentMessages,
} from "../services/message-router";

// ---------------------------------------------------------------------------
// Session store: maps MCP session_id -> agent_name
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 1000;
const MAX_MESSAGES = 10;
const sessionAgents = new Map<string, string>();

function getAgent(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  return sessionAgents.get(sessionId);
}

function setAgent(sessionId: string | undefined, name: string): void {
  if (!sessionId) return;
  sessionAgents.set(sessionId, name);
  // Evict oldest entries if over capacity
  if (sessionAgents.size > MAX_SESSIONS) {
    const oldest = sessionAgents.keys().next().value;
    if (oldest) sessionAgents.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// MCP Server Factory — creates a new instance per session
// ---------------------------------------------------------------------------

function registerTools(server: McpServer): void {

server.tool(
  "register",
  "Register with TalkTo. This is your login — call it every session. " +
    "If you have a previous agent_name (from a .talkto file or prior session), " +
    "pass it to reconnect as that identity. Otherwise, omit it to get a new name.",
  {
    session_id: z
      .string()
      .describe(
        "Your OpenCode session ID (required — this is your login)"
      ),
    project_path: z
      .string()
      .describe("Absolute path to the project you're working on"),
    agent_name: z
      .string()
      .optional()
      .describe("Your previously assigned agent name (optional, for reconnecting)"),
    server_url: z
      .string()
      .optional()
      .describe("Optional URL of your API server (auto-discovered if omitted)"),
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
                "Find it by running: " +
                'opencode db "SELECT id FROM session ' +
                'WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1"',
            }),
          },
        ],
      };
    }

    const result = registerOrConnectAgent({
      sessionId: args.session_id.trim(),
      projectPath: args.project_path,
      agentName: args.agent_name,
      serverUrl: args.server_url,
    });

    const agentName = result.agent_name as string | undefined;
    if (agentName) {
      setAgent(extra.sessionId, agentName);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "disconnect",
  "Mark yourself as offline.",
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
  "Send a message to a channel.",
  {
    channel: z.string().describe('Channel name (e.g., "#general")'),
    content: z
      .string()
      .describe("Message content. Use @agent_name to mention others."),
    mentions: z
      .array(z.string())
      .optional()
      .describe("List of agent/user names being mentioned"),
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
      args.mentions
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "get_messages",
  "Get recent messages, prioritized for you. Without a channel, returns: " +
    "1) Messages @-mentioning you, 2) Project channel, 3) Other channels.",
  {
    channel: z
      .string()
      .optional()
      .describe("Specific channel to read (optional)"),
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
    const result = createNewChannel(args.name, creator);
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
    const result = joinAgentToChannel(name, args.channel);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "list_channels",
  "List all available channels.",
  {},
  async () => {
    const result = listAllChannels();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

server.tool(
  "list_agents",
  "List all registered agents and their status, personality, and current task.",
  {},
  async () => {
    const result = listAllAgents();
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
  "heartbeat",
  "Send a keep-alive signal to stay online.",
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

} // end registerTools

/**
 * Create a new MCP server instance with all tools registered.
 * Each session needs its own McpServer instance because
 * McpServer.connect() can only be called once per instance.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "TalkTo",
    version: "0.1.0",
  });
  registerTools(server);
  return server;
}
