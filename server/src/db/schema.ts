/**
 * Database schema — all 8 tables.
 *
 * Conventions (matching the Python backend):
 * - All IDs are UUID strings (crypto.randomUUID())
 * - All timestamps are ISO 8601 strings (new Date().toISOString())
 * - mentions stored as JSON string array in messages
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(), // "human" | "agent"
  createdAt: text("created_at").notNull(),
  displayName: text("display_name"),
  about: text("about"),
  agentInstructions: text("agent_instructions"),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  agent: one(agents, { fields: [users.id], references: [agents.id] }),
  messages: many(messages),
}));

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

export const agents = sqliteTable(
  "agents",
  {
    id: text("id")
      .primaryKey()
      .references(() => users.id),
    agentName: text("agent_name").notNull().unique(),
    agentType: text("agent_type").notNull(), // "opencode" | "claude_code" | "codex" | "system"
    projectPath: text("project_path").notNull(),
    projectName: text("project_name").notNull(),
    status: text("status").notNull().default("offline"),
    description: text("description"),
    personality: text("personality"),
    currentTask: text("current_task"),
    gender: text("gender"),
    serverUrl: text("server_url"),
    providerSessionId: text("provider_session_id"),
  },
  (table) => [
    index("idx_agents_name").on(table.agentName),
    index("idx_agents_project").on(table.projectName),
  ]
);

export const agentsRelations = relations(agents, ({ one, many }) => ({
  user: one(users, { fields: [agents.id], references: [users.id] }),
  sessions: many(sessions),
}));

// ---------------------------------------------------------------------------
// sessions (agent login sessions with heartbeat tracking)
// ---------------------------------------------------------------------------

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    pid: integer("pid").notNull(),
    tty: text("tty").notNull(),
    isActive: integer("is_active").notNull().default(1),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    lastHeartbeat: text("last_heartbeat").notNull(),
  },
  (table) => [
    index("idx_sessions_agent_active").on(table.agentId, table.isActive),
  ]
);

export const sessionsRelations = relations(sessions, ({ one }) => ({
  agent: one(agents, { fields: [sessions.agentId], references: [agents.id] }),
}));

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    type: text("type").notNull(), // "general" | "project" | "custom" | "dm"
    projectPath: text("project_path"),
    createdBy: text("created_by").notNull(), // user UUID or "system" — NOT a FK
    createdAt: text("created_at").notNull(),
    isArchived: integer("is_archived").notNull().default(0),
    archivedAt: text("archived_at"),
  },
  (table) => [index("idx_channels_name").on(table.name)]
);

export const channelsRelations = relations(channels, ({ many }) => ({
  members: many(channelMembers),
  messages: many(messages),
}));

// ---------------------------------------------------------------------------
// channel_members (composite PK)
// ---------------------------------------------------------------------------

export const channelMembers = sqliteTable(
  "channel_members",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    joinedAt: text("joined_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.userId] }),
  ]
);

export const channelMembersRelations = relations(channelMembers, ({ one }) => ({
  channel: one(channels, {
    fields: [channelMembers.channelId],
    references: [channels.id],
  }),
  user: one(users, {
    fields: [channelMembers.userId],
    references: [users.id],
  }),
}));

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    senderId: text("sender_id")
      .notNull()
      .references(() => users.id),
    content: text("content").notNull(),
    mentions: text("mentions"), // JSON array string, e.g. '["agent1","agent2"]'
    parentId: text("parent_id").references(() => messages.id),
    isPinned: integer("is_pinned").notNull().default(0),
    pinnedAt: text("pinned_at"),
    pinnedBy: text("pinned_by"),
    editedAt: text("edited_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_messages_channel_created").on(table.channelId, table.createdAt),
    index("idx_messages_sender").on(table.senderId),
  ]
);

export const messagesRelations = relations(messages, ({ one }) => ({
  channel: one(channels, {
    fields: [messages.channelId],
    references: [channels.id],
  }),
  sender: one(users, {
    fields: [messages.senderId],
    references: [users.id],
  }),
  parent: one(messages, {
    fields: [messages.parentId],
    references: [messages.id],
  }),
}));

// ---------------------------------------------------------------------------
// feature_requests
// ---------------------------------------------------------------------------

export const featureRequests = sqliteTable("feature_requests", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("open"), // open|planned|in_progress|done|closed|wontfix
  reason: text("reason"), // explanation for closing/resolving (nullable)
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"), // when status last changed (nullable)
});

export const featureRequestsRelations = relations(
  featureRequests,
  ({ many }) => ({
    votes: many(featureVotes),
  })
);

// ---------------------------------------------------------------------------
// feature_votes (composite PK)
// ---------------------------------------------------------------------------

export const featureVotes = sqliteTable(
  "feature_votes",
  {
    featureId: text("feature_id")
      .notNull()
      .references(() => featureRequests.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    vote: integer("vote").notNull(), // +1 or -1
  },
  (table) => [
    primaryKey({ columns: [table.featureId, table.userId] }),
  ]
);

// ---------------------------------------------------------------------------
// read_receipts — tracks last_read_at per user per channel
// ---------------------------------------------------------------------------

export const readReceipts = sqliteTable(
  "read_receipts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    lastReadAt: text("last_read_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.channelId] }),
  ]
);

export const readReceiptsRelations = relations(readReceipts, ({ one }) => ({
  user: one(users, {
    fields: [readReceipts.userId],
    references: [users.id],
  }),
  channel: one(channels, {
    fields: [readReceipts.channelId],
    references: [channels.id],
  }),
}));

export const featureVotesRelations = relations(featureVotes, ({ one }) => ({
  feature: one(featureRequests, {
    fields: [featureVotes.featureId],
    references: [featureRequests.id],
  }),
  user: one(users, {
    fields: [featureVotes.userId],
    references: [users.id],
  }),
}));
