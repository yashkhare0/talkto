/**
 * Test setup — create a fresh in-memory database for each test.
 *
 * Schema mirrors server/src/db/index.ts createTables() exactly.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/** Well-known default workspace ID (matches index.ts) */
export const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

/** Create an in-memory SQLite database with all tables */
export function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });

  // -----------------------------------------------------------------
  // workspaces (must come before tables that reference it)
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    description TEXT,
    onboarding_prompt TEXT,
    human_welcome TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug)`);

  // -----------------------------------------------------------------
  // users
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    display_name TEXT,
    about TEXT,
    agent_instructions TEXT,
    email TEXT,
    avatar_url TEXT
  )`);

  // -----------------------------------------------------------------
  // workspace_members
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id)`);

  // -----------------------------------------------------------------
  // workspace_api_keys
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS workspace_api_keys (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    name TEXT,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON workspace_api_keys(key_hash)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON workspace_api_keys(workspace_id)`);

  // -----------------------------------------------------------------
  // workspace_invites
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS workspace_invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    max_uses INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_invites_token ON workspace_invites(token)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_invites_workspace ON workspace_invites(workspace_id)`);

  // -----------------------------------------------------------------
  // user_sessions (browser sessions for humans)
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_active_at TEXT
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)`);

  // -----------------------------------------------------------------
  // agents
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    agent_name TEXT NOT NULL UNIQUE,
    agent_type TEXT NOT NULL,
    project_path TEXT NOT NULL,
    project_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offline',
    description TEXT,
    personality TEXT,
    current_task TEXT,
    gender TEXT,
    server_url TEXT,
    provider_session_id TEXT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id)
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(agent_name)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_name)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)`);

  // -----------------------------------------------------------------
  // sessions (agent login sessions)
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    pid INTEGER NOT NULL,
    tty TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    last_heartbeat TEXT NOT NULL
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_sessions_agent_active ON sessions(agent_id, is_active)`);

  // -----------------------------------------------------------------
  // channels
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    topic TEXT,
    project_path TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    UNIQUE(name, workspace_id)
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id)`);

  // -----------------------------------------------------------------
  // channel_members (composite PK)
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  )`);

  // -----------------------------------------------------------------
  // messages
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    mentions TEXT,
    parent_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    pinned_at TEXT,
    pinned_by TEXT,
    edited_at TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at)`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`);

  db.run(sql`CREATE TABLE IF NOT EXISTS read_receipts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_at TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  )`);

  // -----------------------------------------------------------------
  // feature_requests
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS feature_requests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reason TEXT,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`);

  // -----------------------------------------------------------------
  // feature_votes (composite PK)
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS feature_votes (
    feature_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote INTEGER NOT NULL,
    PRIMARY KEY (feature_id, user_id)
  )`);

  // -----------------------------------------------------------------
  // message_reactions (composite PK: message + user + emoji)
  // -----------------------------------------------------------------
  db.run(sql`CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  )`);
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id)`);

  return db;
}
