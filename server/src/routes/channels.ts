/**
 * Channel CRUD endpoints.
 */

import { Hono } from "hono";
import { eq, asc, and, gt, sql } from "drizzle-orm";
import { getDb } from "../db";
<<<<<<< HEAD
import { channels, channelMembers, users, agents } from "../db/schema";
=======
import { channels, messages, readReceipts, users } from "../db/schema";
>>>>>>> 724d529 (feat: unread message tracking with read receipts)
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

// GET /channels/unread/counts — get unread counts for all channels for a user
// NOTE: Must be before /:channelId to avoid route conflict
app.get("/unread/counts", (c) => {
  const db = getDb();
  const userId = c.req.query("user_id");

  // Default to human user if no user_id provided
  let resolvedUserId = userId;
  if (!resolvedUserId) {
    const human = db.select().from(users).where(eq(users.type, "human")).get();
    if (!human) return c.json({ detail: "No user found" }, 400);
    resolvedUserId = human.id;
  }

  // Get all channels
  const allChannels = db.select().from(channels).all();

  // Get all read receipts for this user
  const receipts = db
    .select()
    .from(readReceipts)
    .where(eq(readReceipts.userId, resolvedUserId))
    .all();
  const receiptMap = new Map(receipts.map((r) => [r.channelId, r.lastReadAt]));

  const results = allChannels.map((ch) => {
    const lastReadAt = receiptMap.get(ch.id);

    // Count messages after last_read_at (or all messages if never read)
    let unreadCount: number;
    if (lastReadAt) {
      const row = db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(and(eq(messages.channelId, ch.id), gt(messages.createdAt, lastReadAt)))
        .get();
      unreadCount = row?.count ?? 0;
    } else {
      const row = db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.channelId, ch.id))
        .get();
      unreadCount = row?.count ?? 0;
    }

    return {
      channel_id: ch.id,
      channel_name: ch.name,
      unread_count: unreadCount,
      last_read_at: lastReadAt ?? null,
    };
  });

  return c.json(results);
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

// POST /channels/:channelId/read — mark channel as read for a user
app.post("/:channelId/read", async (c) => {
  const channelId = c.req.param("channelId");
  const db = getDb();

  const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }

  // Get user_id from body or default to human user
  let userId: string;
  try {
    const body = await c.req.json();
    userId = body.user_id;
  } catch {
    userId = "";
  }

  if (!userId) {
    const human = db.select().from(users).where(eq(users.type, "human")).get();
    if (!human) return c.json({ detail: "No user found" }, 400);
    userId = human.id;
  }

  const now = new Date().toISOString();

  // Upsert read receipt
  const existing = db
    .select()
    .from(readReceipts)
    .where(and(eq(readReceipts.userId, userId), eq(readReceipts.channelId, channelId)))
    .get();

  if (existing) {
    db.update(readReceipts)
      .set({ lastReadAt: now })
      .where(and(eq(readReceipts.userId, userId), eq(readReceipts.channelId, channelId)))
      .run();
  } else {
    db.insert(readReceipts)
      .values({ userId, channelId, lastReadAt: now })
      .run();
  }

  return c.json({ channel_id: channelId, user_id: userId, last_read_at: now });
});

export default app;
