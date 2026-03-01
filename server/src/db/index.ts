/**
 * Database connection — bun:sqlite with WAL mode + Drizzle ORM.
 *
 * Auto-creates all tables on first connection (zero-config startup).
 * Runs lightweight migrations for schema evolution (e.g., adding workspace columns).
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../lib/config";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database | null = null;

/** Well-known ID for the default workspace (deterministic for migrations). */
export const DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";
export const DEFAULT_WORKSPACE_SLUG = "default";

export function getDb() {
  if (_db) return _db;

  // Ensure data directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  _sqlite = new Database(config.dbPath);

  // SQLite pragmas
  _sqlite.exec("PRAGMA journal_mode = WAL");
  _sqlite.exec("PRAGMA foreign_keys = ON");
  _sqlite.exec("PRAGMA busy_timeout = 5000");
  _sqlite.exec("PRAGMA synchronous = NORMAL");
  _sqlite.exec("PRAGMA cache_size = -64000");
  _sqlite.exec("PRAGMA temp_store = MEMORY");

  // Auto-create tables if they don't exist (zero-config startup)
  createTables(_sqlite);
  migrateSchema(_sqlite);

  // Run additive migrations for existing databases
  migrateUp(_sqlite);

  // Run lightweight migrations for schema evolution
  runMigrations(_sqlite);

  _db = drizzle(_sqlite, { schema });
  return _db;
}

/**
 * Create all tables if they don't exist.
 *
 * This mirrors the Drizzle schema but uses raw CREATE TABLE IF NOT EXISTS
 * so the app works without running drizzle-kit push first.
 */
function createTables(sqlite: Database) {
  sqlite.exec(`
    -- -----------------------------------------------------------------
    -- workspaces (must come before tables that reference it)
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS workspaces (
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
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);

    -- -----------------------------------------------------------------
    -- users
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      display_name TEXT,
      about TEXT,
      agent_instructions TEXT,
      email TEXT,
      avatar_url TEXT
    );

    -- -----------------------------------------------------------------
    -- workspace_members
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

    -- -----------------------------------------------------------------
    -- workspace_api_keys
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS workspace_api_keys (
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
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON workspace_api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON workspace_api_keys(workspace_id);

    -- -----------------------------------------------------------------
    -- workspace_invites
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS workspace_invites (
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
    );

    CREATE INDEX IF NOT EXISTS idx_invites_token ON workspace_invites(token);
    CREATE INDEX IF NOT EXISTS idx_invites_workspace ON workspace_invites(workspace_id);

    -- -----------------------------------------------------------------
    -- user_sessions (browser sessions for humans)
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

    -- -----------------------------------------------------------------
    -- agents
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS agents (
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
    );

    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(agent_name);
    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_name);

    -- -----------------------------------------------------------------
    -- sessions (agent login sessions)
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      pid INTEGER NOT NULL,
      tty TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_heartbeat TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent_active ON sessions(agent_id, is_active);

    -- -----------------------------------------------------------------
    -- channels
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS channels (
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
    );

    CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);

    -- -----------------------------------------------------------------
    -- channel_members (composite PK)
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    );

    -- -----------------------------------------------------------------
    -- messages
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS messages (
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
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

    -- -----------------------------------------------------------------
    -- feature_requests
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS feature_requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reason TEXT,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS read_receipts (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      last_read_at TEXT NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );

    -- -----------------------------------------------------------------
    -- feature_votes (composite PK)
    -- -----------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS feature_votes (
      feature_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vote INTEGER NOT NULL,
      PRIMARY KEY (feature_id, user_id)
    );
  `);

  // message_reactions table
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
  `);

  // Migrate existing databases: add new columns if missing
  const migrations = [
    "ALTER TABLE feature_requests ADD COLUMN reason TEXT",
    "ALTER TABLE feature_requests ADD COLUMN updated_at TEXT",
  ];
  for (const stmt of migrations) {
    try { sqlite.exec(stmt); } catch { /* column already exists */ }
  }
}

/**
 * Additive migrations for existing databases.
 * Each migration is guarded by a column-existence check so it's safe to re-run.
 */
function migrateUp(sqlite: Database) {
  // Helper: check if a column exists in a table
  const hasColumn = (table: string, column: string): boolean => {
    const info = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return info.some((col) => col.name === column);
  };

  // Migration: add pinning columns to messages
  if (!hasColumn("messages", "is_pinned")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
    sqlite.exec("ALTER TABLE messages ADD COLUMN pinned_at TEXT");
    sqlite.exec("ALTER TABLE messages ADD COLUMN pinned_by TEXT");
  }

  // Migration: add edited_at column to messages
  if (!hasColumn("messages", "edited_at")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN edited_at TEXT");
  }

  // Migration: add topic column to channels
  if (!hasColumn("channels", "topic")) {
    sqlite.exec("ALTER TABLE channels ADD COLUMN topic TEXT");
  }
}

/**
 * Apply schema migrations for existing databases.
 * Each migration is idempotent — safe to run multiple times.
 */
function migrateSchema(sqlite: Database) {
  // Add is_archived and archived_at columns to channels (added in v0.2)
  try {
    sqlite.exec(`ALTER TABLE channels ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }
  try {
    sqlite.exec(`ALTER TABLE channels ADD COLUMN archived_at TEXT`);
  } catch {
    // Column already exists — ignore
  }
}

