/**
 * Database schema and seed tests.
 */

import { describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestDb, DEFAULT_WORKSPACE_ID } from "./setup";
import {
  users,
  agents,
  channels,
  channelMembers,
  messages,
  featureRequests,
  featureVotes,
  workspaces,
  workspaceMembers,
  workspaceApiKeys,
  workspaceInvites,
  userSessions,
} from "../src/db/schema";

// ---------------------------------------------------------------------------
// Helper: create a default workspace in the test DB
// ---------------------------------------------------------------------------
function seedWorkspace(db: ReturnType<typeof createTestDb>) {
  db.insert(workspaces)
    .values({
      id: DEFAULT_WORKSPACE_ID,
      name: "Default",
      slug: "default",
      type: "personal",
      description: "Test workspace",
      createdBy: "system",
      createdAt: new Date().toISOString(),
    })
    .run();
}

// ---------------------------------------------------------------------------
// Helper: create a user + return the ID
// ---------------------------------------------------------------------------
function createUser(
  db: ReturnType<typeof createTestDb>,
  overrides: Partial<{ id: string; name: string; type: string }> = {}
) {
  const id = overrides.id ?? crypto.randomUUID();
  db.insert(users)
    .values({
      id,
      name: overrides.name ?? "test-user",
      type: overrides.type ?? "human",
      createdAt: new Date().toISOString(),
    })
    .run();
  return id;
}

