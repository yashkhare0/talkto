/**
 * TalkTo server — Bun + Hono main entry point.
 *
 * Serves: REST API, WebSocket, MCP (placeholder), and SPA static files.
 */

import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { config, BASE_DIR } from "./lib/config";
import { getDb, closeDb } from "./db";
import { agents, messages, channels, users } from "./db/schema";
import { eq, like, desc, sql } from "drizzle-orm";
import { seedDefaults } from "./db/seed";
import {
  acceptClient,
  disconnectClient,
  subscribe,
  unsubscribe,
  type WsData,
} from "./services/ws-manager";
import { startLivenessTask, stopLivenessTask } from "./routes/agents";
import { createMcpServer } from "./mcp/server";

// Route modules
import usersRoutes from "./routes/users";
import channelsRoutes from "./routes/channels";
import messagesRoutes from "./routes/messages";
import agentsRoutes from "./routes/agents";
import featuresRoutes from "./routes/features";

// ---------------------------------------------------------------------------
// Initialize database
// ---------------------------------------------------------------------------

const db = getDb();
seedDefaults(db);
console.log(`[DB] Database initialized at ${config.dbPath}`);

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// Middleware
app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: config.network ? "*" : [`http://localhost:${config.frontendPort}`],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

// Mount API routes
app.route("/api/users", usersRoutes);
app.route("/api/channels", channelsRoutes);
app.route("/api/agents", agentsRoutes);
app.route("/api/features", featuresRoutes);

// Messages are nested under channels: /api/channels/:channelId/messages
app.route("/api/channels/:channelId/messages", messagesRoutes);

// Health check
app.get("/api/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

// Search messages across all channels
app.get("/api/search", (c) => {
  const query = c.req.query("q");
  if (!query || query.trim().length === 0) {
    return c.json({ detail: "Query parameter 'q' is required" }, 400);
  }
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 50);
  const channelFilter = c.req.query("channel"); // optional channel name filter

  const db = getDb();

  let baseQuery = db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      channelName: channels.name,
      senderId: messages.senderId,
      senderName: sql`coalesce(${users.displayName}, ${users.name})`,
      senderType: users.type,
      content: messages.content,
      mentions: messages.mentions,
      parentId: messages.parentId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .where(like(messages.content, `%${query}%`))
    .$dynamic();

  if (channelFilter) {
    baseQuery = baseQuery.where(eq(channels.name, channelFilter));
  }

  const rows = baseQuery
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();

  const results = rows.map((row: Record<string, unknown>) => ({
    id: row.id,
    channel_id: row.channelId,
    channel_name: row.channelName,
    sender_id: row.senderId,
    sender_name: row.senderName,
    sender_type: row.senderType,
    content: row.content,
    mentions: row.mentions ? JSON.parse(row.mentions as string) : null,
    parent_id: row.parentId,
    created_at: row.createdAt,
  }));

  return c.json({ query, results, count: results.length });
});

// ---------------------------------------------------------------------------
// MCP Server — streamable HTTP transport at /mcp
// ---------------------------------------------------------------------------

// Track transports by session ID for multi-client support
const mcpTransports = new Map<string, WebStandardStreamableHTTPServerTransport>();

app.all("/mcp", async (c) => {
  const sessionId = c.req.header("mcp-session-id");

  // Existing session — route to its transport
  if (sessionId && mcpTransports.has(sessionId)) {
    try {
      return await mcpTransports.get(sessionId)!.handleRequest(c.req.raw);
    } catch (err) {
      console.error("[MCP] Request handling error:", err);
      return c.json({ error: "MCP request failed" }, 500);
    }
  }

  // Stale session ID — client is sending a session ID from before a server
  // restart. The MCP SDK transport will reject this with 404 "Session not found"
  // if we pass the raw request through, because the new transport's session ID
  // won't match. Strip the stale header so the SDK treats it as a fresh init.
  let request = c.req.raw;
  if (sessionId) {
    console.log(
      `[MCP] Stale session ID detected: ${sessionId} — stripping header for fresh init`
    );
    const headers = new Headers(request.headers);
    headers.delete("mcp-session-id");
    request = new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error — Bun supports duplex on Request
      duplex: "half",
    });
  }

  // New session — create transport + new MCP server instance, connect, handle
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      mcpTransports.set(sid, transport);
      console.log(`[MCP] Session initialized: ${sid}`);
    },
    onsessionclosed: (sid) => {
      mcpTransports.delete(sid);
      console.log(`[MCP] Session closed: ${sid}`);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      mcpTransports.delete(transport.sessionId);
    }
  };

  // Each session gets its own McpServer instance (connect() can only be called once per instance)
  const server = createMcpServer();
  await server.connect(transport);

  try {
    return await transport.handleRequest(request);
  } catch (err) {
    console.error("[MCP] Request handling error:", err);
    return c.json({ error: "MCP request failed" }, 500);
  }
});

