/**
 * Channel CRUD endpoints.
 */

import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import { getDb } from "../db";
import { channels, channelMembers, users, agents } from "../db/schema";
import { ChannelCreateSchema } from "../types";
import type { ChannelResponse } from "../types";

const app = new Hono();

function channelToResponse(ch: typeof channels.$inferSelect): ChannelResponse {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    project_path: ch.projectPath,
    created_by: ch.createdBy,
    created_at: ch.createdAt,
    is_archived: ch.isArchived === 1,
    archived_at: ch.archivedAt,
  };
}

// GET /channels
app.get("/", (c) => {
  const db = getDb();
  const includeArchived = c.req.query("include_archived") === "true";
  let result = db.select().from(channels).orderBy(asc(channels.name)).all();
  if (!includeArchived) {
    result = result.filter((ch) => ch.isArchived !== 1);
  }
  return c.json(result.map(channelToResponse));
});

// POST /channels
app.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = ChannelCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }

  const name = parsed.data.name.startsWith("#")
    ? parsed.data.name
    : `#${parsed.data.name}`;
  const db = getDb();

  // Check uniqueness
  const existing = db.select().from(channels).where(eq(channels.name, name)).get();
  if (existing) {
    return c.json({ detail: `Channel ${name} already exists` }, 409);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(channels)
    .values({
      id,
      name,
      type: "custom",
      createdBy: "human",
      createdAt: now,
    })
    .run();

  const channel = db.select().from(channels).where(eq(channels.id, id)).get()!;
  return c.json(channelToResponse(channel), 201);
});

// GET /channels/:channelId
app.get("/:channelId", (c) => {
  const db = getDb();
  const channel = db
    .select()
    .from(channels)
    .where(eq(channels.id, c.req.param("channelId")))
    .get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }
  return c.json(channelToResponse(channel));
});

// GET /channels/:channelId/members — list all members in a channel
app.get("/:channelId/members", (c) => {
  const channelId = c.req.param("channelId");
  const db = getDb();

  // Verify channel exists
  const channel = db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }

  // Fetch members with user info and optional agent info
  const members = db
    .select({
      userId: channelMembers.userId,
      joinedAt: channelMembers.joinedAt,
      name: users.name,
      displayName: users.displayName,
      type: users.type,
      agentName: agents.agentName,
      agentType: agents.agentType,
      status: agents.status,
    })
    .from(channelMembers)
    .innerJoin(users, eq(channelMembers.userId, users.id))
    .leftJoin(agents, eq(channelMembers.userId, agents.id))
    .where(eq(channelMembers.channelId, channelId))
    .all();

  const result = members.map((m) => ({
    user_id: m.userId,
    name: m.displayName ?? m.name,
    type: m.type,
    joined_at: m.joinedAt,
    agent_name: m.agentName ?? null,
    agent_type: m.agentType ?? null,
    status: m.status ?? null,
  }));

  return c.json(result);
});

// POST /channels/:channelId/archive — archive a channel
app.post("/:channelId/archive", (c) => {
  const channelId = c.req.param("channelId");
  const db = getDb();

  const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }
  if (channel.isArchived === 1) {
    return c.json({ detail: "Channel is already archived" }, 400);
  }
  if (channel.type === "general") {
    return c.json({ detail: "Cannot archive the #general channel" }, 400);
  }

  const now = new Date().toISOString();
  db.update(channels)
    .set({ isArchived: 1, archivedAt: now })
    .where(eq(channels.id, channelId))
    .run();

  const updated = db.select().from(channels).where(eq(channels.id, channelId)).get()!;
  return c.json(channelToResponse(updated));
});

// POST /channels/:channelId/unarchive — unarchive a channel
app.post("/:channelId/unarchive", (c) => {
  const channelId = c.req.param("channelId");
  const db = getDb();

  const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }
  if (channel.isArchived !== 1) {
    return c.json({ detail: "Channel is not archived" }, 400);
  }

  db.update(channels)
    .set({ isArchived: 0, archivedAt: null })
    .where(eq(channels.id, channelId))
    .run();

  const updated = db.select().from(channels).where(eq(channels.id, channelId)).get()!;
  return c.json(channelToResponse(updated));
});

export default app;
