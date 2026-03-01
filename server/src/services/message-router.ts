/**
 * Message routing — send/get messages for agents with priority-based retrieval.
 */

import { eq, desc, sql, and, inArray, like } from "drizzle-orm";
import { getDb } from "../db";
import {
  agents,
  channels,
  channelMembers,
  messages,
  users,
} from "../db/schema";
import { broadcastEvent, newMessageEvent, messageEditedEvent } from "./broadcaster";
import { invokeForMessage } from "./agent-invoker";

/**
 * Send a message from an agent to a channel.
 * Persists, broadcasts, and returns the message ID.
 */
export function sendAgentMessage(
  agentName: string,
  channelName: string,
  content: string,
  mentions?: string[] | null,
  replyTo?: string
): Record<string, unknown> {
  const db = getDb();

  // Get agent
  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  // Get channel
  const channel = db
    .select()
    .from(channels)
    .where(eq(channels.name, channelName))
    .get();
  if (!channel) return { error: `Channel '${channelName}' not found.` };

  const msgId = crypto.randomUUID();
  const now = new Date().toISOString();
  const mentionsJson = mentions ? JSON.stringify(mentions) : null;

  db.insert(messages)
    .values({
      id: msgId,
      channelId: channel.id,
      senderId: agent.id,
      content,
      mentions: mentionsJson,
      parentId: replyTo ?? null,
      createdAt: now,
    })
    .run();

  // Broadcast to WebSocket clients
  broadcastEvent(
    newMessageEvent({
      messageId: msgId,
      channelId: channel.id,
      senderId: agent.id,
      senderName: agentName,
      content,
      mentions,
      parentId: replyTo ?? null,
      createdAt: now,
      senderType: "agent",
    })
  );

  // Fire-and-forget: invoke agents mentioned in this message (agent-to-agent @mentions)
  invokeForMessage(agentName, channel.id, channelName, content, mentions ?? null);

  return { message_id: msgId, channel: channelName };
}

interface MessageItem {
  id: string;
  channel: string;
  sender: string;
  content: string;
  mentions: string[];
  created_at: string;
  priority?: string;
}

/**
 * Get messages for an agent, with priority-based retrieval.
 *
 * Priority order: @mentions > project channel > other member channels.
 */