// SPA fallback — serve frontend/dist in production
// Use resolve() for absolute paths to avoid cross-platform relative path issues
const frontendDist = resolve(BASE_DIR, "frontend", "dist");
app.get(
  "/assets/*",
  serveStatic({ root: frontendDist })
);
app.get("*", serveStatic({ path: resolve(frontendDist, "index.html") }));

// ---------------------------------------------------------------------------
// Start liveness background task
// ---------------------------------------------------------------------------

startLivenessTask();

// ---------------------------------------------------------------------------
// Reconnect OpenCode MCP clients after server restart
// ---------------------------------------------------------------------------
// When TalkTo restarts, OpenCode's MCP clients lose their connection and
// never retry. We trigger a disconnect/connect cycle on each OpenCode server
// so agents get fresh MCP sessions with working tools.
//
// Note: This only applies to OpenCode agents. Claude Code agents use a
// subprocess model and reconnect automatically via the MCP register tool.

async function reconnectOpenCodeMcpClients() {
  const serverUrls = new Set<string>();
  const allAgents = db
    .select({ serverUrl: agents.serverUrl })
    .from(agents)
    .all();
  for (const a of allAgents) {
    if (a.serverUrl) serverUrls.add(a.serverUrl);
  }

  if (serverUrls.size === 0) {
    console.log("[MCP-RECONNECT] No OpenCode servers found in agent registry");
    return;
  }

  for (const url of serverUrls) {
    try {
      // Disconnect the stale MCP connection
      const disconnectRes = await fetch(`${url}/mcp/talkto/disconnect`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      });
      if (!disconnectRes.ok) {
        console.log(
          `[MCP-RECONNECT] Disconnect failed for ${url}: ${disconnectRes.status}`
        );
        continue;
      }

      // Brief pause to let the disconnect settle
      await new Promise((r) => setTimeout(r, 500));

      // Reconnect with a fresh MCP session
      const connectRes = await fetch(`${url}/mcp/talkto/connect`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
      });
      if (connectRes.ok) {
        console.log(
          `[MCP-RECONNECT] Reconnected MCP on OpenCode server ${url}`
        );
      } else {
        console.log(
          `[MCP-RECONNECT] Connect failed for ${url}: ${connectRes.status}`
        );
      }
    } catch (err) {
      console.log(
        `[MCP-RECONNECT] Failed to reach OpenCode server ${url}: ${err}`
      );
    }
  }
}

// Run after a short delay so the HTTP server is fully ready to accept MCP connections
setTimeout(reconnectOpenCodeMcpClients, 2000);

// ---------------------------------------------------------------------------
// Bun server with WebSocket support
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade at /ws
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { id: 0 } satisfies WsData,
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // All other requests go through Hono
    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: {
    open(ws) {
      acceptClient(ws);
    },
    message(ws, message) {
      try {
        const msg = JSON.parse(String(message));
        const action = msg.action as string;

        if (action === "subscribe") {
          const channelIds = msg.channel_ids as string[];
          if (Array.isArray(channelIds)) {
            subscribe(ws, channelIds);
            ws.send(
              JSON.stringify({
                type: "subscribed",
                data: { channel_ids: channelIds },
              })
            );
          }
        } else if (action === "unsubscribe") {
          const channelIds = msg.channel_ids as string[];
          if (Array.isArray(channelIds)) {
            unsubscribe(ws, channelIds);
            ws.send(
              JSON.stringify({
                type: "unsubscribed",
                data: { channel_ids: channelIds },
              })
            );
          }
        } else if (action === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              data: { message: `Unknown action: ${action}` },
            })
          );
        }
      } catch {
        ws.send(
          JSON.stringify({
            type: "error",
            data: { message: "Invalid JSON" },
          })
        );
      }
    },
    close(ws) {
      disconnectClient(ws);
    },
  },
});

console.log(
  `[SERVER] TalkTo running on http://${config.advertiseHost}:${config.port}`
);
console.log(`[SERVER] WebSocket at ws://${config.advertiseHost}:${config.port}/ws`);
console.log(`[SERVER] MCP at ${config.mcpUrl} (placeholder)`);

// Graceful shutdown — shared cleanup logic
function gracefulShutdown(signal: string) {
  console.log(`\n[SERVER] Shutting down (${signal})...`);
  stopLivenessTask();
  closeDb();
  server.stop();
  process.exit(0);
}

// SIGINT: Ctrl+C — works on all platforms (Node emulates on Windows)
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// SIGTERM: process manager / Docker stop — Unix only, harmless no-op on Windows
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// SIGHUP: terminal close — partially supported on Windows
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

// 'beforeExit' fires when the event loop drains — useful as a fallback
// for cleanup when signals aren't delivered (e.g. Windows process termination).
// Note: do NOT call process.exit() here — it would re-trigger beforeExit in a loop.
process.on("beforeExit", () => {
  stopLivenessTask();
  closeDb();
  server.stop();
});

export { app, server };