describe("Database Schema", () => {
  it("creates all tables", () => {
    const db = createTestDb();
    // Should not throw — all 13 tables queryable
    db.select().from(users).all();
    db.select().from(agents).all();
    db.select().from(channels).all();
    db.select().from(channelMembers).all();
    db.select().from(messages).all();
    db.select().from(featureRequests).all();
    db.select().from(featureVotes).all();
    db.select().from(workspaces).all();
    db.select().from(workspaceMembers).all();
    db.select().from(workspaceApiKeys).all();
    db.select().from(workspaceInvites).all();
    db.select().from(userSessions).all();
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

  it("inserts a user with email and avatar_url", () => {
    const db = createTestDb();
    const id = crypto.randomUUID();

    db.insert(users)
      .values({
        id,
        name: "test-human",
        type: "human",
        createdAt: new Date().toISOString(),
        email: "human@example.com",
        avatarUrl: "https://example.com/avatar.png",
      })
      .run();

    const user = db.select().from(users).where(eq(users.id, id)).get();
    expect(user).toBeDefined();
    expect(user!.email).toBe("human@example.com");
    expect(user!.avatarUrl).toBe("https://example.com/avatar.png");
  });

  it("inserts an agent with FK to users", () => {
    const db = createTestDb();
    seedWorkspace(db);
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
        workspaceId: DEFAULT_WORKSPACE_ID,
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

  it("inserts an agent with workspace_id", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const userId = createUser(db, { name: "ws-agent", type: "agent" });

    db.insert(agents)
      .values({
        id: userId,
        agentName: "ws-agent",
        agentType: "opencode",
        projectPath: "/home/dev/project",
        projectName: "test",
        workspaceId: DEFAULT_WORKSPACE_ID,
      })
      .run();

    const agent = db
      .select()
      .from(agents)
      .where(eq(agents.agentName, "ws-agent"))
      .get();
    expect(agent).toBeDefined();
    expect(agent!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("enforces unique agent_name", () => {
    const db = createTestDb();
    seedWorkspace(db);
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
        workspaceId: DEFAULT_WORKSPACE_ID,
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
          workspaceId: DEFAULT_WORKSPACE_ID,
        })
        .run();
    }).toThrow();
  });

  it("inserts and retrieves messages with joins", () => {
    const db = createTestDb();
    seedWorkspace(db);
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
        workspaceId: DEFAULT_WORKSPACE_ID,
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
    seedWorkspace(db);
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
        workspaceId: DEFAULT_WORKSPACE_ID,
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

  it("inserts a channel with workspace_id", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const now = new Date().toISOString();
    const channelId = crypto.randomUUID();

    db.insert(channels)
      .values({
        id: channelId,
        name: "#workspace-test",
        type: "general",
        createdBy: "system",
        createdAt: now,
        workspaceId: DEFAULT_WORKSPACE_ID,
      })
      .run();

    const ch = db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .get();
    expect(ch).toBeDefined();
    expect(ch!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("enforces NOT NULL workspace_id on channels", () => {
    const db = createTestDb();

    expect(() => {
      db.insert(channels)
        .values({
          id: crypto.randomUUID(),
          name: "#no-workspace",
          type: "general",
          createdBy: "system",
          createdAt: new Date().toISOString(),
        } as any)
        .run();
    }).toThrow();
  });

  it("allows same channel name in different workspaces", () => {
    const db = createTestDb();
    const now = new Date().toISOString();

    // Create two workspaces
    const ws1 = crypto.randomUUID();
    const ws2 = crypto.randomUUID();
    db.insert(workspaces).values({ id: ws1, name: "WS1", slug: "ws1", type: "personal", createdBy: "system", createdAt: now }).run();
    db.insert(workspaces).values({ id: ws2, name: "WS2", slug: "ws2", type: "personal", createdBy: "system", createdAt: now }).run();

    // Same channel name in different workspaces should succeed
    db.insert(channels).values({ id: crypto.randomUUID(), name: "#general", type: "general", createdBy: "system", createdAt: now, workspaceId: ws1 }).run();
    db.insert(channels).values({ id: crypto.randomUUID(), name: "#general", type: "general", createdBy: "system", createdAt: now, workspaceId: ws2 }).run();

    const all = db.select().from(channels).all();
    expect(all).toHaveLength(2);
  });

  it("rejects duplicate channel name within same workspace", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const now = new Date().toISOString();

    db.insert(channels).values({ id: crypto.randomUUID(), name: "#general", type: "general", createdBy: "system", createdAt: now, workspaceId: DEFAULT_WORKSPACE_ID }).run();

    expect(() => {
      db.insert(channels).values({ id: crypto.randomUUID(), name: "#general", type: "general", createdBy: "system", createdAt: now, workspaceId: DEFAULT_WORKSPACE_ID }).run();
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Workspace tables
// ---------------------------------------------------------------------------

describe("Workspace Schema", () => {
  it("inserts and retrieves a workspace", () => {
    const db = createTestDb();
    const now = new Date().toISOString();

    db.insert(workspaces)
      .values({
        id: DEFAULT_WORKSPACE_ID,
        name: "Test Workspace",
        slug: "test-workspace",
        type: "personal",
        description: "A test workspace",
        createdBy: "system",
        createdAt: now,
      })
      .run();

    const ws = db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
      .get();
    expect(ws).toBeDefined();
    expect(ws!.name).toBe("Test Workspace");
    expect(ws!.slug).toBe("test-workspace");
    expect(ws!.type).toBe("personal");
  });

  it("enforces unique workspace name", () => {
    const db = createTestDb();
    const now = new Date().toISOString();

    db.insert(workspaces)
      .values({
        id: crypto.randomUUID(),
        name: "UniqueWS",
        slug: "unique-ws",
        type: "personal",
        createdBy: "system",
        createdAt: now,
      })
      .run();

    expect(() => {
      db.insert(workspaces)
        .values({
          id: crypto.randomUUID(),
          name: "UniqueWS",
          slug: "unique-ws-2",
          type: "shared",
          createdBy: "system",
          createdAt: now,
        })
        .run();
    }).toThrow();
  });

  it("enforces unique workspace slug", () => {
    const db = createTestDb();
    const now = new Date().toISOString();

    db.insert(workspaces)
      .values({
        id: crypto.randomUUID(),
        name: "WS1",
        slug: "dup-slug",
        type: "personal",
        createdBy: "system",
        createdAt: now,
      })
      .run();

    expect(() => {
      db.insert(workspaces)
        .values({
          id: crypto.randomUUID(),
          name: "WS2",
          slug: "dup-slug",
          type: "shared",
          createdBy: "system",
          createdAt: now,
        })
        .run();
    }).toThrow();
  });

  it("inserts and retrieves workspace members", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const userId = createUser(db);

    db.insert(workspaceMembers)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId,
        role: "admin",
        joinedAt: new Date().toISOString(),
      })
      .run();

    const members = db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, DEFAULT_WORKSPACE_ID))
      .all();
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("admin");
    expect(members[0].userId).toBe(userId);
  });

  it("enforces composite PK on workspace_members", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const userId = createUser(db);
    const now = new Date().toISOString();

    db.insert(workspaceMembers)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId,
        role: "member",
        joinedAt: now,
      })
      .run();

    // Duplicate should throw
    expect(() => {
      db.insert(workspaceMembers)
        .values({
          workspaceId: DEFAULT_WORKSPACE_ID,
          userId,
          role: "admin",
          joinedAt: now,
        })
        .run();
    }).toThrow();
  });

  it("inserts and retrieves workspace API keys", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const userId = createUser(db);
    const now = new Date().toISOString();
    const keyId = crypto.randomUUID();

    db.insert(workspaceApiKeys)
      .values({
        id: keyId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        keyHash: "sha256_hash_here",
        keyPrefix: "tk_a1b2",
        name: "Test Key",
        createdBy: userId,
        createdAt: now,
      })
      .run();

    const key = db
      .select()
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.id, keyId))
      .get();
    expect(key).toBeDefined();
    expect(key!.keyHash).toBe("sha256_hash_here");
    expect(key!.keyPrefix).toBe("tk_a1b2");
    expect(key!.name).toBe("Test Key");
    expect(key!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(key!.revokedAt).toBeNull();
  });

  it("inserts and retrieves workspace invites", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const userId = createUser(db);
    const now = new Date().toISOString();
    const inviteId = crypto.randomUUID();

    db.insert(workspaceInvites)
      .values({
        id: inviteId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        token: "invite_token_abc",
        createdBy: userId,
        role: "member",
        maxUses: 10,
        createdAt: now,
      })
      .run();

    const invite = db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, inviteId))
      .get();
    expect(invite).toBeDefined();
    expect(invite!.token).toBe("invite_token_abc");
    expect(invite!.role).toBe("member");
    expect(invite!.maxUses).toBe(10);
    expect(invite!.useCount).toBe(0);
    expect(invite!.revokedAt).toBeNull();
  });

  it("enforces unique invite token", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const userId = createUser(db);
    const now = new Date().toISOString();

    db.insert(workspaceInvites)
      .values({
        id: crypto.randomUUID(),
        workspaceId: DEFAULT_WORKSPACE_ID,
        token: "dup_token",
        createdBy: userId,
        createdAt: now,
      })
      .run();

    expect(() => {
      db.insert(workspaceInvites)
        .values({
          id: crypto.randomUUID(),
          workspaceId: DEFAULT_WORKSPACE_ID,
          token: "dup_token",
          createdBy: userId,
          createdAt: now,
        })
        .run();
    }).toThrow();
  });

  it("inserts and retrieves user sessions", () => {
    const db = createTestDb();
    seedWorkspace(db);
    const userId = createUser(db);
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();

    db.insert(userSessions)
      .values({
        id: sessionId,
        userId,
        tokenHash: "session_token_hash",
        workspaceId: DEFAULT_WORKSPACE_ID,
        createdAt: now,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      })
      .run();

    const session = db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .get();
    expect(session).toBeDefined();
    expect(session!.tokenHash).toBe("session_token_hash");
    expect(session!.userId).toBe(userId);
    expect(session!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(session!.lastActiveAt).toBeNull();
  });

  it("enforces FK from workspace_members to workspaces", () => {
    const db = createTestDb();
    const userId = createUser(db);

    expect(() => {
      db.insert(workspaceMembers)
        .values({
          workspaceId: "nonexistent-workspace",
          userId,
          role: "member",
          joinedAt: new Date().toISOString(),
        })
        .run();
    }).toThrow();
  });

  it("enforces FK from workspace_api_keys to users", () => {
    const db = createTestDb();
    seedWorkspace(db);

    expect(() => {
      db.insert(workspaceApiKeys)
        .values({
          id: crypto.randomUUID(),
          workspaceId: DEFAULT_WORKSPACE_ID,
          keyHash: "hash",
          keyPrefix: "tk_xxxx",
          createdBy: "nonexistent-user",
          createdAt: new Date().toISOString(),
        })
        .run();
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Seed tests
// ---------------------------------------------------------------------------

describe("Seed Defaults", () => {
  it("seeds workspace, channels, creator, and features", async () => {
    const db = createTestDb();
    const { seedDefaults } = await import("../src/db/seed");

    await seedDefaults(db);

    // Default workspace created
    const ws = db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
      .get();
    expect(ws).toBeDefined();
    expect(ws!.slug).toBe("default");

    // Channels created with workspace_id
    const chs = db.select().from(channels).all();
    expect(chs.length).toBeGreaterThanOrEqual(2);
    for (const ch of chs) {
      expect(ch.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    }

    // Creator agent created with workspace_id
    const creator = db
      .select()
      .from(agents)
      .where(eq(agents.agentName, "the_creator"))
      .get();
    expect(creator).toBeDefined();
    expect(creator!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);

    // Creator is a workspace member
    const membership = db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, creator!.id))
      .get();
    expect(membership).toBeDefined();
    expect(membership!.role).toBe("admin");

    // Features seeded
    const features = db.select().from(featureRequests).all();
    expect(features.length).toBe(8);
  });

  it("is idempotent — running twice does not duplicate data", async () => {
    const db = createTestDb();
    const { seedDefaults } = await import("../src/db/seed");

    await seedDefaults(db);
    await seedDefaults(db);

    const chs = db.select().from(channels).all();
    expect(chs.length).toBe(2);

    const agentList = db.select().from(agents).all();
    expect(agentList.length).toBe(1);

    const wsList = db.select().from(workspaces).all();
    expect(wsList.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Name Generator
// ---------------------------------------------------------------------------

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