export function getAgentMessages(
  agentName: string,
  channelName?: string | null,
  limit: number = 10
): Record<string, unknown> {
  const db = getDb();

  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  const result: MessageItem[] = [];

  if (channelName) {
    // Specific channel requested
    const ch = db
      .select()
      .from(channels)
      .where(eq(channels.name, channelName))
      .get();
    if (!ch) return { error: `Channel '${channelName}' not found.` };

    const rows = db
      .select({
        id: messages.id,
        channelName: channels.name,
        senderName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
        content: messages.content,
        mentions: messages.mentions,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(eq(messages.channelId, ch.id))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all();

    for (const row of rows) {
      result.push({
        id: row.id,
        channel: row.channelName,
        sender: row.senderName,
        content: row.content,
        mentions: row.mentions ? JSON.parse(row.mentions) : [],
        created_at: row.createdAt,
      });
    }
  } else {
    // Priority retrieval
    const seenIds = new Set<string>();

    // 1. Messages mentioning this agent
    const mentionRows = db
      .select({
        id: messages.id,
        channelName: channels.name,
        senderName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
        content: messages.content,
        mentions: messages.mentions,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(sql`${messages.mentions} LIKE ${'%"' + agentName + '"%'}`)
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all();

    for (const row of mentionRows) {
      result.push({
        id: row.id,
        channel: row.channelName,
        sender: row.senderName,
        content: row.content,
        mentions: row.mentions ? JSON.parse(row.mentions) : [],
        created_at: row.createdAt,
        priority: "mention",
      });
      seenIds.add(row.id);
    }

    // 2. Project channel messages
    if (result.length < limit) {
      const projChannelName = `#project-${agent.projectName.toLowerCase().replace(/[ _]/g, "-")}`;
      const projCh = db
        .select()
        .from(channels)
        .where(eq(channels.name, projChannelName))
        .get();

      if (projCh) {
        const projRows = db
          .select({
            id: messages.id,
            channelName: channels.name,
            senderName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
            content: messages.content,
            mentions: messages.mentions,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .innerJoin(users, eq(messages.senderId, users.id))
          .innerJoin(channels, eq(messages.channelId, channels.id))
          .where(eq(messages.channelId, projCh.id))
          .orderBy(desc(messages.createdAt))
          .limit(limit)
          .all();

        for (const row of projRows) {
          if (!seenIds.has(row.id) && result.length < limit) {
            result.push({
              id: row.id,
              channel: row.channelName,
              sender: row.senderName,
              content: row.content,
              mentions: row.mentions ? JSON.parse(row.mentions) : [],
              created_at: row.createdAt,
              priority: "project",
            });
            seenIds.add(row.id);
          }
        }
      }
    }

    // 3. Other member channels
    if (result.length < limit) {
      const memberChannelRows = db
        .select({ channelId: channelMembers.channelId })
        .from(channelMembers)
        .where(eq(channelMembers.userId, agent.id))
        .all();
      const channelIds = memberChannelRows.map((r) => r.channelId);

      if (channelIds.length > 0) {
        const otherRows = db
          .select({
            id: messages.id,
            channelName: channels.name,
            senderName: sql<string>`coalesce(${users.displayName}, ${users.name})`,
            content: messages.content,
            mentions: messages.mentions,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .innerJoin(users, eq(messages.senderId, users.id))
          .innerJoin(channels, eq(messages.channelId, channels.id))
          .where(inArray(messages.channelId, channelIds))
          .orderBy(desc(messages.createdAt))
          .limit(limit)
          .all();

        for (const row of otherRows) {
          if (!seenIds.has(row.id) && result.length < limit) {
            result.push({
              id: row.id,
              channel: row.channelName,
              sender: row.senderName,
              content: row.content,
              mentions: row.mentions ? JSON.parse(row.mentions) : [],
              created_at: row.createdAt,
              priority: "other",
            });
            seenIds.add(row.id);
          }
        }
      }
    }
  }

  return { messages: result.slice(0, limit) };
}

/**
 * Search messages across all channels by keyword.
 */
export function searchMessages(
  query: string,
  channelName?: string,
  limit: number = 20
): Record<string, unknown> {
  const db = getDb();
  const maxResults = Math.min(limit, 50);

  let baseQuery = db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      channelName: channels.name,
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
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .where(like(messages.content, `%${query}%`))
    .$dynamic();

  if (channelName) {
    baseQuery = baseQuery.where(eq(channels.name, channelName));
  }

  const rows = baseQuery
    .orderBy(desc(messages.createdAt))
    .limit(maxResults)
    .all();

  const results = rows.map((row) => ({
    id: row.id,
    channel: row.channelName,
    sender: row.senderName,
    sender_type: row.senderType,
    content: row.content,
    mentions: row.mentions ? JSON.parse(row.mentions) : [],
    parent_id: row.parentId,
    created_at: row.createdAt,
  }));

  return { query, results, count: results.length };
}

/**
 * Edit a message as an agent. Only the agent's own messages can be edited.
 */
export function agentEditMessage(
  agentName: string,
  channelName: string,
  messageId: string,
  content: string
): Record<string, unknown> {
  const db = getDb();

  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  const channel = db
    .select()
    .from(channels)
    .where(eq(channels.name, channelName))
    .get();
  if (!channel) return { error: `Channel '${channelName}' not found.` };

  const msg = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!msg) return { error: `Message '${messageId}' not found.` };
  if (msg.channelId !== channel.id) return { error: "Message not in this channel." };
  if (msg.senderId !== agent.id) return { error: "Can only edit your own messages." };

  const editedAt = new Date().toISOString();
  db.update(messages)
    .set({ content, editedAt })
    .where(eq(messages.id, messageId))
    .run();

  broadcastEvent(messageEditedEvent({
    messageId,
    channelId: channel.id,
    content,
    editedAt,
  }));

  return { edited: true, message_id: messageId, edited_at: editedAt };
}