/**
 * Lightweight migrations for schema evolution.
 *
 * Each migration checks whether it's already been applied (idempotent).
 * Uses SQLite's PRAGMA table_info to detect missing columns.
 */
function runMigrations(sqlite: Database) {
  // Helper: check if a column exists on a table
  const hasColumn = (table: string, column: string): boolean => {
    const cols = sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    return cols.some((c) => c.name === column);
  };

  // ---------------------------------------------------------------
  // Migration 1: Add workspace_id to channels (nullable for compat)
  // ---------------------------------------------------------------
  if (!hasColumn("channels", "workspace_id")) {
    sqlite.exec(
      `ALTER TABLE channels ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)`
    );
  }
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id)`
  );

  // ---------------------------------------------------------------
  // Migration 2: Add workspace_id to agents (nullable for compat)
  // ---------------------------------------------------------------
  if (!hasColumn("agents", "workspace_id")) {
    sqlite.exec(
      `ALTER TABLE agents ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)`
    );
  }
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)`
  );

  // ---------------------------------------------------------------
  // Migration 3: Add email + avatar_url to users
  // ---------------------------------------------------------------
  if (!hasColumn("users", "email")) {
    sqlite.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
  }
  if (!hasColumn("users", "avatar_url")) {
    sqlite.exec(`ALTER TABLE users ADD COLUMN avatar_url TEXT`);
  }

  // ---------------------------------------------------------------
  // Migration 4: Ensure default workspace exists + backfill
  // ---------------------------------------------------------------
  ensureDefaultWorkspace(sqlite);

  // ---------------------------------------------------------------
  // Migration 5: Rebuild tables with CASCADE FK constraints
  // and composite UNIQUE(name, workspace_id) on channels.
  //
  // SQLite doesn't support ALTER CONSTRAINT, so we recreate tables.
  // Uses a sentinel pragma to avoid re-running on subsequent boots.
  // ---------------------------------------------------------------
  migrateCascadeFks(sqlite);
}

/**
 * Rebuild tables with proper CASCADE foreign keys.
 *
 * SQLite cannot ALTER existing FK constraints, so we use the
 * standard rename-copy-drop pattern. Guarded by a user_version pragma
 * so it only runs once per database.
 */
