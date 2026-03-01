/**
 * Test setup — create a fresh in-memory database for each test.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/** Create an in-memory SQLite database with all tables */
export function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });

  // Create all tables
  db.run(sql`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    display_name TEXT,
    about TEXT,
    agent_instructions TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS agents (
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
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    pid INTEGER NOT NULL,
    tty TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    last_heartbeat TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    project_path TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    sender_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    mentions TEXT,
    parent_id TEXT REFERENCES messages(id),
    is_pinned INTEGER NOT NULL DEFAULT 0,
    pinned_at TEXT,
    pinned_by TEXT,
    edited_at TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS read_receipts (
    user_id TEXT NOT NULL REFERENCES users(id),
    channel_id TEXT NOT NULL REFERENCES channels(id),
    last_read_at TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS feature_requests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reason TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`);

  db.run(sql`CREATE TABLE IF NOT EXISTS feature_votes (
    feature_id TEXT NOT NULL REFERENCES feature_requests(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    vote INTEGER NOT NULL,
    PRIMARY KEY (feature_id, user_id)
  )`);

  return db;
}
