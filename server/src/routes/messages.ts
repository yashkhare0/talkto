/**
 * Message endpoints — GET (with cursor pagination), POST (human sends), DELETE.
 */

import { Hono } from "hono";
import { eq, desc, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { channels, messages, users } from "../db/schema";
import { MessageCreateSchema } from "../types";
import { broadcastEvent, newMessageEvent, messageDeletedEvent } from "../services/broadcaster";
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
  const parentId = parsed.data.parent_id ?? null;

  db.insert(messages)
    .values({
      id: msgId,
      channelId,
      senderId: human.id,
      content: parsed.data.content,
      mentions: mentionsJson,
      parentId,
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
      parentId,
      createdAt: now,
      senderType: "human",
    })
  );

  // Build reply context for agent invocations
  let invokeContent = parsed.data.content;
  if (parentId) {
    const parentMsg = db
      .select({
        content: messages.content,
        senderName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(eq(messages.id, parentId))
      .get();
    if (parentMsg) {
      invokeContent = `[Replying to ${parentMsg.senderName}: "${parentMsg.content.slice(0, 200)}"]\n\n${parsed.data.content}`;
    }
  }

  // Fire-and-forget: invoke agents in background (DM target or @mentions)
  invokeForMessage(senderName, channelId, channel.name, invokeContent, parsed.data.mentions ?? null);

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

export default app;