function migrateCascadeFks(sqlite: Database) {
  const version = (sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version >= 1) return; // Already migrated

  // PRAGMA foreign_keys must be set OUTSIDE any transaction
  sqlite.exec("PRAGMA foreign_keys = OFF");

  sqlite.exec("BEGIN TRANSACTION");
  try {
    // Helper: rebuild a table with new DDL.
    // Uses explicit column list to handle column reordering from ALTER TABLE ADD COLUMN.
    const rebuild = (createNew: string, tableName: string, columns: string, indexes: string[] = []) => {
      sqlite.exec(createNew);
      sqlite.exec(`INSERT INTO ${tableName}_new (${columns}) SELECT ${columns} FROM ${tableName}`);
      sqlite.exec(`DROP TABLE ${tableName}`);
      sqlite.exec(`ALTER TABLE ${tableName}_new RENAME TO ${tableName}`);
      for (const idx of indexes) {
        sqlite.exec(idx);
      }
    };

    // --- channels: add UNIQUE(name, workspace_id), NOT NULL workspace_id ---
    rebuild(
      `CREATE TABLE channels_new (
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
      )`,
      "channels",
      "id, name, type, topic, project_path, created_by, created_at, is_archived, archived_at, workspace_id",
      [
        "CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name)",
        "CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id)",
      ]
    );

    // --- agents: NOT NULL workspace_id, CASCADE on user + workspace FKs ---
    rebuild(
      `CREATE TABLE agents_new (
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
      )`,
      "agents",
      "id, agent_name, agent_type, project_path, project_name, status, description, personality, current_task, gender, server_url, provider_session_id, workspace_id",
      [
        "CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(agent_name)",
        "CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_name)",
        "CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id)",
      ]
    );

    // --- sessions: CASCADE on agent FK ---
    rebuild(
      `CREATE TABLE sessions_new (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        pid INTEGER NOT NULL,
        tty TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_heartbeat TEXT NOT NULL
      )`,
      "sessions",
      "id, agent_id, pid, tty, is_active, started_at, ended_at, last_heartbeat",
      ["CREATE INDEX IF NOT EXISTS idx_sessions_agent_active ON sessions(agent_id, is_active)"]
    );

    // --- channel_members: CASCADE on channel + user FKs ---
    rebuild(
      `CREATE TABLE channel_members_new (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, user_id)
      )`,
      "channel_members",
      "channel_id, user_id, joined_at"
    );

    // --- messages: CASCADE on channel + user, SET NULL on parent ---
    rebuild(
      `CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        mentions TEXT,
        parent_id TEXT REFERENCES messages_new(id) ON DELETE SET NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        pinned_at TEXT,
        pinned_by TEXT,
        edited_at TEXT,
        created_at TEXT NOT NULL
      )`,
      "messages",
      "id, channel_id, sender_id, content, mentions, parent_id, is_pinned, pinned_at, pinned_by, edited_at, created_at",
      [
        "CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)",
      ]
    );

    // --- workspace_members: CASCADE on workspace + user FKs ---
    rebuild(
      `CREATE TABLE workspace_members_new (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      )`,
      "workspace_members",
      "workspace_id, user_id, role, joined_at",
      ["CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id)"]
    );

    // --- user_sessions: CASCADE on user + workspace FKs ---
    rebuild(
      `CREATE TABLE user_sessions_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_active_at TEXT
      )`,
      "user_sessions",
      "id, user_id, token_hash, workspace_id, created_at, expires_at, last_active_at",
      [
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash)",
        "CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)",
      ]
    );

    // --- workspace_api_keys: CASCADE on workspace + user FKs ---
    rebuild(
      `CREATE TABLE workspace_api_keys_new (
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
      )`,
      "workspace_api_keys",
      "id, workspace_id, key_hash, key_prefix, name, created_by, created_at, expires_at, revoked_at, last_used_at",
      [
        "CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON workspace_api_keys(key_hash)",
        "CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON workspace_api_keys(workspace_id)",
      ]
    );

    // --- workspace_invites: CASCADE on workspace + user FKs ---
    rebuild(
      `CREATE TABLE workspace_invites_new (
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
      )`,
      "workspace_invites",
      "id, workspace_id, token, created_by, role, max_uses, use_count, expires_at, created_at, revoked_at",
      [
        "CREATE INDEX IF NOT EXISTS idx_invites_token ON workspace_invites(token)",
        "CREATE INDEX IF NOT EXISTS idx_invites_workspace ON workspace_invites(workspace_id)",
      ]
    );

    // --- read_receipts: CASCADE on user + channel FKs ---
    rebuild(
      `CREATE TABLE read_receipts_new (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        last_read_at TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      )`,
      "read_receipts",
      "user_id, channel_id, last_read_at"
    );

    // --- feature_requests: CASCADE on user FK ---
    rebuild(
      `CREATE TABLE feature_requests_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        reason TEXT,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT
      )`,
      "feature_requests",
      "id, title, description, status, reason, created_by, created_at, updated_at"
    );

    // --- feature_votes: CASCADE on feature + user FKs ---
    rebuild(
      `CREATE TABLE feature_votes_new (
        feature_id TEXT NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vote INTEGER NOT NULL,
        PRIMARY KEY (feature_id, user_id)
      )`,
      "feature_votes",
      "feature_id, user_id, vote"
    );

    // --- message_reactions: CASCADE on both FKs ---
    rebuild(
      `CREATE TABLE message_reactions_new (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      )`,
      "message_reactions",
      "message_id, user_id, emoji, created_at",
      ["CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id)"]
    );

    // Mark migration as complete
    sqlite.exec("PRAGMA user_version = 1");

    sqlite.exec("COMMIT");

    // Re-enable FK checks after transaction
    sqlite.exec("PRAGMA foreign_keys = ON");

    console.log("[DB] Migration 5: Rebuilt tables with CASCADE FK constraints");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    sqlite.exec("PRAGMA foreign_keys = ON");
    console.error("[DB] Migration 5 failed:", err);
    throw err;
  }
}

/**
 * Create the default workspace if it doesn't exist, then backfill
 * any channels/agents that have NULL workspace_id.
 */
function ensureDefaultWorkspace(sqlite: Database) {
  const now = new Date().toISOString();

  // Insert the default workspace (idempotent via INSERT OR IGNORE)
  sqlite.exec(`
    INSERT OR IGNORE INTO workspaces (id, name, slug, type, description, created_by, created_at)
    VALUES (
      '${DEFAULT_WORKSPACE_ID}',
      'Default',
      '${DEFAULT_WORKSPACE_SLUG}',
      'personal',
      'Auto-created default workspace',
      'system',
      '${now}'
    )
  `);

  // Backfill channels without a workspace
  sqlite.exec(`
    UPDATE channels
    SET workspace_id = '${DEFAULT_WORKSPACE_ID}'
    WHERE workspace_id IS NULL
  `);

  // Backfill agents without a workspace
  sqlite.exec(`
    UPDATE agents
    SET workspace_id = '${DEFAULT_WORKSPACE_ID}'
    WHERE workspace_id IS NULL
  `);
}

export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

/** Shorthand type for the database instance */
export type Db = ReturnType<typeof getDb>;
