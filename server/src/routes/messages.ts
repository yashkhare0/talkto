/**
 * Message endpoints — GET (with cursor pagination), POST (human sends), DELETE.
 */

import { Hono } from "hono";
import { eq, desc, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { channels, messages, users, messageReactions } from "../db/schema";
import { MessageCreateSchema, ReactionToggleSchema } from "../types";
import { broadcastEvent, newMessageEvent, messageDeletedEvent, reactionEvent } from "../services/broadcaster";
import { invokeForMessage } from "../services/agent-invoker";
import type { MessageResponse } from "../types";
import { and } from "drizzle-orm";

const app = new Hono();

// GET /channels/:channelId/messages
app.get("/", (c) => {
  const channelId = c.req.param("channelId");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 100);
  const before = c.req.query("before");
  const db = getDb();

  // Verify channel exists
  const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }

  // Build query with coalesce for sender_name
  let query = db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      senderId: messages.senderId,
      senderName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
      senderType: users.type,
      content: messages.content,
      mentions: messages.mentions,
      parentId: messages.parentId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(eq(messages.channelId, channelId))
    .$dynamic();

  // Cursor pagination
  if (before) {
    const beforeMsg = db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, before))
      .get();
    if (beforeMsg) {
      query = query.where(lt(messages.createdAt, beforeMsg.createdAt));
    }
  }

  const rows = query
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();

  // Fetch reactions for all messages in one query
  const messageIds = rows.map((r) => r.id);
  const allReactions = messageIds.length > 0
    ? db
        .select({
          messageId: messageReactions.messageId,
          emoji: messageReactions.emoji,
          userName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
        })
        .from(messageReactions)
        .innerJoin(users, eq(messageReactions.userId, users.id))
        .where(sql`${messageReactions.messageId} IN (${sql.join(messageIds.map(id => sql`${id}`), sql`, `)})`)
        .all()
    : [];

  // Group reactions by message ID
  const reactionsByMessage = new Map<string, Map<string, string[]>>();
  for (const r of allReactions) {
    if (!reactionsByMessage.has(r.messageId)) {
      reactionsByMessage.set(r.messageId, new Map());
    }
    const emojiMap = reactionsByMessage.get(r.messageId)!;
    const userList = emojiMap.get(r.emoji) ?? [];
    userList.push(r.userName);
    emojiMap.set(r.emoji, userList);
  }

  const result = rows.map((row) => {
    const emojiMap = reactionsByMessage.get(row.id);
    const reactions = emojiMap
      ? Array.from(emojiMap.entries()).map(([emoji, userNames]) => ({
          emoji,
          users: userNames,
          count: userNames.length,
        }))
      : [];

    return {
      id: row.id,
      channel_id: row.channelId,
      sender_id: row.senderId,
      sender_name: row.senderName,
      sender_type: row.senderType,
      content: row.content,
      mentions: row.mentions ? JSON.parse(row.mentions) : null,
      parent_id: row.parentId,
      reactions,
      created_at: row.createdAt,
    };
  });

  return c.json(result);
});

// POST /channels/:channelId/messages
app.post("/", async (c) => {
  const channelId = c.req.param("channelId");
  const body = await c.req.json();
  const parsed = MessageCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }
  const db = getDb();

  // Verify channel
  const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }

  // Get human user as sender
  const human = db.select().from(users).where(eq(users.type, "human")).get();
  if (!human) {
    return c.json({ detail: "No user onboarded" }, 400);
  }

  const msgId = crypto.randomUUID();
  const now = new Date().toISOString();
  const mentionsJson = parsed.data.mentions
    ? JSON.stringify(parsed.data.mentions)
    : null;

  db.insert(messages)
    .values({
      id: msgId,
      channelId,
      senderId: human.id,
      content: parsed.data.content,
      mentions: mentionsJson,
      createdAt: now,
    })
    .run();

  const senderName = human.displayName ?? human.name;

  // Broadcast to WebSocket clients
  broadcastEvent(
    newMessageEvent({
      messageId: msgId,
      channelId,
      senderId: human.id,
      senderName,
      content: parsed.data.content,
      mentions: parsed.data.mentions,
      createdAt: now,
      senderType: "human",
    })
  );

  // Fire-and-forget: invoke agents in background (DM target or @mentions)
  invokeForMessage(senderName, channelId, channel.name, parsed.data.content, parsed.data.mentions ?? null);

  const response: MessageResponse = {
    id: msgId,
    channel_id: channelId,
    sender_id: human.id,
    sender_name: senderName,
    sender_type: "human",
    content: parsed.data.content,
    mentions: parsed.data.mentions ?? null,
    parent_id: null,
    created_at: now,
  };

  return c.json(response, 201);
});

