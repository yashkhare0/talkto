/**
 * Message endpoints — GET (with cursor pagination), POST (human sends), DELETE.
 */

import { Hono } from "hono";
import { eq, desc, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { channels, messages, users } from "../db/schema";
import { MessageCreateSchema, MessageEditSchema } from "../types";
import { broadcastEvent, newMessageEvent, messageDeletedEvent, messageEditedEvent } from "../services/broadcaster";
import { invokeForMessage } from "../services/agent-invoker";
import type { MessageResponse } from "../types";

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
      isPinned: messages.isPinned,
      pinnedAt: messages.pinnedAt,
      pinnedBy: messages.pinnedBy,
      editedAt: messages.editedAt,
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

  const result: MessageResponse[] = rows.map((row) => ({
    id: row.id,
    channel_id: row.channelId,
    sender_id: row.senderId,
    sender_name: row.senderName,
    sender_type: row.senderType,
    content: row.content,
    mentions: row.mentions ? JSON.parse(row.mentions) : null,
    parent_id: row.parentId,
    is_pinned: Boolean(row.isPinned),
    pinned_at: row.pinnedAt,
    pinned_by: row.pinnedBy,
    edited_at: row.editedAt,
    created_at: row.createdAt,
  }));

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
    is_pinned: false,
    created_at: now,
  };

  return c.json(response, 201);
});

// POST /channels/:channelId/messages/:messageId/pin — toggle pin
app.post("/:messageId/pin", (c) => {
  const channelId = c.req.param("channelId");
  const messageId = c.req.param("messageId");
  const db = getDb();

  const msg = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!msg) return c.json({ detail: "Message not found" }, 404);
  if (msg.channelId !== channelId) return c.json({ detail: "Message does not belong to this channel" }, 400);

  const now = new Date().toISOString();
  const newPinned = msg.isPinned ? 0 : 1;

  db.update(messages)
    .set({
      isPinned: newPinned,
      pinnedAt: newPinned ? now : null,
      pinnedBy: newPinned ? "human" : null,
    })
    .where(eq(messages.id, messageId))
    .run();

  return c.json({
    id: messageId,
    is_pinned: Boolean(newPinned),
    pinned_at: newPinned ? now : null,
  });
});

// GET /channels/:channelId/messages/pinned — get pinned messages
app.get("/pinned", (c) => {
  const channelId = c.req.param("channelId");
  const db = getDb();

  const channel = db.select().from(channels).where(eq(channels.id, channelId)).get();
  if (!channel) return c.json({ detail: "Channel not found" }, 404);

  const rows = db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      senderId: messages.senderId,
      senderName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
      senderType: users.type,
      content: messages.content,
      mentions: messages.mentions,
      parentId: messages.parentId,
      isPinned: messages.isPinned,
      pinnedAt: messages.pinnedAt,
      pinnedBy: messages.pinnedBy,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .where(eq(messages.channelId, channelId))
    .where(eq(messages.isPinned, 1))
    .orderBy(desc(messages.pinnedAt))
    .all();

  return c.json(rows.map((row) => ({
    id: row.id,
    channel_id: row.channelId,
    sender_id: row.senderId,
    sender_name: row.senderName,
    sender_type: row.senderType,
    content: row.content,
    mentions: row.mentions ? JSON.parse(row.mentions) : null,
    parent_id: row.parentId,
    is_pinned: true,
    pinned_at: row.pinnedAt,
    pinned_by: row.pinnedBy,
    created_at: row.createdAt,
  })));
});

// PATCH /channels/:channelId/messages/:messageId — edit message content
app.patch("/:messageId", async (c) => {
  const channelId = c.req.param("channelId");
  const messageId = c.req.param("messageId");
  const body = await c.req.json();
  const parsed = MessageEditSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }
  const db = getDb();

  const msg = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!msg) return c.json({ detail: "Message not found" }, 404);
  if (msg.channelId !== channelId) return c.json({ detail: "Message does not belong to this channel" }, 400);

  const editedAt = new Date().toISOString();
  db.update(messages)
    .set({ content: parsed.data.content, editedAt })
    .where(eq(messages.id, messageId))
    .run();

  broadcastEvent(messageEditedEvent({ messageId, channelId, content: parsed.data.content, editedAt }));

  return c.json({ id: messageId, content: parsed.data.content, edited_at: editedAt });
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

export default app;
