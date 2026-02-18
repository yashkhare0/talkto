/**
 * TalkTo server — Bun + Hono main entry point.
 *
 * Serves: REST API, WebSocket, MCP (placeholder), and SPA static files.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { config } from "./lib/config";
import { getDb, closeDb } from "./db";
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
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    console.error("[MCP] Request handling error:", err);
    return c.json({ error: "MCP request failed" }, 500);
  }
});

// SPA fallback — serve frontend/dist in production
app.get(
  "/assets/*",
  serveStatic({ root: "../frontend/dist" })
);
app.get("*", serveStatic({ path: "../frontend/dist/index.html" }));

// ---------------------------------------------------------------------------
// Start liveness background task
// ---------------------------------------------------------------------------

startLivenessTask();

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

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[SERVER] Shutting down...");
  stopLivenessTask();
  closeDb();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopLivenessTask();
  closeDb();
  server.stop();
  process.exit(0);
});

export { app, server };