// DELETE /channels/:channelId/messages/:messageId
app.delete("/:messageId", (c) => {
  const channelId = c.req.param("channelId");
  const messageId = c.req.param("messageId");
  const db = getDb();

  // Verify channel exists
  const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }

  // Verify message exists and belongs to this channel
  const msg = db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .get();
  if (!msg) {
    return c.json({ detail: "Message not found" }, 404);
  }
  if (msg.channelId !== channelId) {
    return c.json({ detail: "Message does not belong to this channel" }, 400);
  }

  // Delete the message
  db.delete(messages).where(eq(messages.id, messageId)).run();

  // Broadcast deletion to all WebSocket clients
  broadcastEvent(messageDeletedEvent({ messageId, channelId }));

  return c.json({ deleted: true, id: messageId });
});

// POST /channels/:channelId/messages/:messageId/react — toggle reaction
app.post("/:messageId/react", async (c) => {
  const channelId = c.req.param("channelId");
  const messageId = c.req.param("messageId");
  const body = await c.req.json();
  const parsed = ReactionToggleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }
  const db = getDb();

  // Verify message exists and belongs to channel
  const msg = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!msg) return c.json({ detail: "Message not found" }, 404);
  if (msg.channelId !== channelId) return c.json({ detail: "Message does not belong to this channel" }, 400);

  // Get human user
  const human = db.select().from(users).where(eq(users.type, "human")).get();
  if (!human) return c.json({ detail: "No user onboarded" }, 400);

  const userName = human.displayName ?? human.name;
  const emoji = parsed.data.emoji;

  // Check if reaction already exists — toggle
  const existing = db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, human.id),
        eq(messageReactions.emoji, emoji),
      )
    )
    .get();

  if (existing) {
    // Remove reaction
    db.delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, human.id),
          eq(messageReactions.emoji, emoji),
        )
      )
      .run();

    broadcastEvent(reactionEvent({ messageId, channelId, emoji, userName, action: "remove" }));
    return c.json({ action: "removed", emoji });
  } else {
    // Add reaction
    const now = new Date().toISOString();
    db.insert(messageReactions)
      .values({ messageId, userId: human.id, emoji, createdAt: now })
      .run();

    broadcastEvent(reactionEvent({ messageId, channelId, emoji, userName, action: "add" }));
    return c.json({ action: "added", emoji });
  }
});

// GET /channels/:channelId/messages/:messageId/reactions — get reactions for a message
app.get("/:messageId/reactions", (c) => {
  const messageId = c.req.param("messageId");
  const db = getDb();

  const rows = db
    .select({
      emoji: messageReactions.emoji,
      userName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
    })
    .from(messageReactions)
    .innerJoin(users, eq(messageReactions.userId, users.id))
    .where(eq(messageReactions.messageId, messageId))
    .all();

  // Group by emoji
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.emoji) ?? [];
    list.push(row.userName);
    grouped.set(row.emoji, list);
  }

  const result = Array.from(grouped.entries()).map(([emoji, userNames]) => ({
    message_id: messageId,
    emoji,
    users: userNames,
    count: userNames.length,
  }));

  return c.json(result);
});

export default app;
