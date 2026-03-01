/**
 * Database connection — bun:sqlite with WAL mode + Drizzle ORM.
 *
 * Auto-creates all tables on first connection (zero-config startup).
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../lib/config";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _sqlite: Database | null = null;

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
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      display_name TEXT,
      about TEXT,
      agent_instructions TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY REFERENCES users(id),
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
      provider_session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(agent_name);
    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_name);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      pid INTEGER NOT NULL,
      tty TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_heartbeat TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent_active ON sessions(agent_id, is_active);

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      topic TEXT,
      project_path TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);

    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL REFERENCES channels(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      joined_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      sender_id TEXT NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      mentions TEXT,
      parent_id TEXT REFERENCES messages(id),
      is_pinned INTEGER NOT NULL DEFAULT 0,
      pinned_at TEXT,
      pinned_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

    CREATE TABLE IF NOT EXISTS feature_requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reason TEXT,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS feature_votes (
      feature_id TEXT NOT NULL REFERENCES feature_requests(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      vote INTEGER NOT NULL,
      PRIMARY KEY (feature_id, user_id)
    );
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

export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

/** Shorthand type for the database instance */
export type Db = ReturnType<typeof getDb>;
