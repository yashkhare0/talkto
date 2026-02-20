/**
 * Database schema and seed tests.
 */

import { describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "./setup";
import {
  users,
  agents,
  channels,
  channelMembers,
  messages,
  featureRequests,
  featureVotes,
} from "../src/db/schema";

describe("Database Schema", () => {
  it("creates all tables", () => {
    const db = createTestDb();
    // Should not throw
    db.select().from(users).all();
    db.select().from(agents).all();
    db.select().from(channels).all();
    db.select().from(channelMembers).all();
    db.select().from(messages).all();
    db.select().from(featureRequests).all();
    db.select().from(featureVotes).all();
  });

  it("inserts and retrieves a user", () => {
    const db = createTestDb();
    const id = crypto.randomUUID();

    db.insert(users)
      .values({
        id,
        name: "test-user",
        type: "human",
        createdAt: new Date().toISOString(),
        displayName: "Test User",
      })
      .run();

    const user = db.select().from(users).where(eq(users.id, id)).get();
    expect(user).toBeDefined();
    expect(user!.name).toBe("test-user");
    expect(user!.type).toBe("human");
    expect(user!.displayName).toBe("Test User");
  });

  it("inserts an agent with FK to users", () => {
    const db = createTestDb();
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.insert(users)
      .values({ id: userId, name: "cool-fox", type: "agent", createdAt: now })
      .run();

    db.insert(agents)
      .values({
        id: userId,
        agentName: "cool-fox",
        agentType: "opencode",
        projectPath: "/home/dev/test-project",
        projectName: "test",
        status: "online",
      })
      .run();

    const agent = db
      .select()
      .from(agents)
      .where(eq(agents.agentName, "cool-fox"))
      .get();
    expect(agent).toBeDefined();
    expect(agent!.agentType).toBe("opencode");
    expect(agent!.status).toBe("online");
  });

  it("enforces unique agent_name", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    db.insert(users)
      .values({ id: id1, name: "dup-agent", type: "agent", createdAt: now })
      .run();
    db.insert(agents)
      .values({
        id: id1,
        agentName: "dup-agent",
        agentType: "opencode",
        projectPath: "/home/dev/project-a",
        projectName: "test",
      })
      .run();

    db.insert(users)
      .values({ id: id2, name: "dup-agent-2", type: "agent", createdAt: now })
      .run();

    expect(() => {
      db.insert(agents)
        .values({
          id: id2,
          agentName: "dup-agent",
          agentType: "opencode",
          projectPath: "/home/dev/project-b",
          projectName: "test",
        })
        .run();
    }).toThrow();
  });

  it("inserts and retrieves messages with joins", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const msgId = crypto.randomUUID();

    db.insert(users)
      .values({ id: userId, name: "sender", type: "agent", createdAt: now })
      .run();
    db.insert(channels)
      .values({
        id: channelId,
        name: "#general",
        type: "general",
        createdBy: "system",
        createdAt: now,
      })
      .run();
    db.insert(messages)
      .values({
        id: msgId,
        channelId,
        senderId: userId,
        content: "Hello world",
        mentions: JSON.stringify(["other-agent"]),
        createdAt: now,
      })
      .run();

    const msg = db.select().from(messages).where(eq(messages.id, msgId)).get();
    expect(msg).toBeDefined();
    expect(msg!.content).toBe("Hello world");
    expect(JSON.parse(msg!.mentions!)).toEqual(["other-agent"]);
  });

  it("supports composite primary key for channel_members", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const channelId = crypto.randomUUID();

    db.insert(users)
      .values({ id: userId, name: "test", type: "agent", createdAt: now })
      .run();
    db.insert(channels)
      .values({
        id: channelId,
        name: "#test",
        type: "general",
        createdBy: "system",
        createdAt: now,
      })
      .run();
    db.insert(channelMembers)
      .values({ channelId, userId, joinedAt: now })
      .run();

    // Duplicate should throw
    expect(() => {
      db.insert(channelMembers)
        .values({ channelId, userId, joinedAt: now })
        .run();
    }).toThrow();
  });

  it("supports feature votes with composite PK", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const featureId = crypto.randomUUID();

    db.insert(users)
      .values({ id: userId, name: "voter", type: "agent", createdAt: now })
      .run();
    db.insert(featureRequests)
      .values({
        id: featureId,
        title: "Test Feature",
        description: "A test",
        createdBy: userId,
        createdAt: now,
      })
      .run();
    db.insert(featureVotes)
      .values({ featureId, userId, vote: 1 })
      .run();

    // Get vote count
    const result = db
      .select({ total: sql<number>`coalesce(sum(${featureVotes.vote}), 0)` })
      .from(featureVotes)
      .where(eq(featureVotes.featureId, featureId))
      .get();
    expect(Number(result?.total)).toBe(1);
  });
});

describe("Name Generator", () => {
  it("generates deterministic names from seed", async () => {
    const { generateName } = await import("../src/services/name-generator");
    const name1 = generateName("test-seed");
    const name2 = generateName("test-seed");
    expect(name1).toBe(name2);
    expect(name1).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("generates different names for different seeds", async () => {
    const { generateName } = await import("../src/services/name-generator");
    const name1 = generateName("seed-a");
    const name2 = generateName("seed-b");
    expect(name1).not.toBe(name2);
  });

  it("generates unique names with entropy", async () => {
    const { generateUniqueName } = await import("../src/services/name-generator");
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateUniqueName("project", "opencode"));
    }
    expect(names.size).toBe(20);
  });
});
