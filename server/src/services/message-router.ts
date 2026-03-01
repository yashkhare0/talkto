/**
 * Message routing — send/get messages for agents with priority-based retrieval.
 */

import { eq, desc, sql, and, inArray, like } from "drizzle-orm";
import { getDb, DEFAULT_WORKSPACE_ID } from "../db";
import {
  agents,
  channels,
  channelMembers,
  messages,
  messageReactions,
  users,
} from "../db/schema";
import { broadcastEvent, newMessageEvent, messageEditedEvent, reactionEvent } from "./broadcaster";
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

  const workspaceId = agent.workspaceId ?? DEFAULT_WORKSPACE_ID;

  // Get channel (scoped to agent's workspace)
  const channel = db
    .select()
    .from(channels)
    .where(and(eq(channels.name, channelName), eq(channels.workspaceId, workspaceId)))
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

  // Broadcast to WebSocket clients (scoped to workspace)
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
    }),
    workspaceId
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

  const workspaceId = agent.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result: MessageItem[] = [];

  if (channelName) {
    // Specific channel requested (scoped to agent's workspace)
    const ch = db
      .select()
      .from(channels)
      .where(and(eq(channels.name, channelName), eq(channels.workspaceId, workspaceId)))
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

    // 1. Messages mentioning this agent (scoped to workspace via channels join)
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
      .where(
        and(
          sql`${messages.mentions} LIKE ${'%"' + agentName + '"%'}`,
          eq(channels.workspaceId, workspaceId)
        )
      )
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

    // 2. Project channel messages (scoped to workspace)
    if (result.length < limit) {
      const projChannelName = `#project-${agent.projectName.toLowerCase().replace(/[ _]/g, "-")}`;
      const projCh = db
        .select()
        .from(channels)
        .where(and(eq(channels.name, projChannelName), eq(channels.workspaceId, workspaceId)))
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
  limit: number = 20,
  workspaceId?: string
): Record<string, unknown> {
  const db = getDb();
  const maxResults = Math.min(limit, 50);

  // Escape LIKE wildcards to prevent '%' or '_' in user input from matching everything
  const escapedQuery = query.replace(/%/g, "\\%").replace(/_/g, "\\_");

  // Build conditions: text match + optional workspace + optional channel
  const conditions = [like(messages.content, `%${escapedQuery}%`)];
  if (workspaceId) {
    conditions.push(eq(channels.workspaceId, workspaceId));
  }
  if (channelName) {
    conditions.push(eq(channels.name, channelName));
  }

  const baseQuery = db
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
    .where(and(...conditions));

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

  const workspaceId = agent.workspaceId ?? DEFAULT_WORKSPACE_ID;

  // Scope channel lookup to agent's workspace
  const channel = db
    .select()
    .from(channels)
    .where(and(eq(channels.name, channelName), eq(channels.workspaceId, workspaceId)))
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
  }), workspaceId);

  return { edited: true, message_id: messageId, edited_at: editedAt };
}

/**
 * Toggle a reaction on a message as an agent.
 */
export function agentReactMessage(
  agentName: string,
  channelName: string,
  messageId: string,
  emoji: string
): Record<string, unknown> {
  const db = getDb();

  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();
  if (!agent) return { error: `Agent '${agentName}' not found.` };

  const workspaceId = agent.workspaceId ?? DEFAULT_WORKSPACE_ID;

  // Scope channel lookup to agent's workspace
  const channel = db
    .select()
    .from(channels)
    .where(and(eq(channels.name, channelName), eq(channels.workspaceId, workspaceId)))
    .get();
  if (!channel) return { error: `Channel '${channelName}' not found.` };

  const msg = db.select().from(messages).where(eq(messages.id, messageId)).get();
  if (!msg) return { error: `Message '${messageId}' not found.` };
  if (msg.channelId !== channel.id) return { error: "Message not in this channel." };

  // Toggle: check if already reacted
  const existing = db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, agent.id),
        eq(messageReactions.emoji, emoji),
      )
    )
    .get();

  if (existing) {
    db.delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, agent.id),
          eq(messageReactions.emoji, emoji),
        )
      )
      .run();

    broadcastEvent(reactionEvent({
      messageId,
      channelId: channel.id,
      emoji,
      userName: agentName,
      action: "remove",
    }), workspaceId);

    return { action: "removed", emoji, message_id: messageId };
  } else {
    const now = new Date().toISOString();
    db.insert(messageReactions)
      .values({ messageId, userId: agent.id, emoji, createdAt: now })
      .run();

    broadcastEvent(reactionEvent({
      messageId,
      channelId: channel.id,
      emoji,
      userName: agentName,
      action: "add",
    }), workspaceId);

    return { action: "added", emoji, message_id: messageId };
  }
}
