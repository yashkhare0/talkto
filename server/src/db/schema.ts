/**
 * Database schema — 13 tables.
 *
 * Conventions:
 * - All IDs are UUID strings (crypto.randomUUID())
 * - All timestamps are ISO 8601 strings (new Date().toISOString())
 * - mentions stored as JSON string array in messages
 * - Every channel, agent, and feature belongs to a workspace
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  unique,
} from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    slug: text("slug").notNull().unique(),
    type: text("type").notNull(), // "personal" | "shared"
    description: text("description"),
    onboardingPrompt: text("onboarding_prompt"), // custom prompt for agents joining
    humanWelcome: text("human_welcome"), // welcome message for humans joining
    createdBy: text("created_by").notNull(), // user UUID or "system"
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at"),
  },
  (table) => [
    index("idx_workspaces_slug").on(table.slug),
  ]
);

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  channels: many(channels),
  agents: many(agents),
  apiKeys: many(workspaceApiKeys),
  invites: many(workspaceInvites),
}));

// ---------------------------------------------------------------------------
// workspace_members
// ---------------------------------------------------------------------------

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(), // "admin" | "member"
    joinedAt: text("joined_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("idx_workspace_members_user").on(table.userId),
  ]
);

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, {
    fields: [workspaceMembers.userId],
    references: [users.id],
  }),
}));

// ---------------------------------------------------------------------------
// workspace_api_keys
// ---------------------------------------------------------------------------

export const workspaceApiKeys = sqliteTable(
  "workspace_api_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    keyHash: text("key_hash").notNull(), // SHA-256 hash of the API key
    keyPrefix: text("key_prefix").notNull(), // first 8 chars for display (e.g., "tk_a1b2...")
    name: text("name"), // human-readable label
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [
    index("idx_api_keys_hash").on(table.keyHash),
    index("idx_api_keys_workspace").on(table.workspaceId),
  ]
);

export const workspaceApiKeysRelations = relations(workspaceApiKeys, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceApiKeys.workspaceId],
    references: [workspaces.id],
  }),
  creator: one(users, {
    fields: [workspaceApiKeys.createdBy],
    references: [users.id],
  }),
}));

// ---------------------------------------------------------------------------
// workspace_invites
// ---------------------------------------------------------------------------

export const workspaceInvites = sqliteTable(
  "workspace_invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    token: text("token").notNull().unique(), // cryptographic token in the invite URL
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull().default("member"), // role assigned on join
    maxUses: integer("max_uses"), // null = unlimited
    useCount: integer("use_count").notNull().default(0),
    expiresAt: text("expires_at"), // null = never
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("idx_invites_token").on(table.token),
    index("idx_invites_workspace").on(table.workspaceId),
  ]
);

export const workspaceInvitesRelations = relations(workspaceInvites, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceInvites.workspaceId],
    references: [workspaces.id],
  }),
  creator: one(users, {
    fields: [workspaceInvites.createdBy],
    references: [users.id],
  }),
}));

// ---------------------------------------------------------------------------
// user_sessions (browser sessions for humans)
// ---------------------------------------------------------------------------

export const userSessions = sqliteTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(), // SHA-256 hash of session token
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastActiveAt: text("last_active_at"),
  },
  (table) => [
    index("idx_user_sessions_token").on(table.tokenHash),
    index("idx_user_sessions_user").on(table.userId),
  ]
);

export const userSessionsRelations = relations(userSessions, ({ one }) => ({
  user: one(users, {
    fields: [userSessions.userId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [userSessions.workspaceId],
    references: [workspaces.id],
  }),
}));

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
  email: text("email"), // optional, for cross-workspace identification
  avatarUrl: text("avatar_url"),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  agent: one(agents, { fields: [users.id], references: [agents.id] }),
  messages: many(messages),
  workspaceMemberships: many(workspaceMembers),
  userSessions: many(userSessions),
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
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index("idx_agents_name").on(table.agentName),
    index("idx_agents_project").on(table.projectName),
    index("idx_agents_workspace").on(table.workspaceId),
  ]
);

export const agentsRelations = relations(agents, ({ one, many }) => ({
  user: one(users, { fields: [agents.id], references: [users.id] }),
  sessions: many(sessions),
  workspace: one(workspaces, { fields: [agents.workspaceId], references: [workspaces.id] }),
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
    name: text("name").notNull(),
    type: text("type").notNull(), // "general" | "project" | "custom" | "dm"
    topic: text("topic"), // channel topic/description shown in header
    projectPath: text("project_path"),
    createdBy: text("created_by").notNull(), // user UUID or "system" — NOT a FK
    createdAt: text("created_at").notNull(),
    isArchived: integer("is_archived").notNull().default(0),
    archivedAt: text("archived_at"),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
  },
  (table) => [
    index("idx_channels_name").on(table.name),
    index("idx_channels_workspace").on(table.workspaceId),
    unique("uq_channel_name_workspace").on(table.name, table.workspaceId),
  ]
);

export const channelsRelations = relations(channels, ({ one, many }) => ({
  members: many(channelMembers),
  messages: many(messages),
  workspace: one(workspaces, { fields: [channels.workspaceId], references: [workspaces.id] }),
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

// ---------------------------------------------------------------------------
// message_reactions (composite PK: message + user + emoji)
// ---------------------------------------------------------------------------

export const messageReactions = sqliteTable(
  "message_reactions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    emoji: text("emoji").notNull(), // e.g. "👍", "🔥", "✅"
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId, table.emoji] }),
    index("idx_reactions_message").on(table.messageId),
  ]
);

export const messageReactionsRelations = relations(messageReactions, ({ one }) => ({
  message: one(messages, {
    fields: [messageReactions.messageId],
    references: [messages.id],
  }),
  user: one(users, {
    fields: [messageReactions.userId],
    references: [users.id],
  }),
}));
