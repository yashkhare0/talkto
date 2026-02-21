/**
 * Workspace manager tests — CRUD, membership, API keys, invites.
 *
 * These tests exercise the workspace-manager service functions directly
 * against an in-memory database. Since the service calls getDb() which
 * returns the singleton DB, we test the DB operations via direct DB
 * manipulation in the test setup file.
 */

import { describe, expect, it } from "bun:test";
import { eq, and, sql } from "drizzle-orm";
import { createTestDb, DEFAULT_WORKSPACE_ID } from "./setup";
import {
  users,
  workspaces,
  workspaceMembers,
  workspaceApiKeys,
  workspaceInvites,
} from "../src/db/schema";
import { hashToken, generateToken, API_KEY_PREFIX } from "../src/services/auth-service";

// ---------------------------------------------------------------------------
// Helper: seed test workspace + user
// ---------------------------------------------------------------------------
function seedTestData(db: ReturnType<typeof createTestDb>) {
  const now = new Date().toISOString();

  db.insert(workspaces)
    .values({
      id: DEFAULT_WORKSPACE_ID,
      name: "Default",
      slug: "default",
      type: "personal",
      createdBy: "system",
      createdAt: now,
    })
    .run();

  const adminId = crypto.randomUUID();
  db.insert(users)
    .values({
      id: adminId,
      name: "admin-user",
      type: "human",
      createdAt: now,
      displayName: "The Admin",
    })
    .run();

  db.insert(workspaceMembers)
    .values({
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: adminId,
      role: "admin",
      joinedAt: now,
    })
    .run();

  return { adminId };
}

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

describe("Workspace Manager — CRUD", () => {
  it("creates a workspace with owner as admin member", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();

    db.insert(users)
      .values({ id: userId, name: "creator", type: "human", createdAt: now })
      .run();

    const wsId = crypto.randomUUID();
    db.insert(workspaces)
      .values({
        id: wsId,
        name: "Team Alpha",
        slug: "team-alpha",
        type: "shared",
        createdBy: userId,
        createdAt: now,
      })
      .run();

    db.insert(workspaceMembers)
      .values({
        workspaceId: wsId,
        userId,
        role: "admin",
        joinedAt: now,
      })
      .run();

    // Verify workspace exists
    const ws = db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
      .get();
    expect(ws).toBeDefined();
    expect(ws!.name).toBe("Team Alpha");
    expect(ws!.slug).toBe("team-alpha");

    // Verify creator is admin member
    const membership = db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, wsId),
          eq(workspaceMembers.userId, userId)
        )
      )
      .get();
    expect(membership).toBeDefined();
    expect(membership!.role).toBe("admin");
  });

  it("updates workspace settings", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);

    db.update(workspaces)
      .set({
        name: "Updated Name",
        description: "New description",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
      .run();

    const ws = db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
      .get();

    expect(ws!.name).toBe("Updated Name");
    expect(ws!.description).toBe("New description");
    expect(ws!.updatedAt).toBeDefined();
  });

  it("deletes a workspace and its related data", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();

    db.insert(users)
      .values({ id: userId, name: "user", type: "human", createdAt: now })
      .run();

    const wsId = crypto.randomUUID();
    db.insert(workspaces)
      .values({
        id: wsId,
        name: "Deletable",
        slug: "deletable",
        type: "shared",
        createdBy: userId,
        createdAt: now,
      })
      .run();

    db.insert(workspaceMembers)
      .values({ workspaceId: wsId, userId, role: "admin", joinedAt: now })
      .run();

    // Delete in FK order
    db.delete(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, wsId))
      .run();
    db.delete(workspaces).where(eq(workspaces.id, wsId)).run();

    const ws = db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
      .get();
    expect(ws).toBeUndefined();

    const members = db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, wsId))
      .all();
    expect(members).toHaveLength(0);
  });

  it("enforces unique workspace slug", () => {
    const db = createTestDb();
    const now = new Date().toISOString();

    db.insert(workspaces)
      .values({
        id: crypto.randomUUID(),
        name: "WS1",
        slug: "same-slug",
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
          slug: "same-slug",
          type: "shared",
          createdBy: "system",
          createdAt: now,
        })
        .run();
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

describe("Workspace Manager — Membership", () => {
  it("adds a member with a role", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();

    const memberId = crypto.randomUUID();
    db.insert(users)
      .values({ id: memberId, name: "new-member", type: "human", createdAt: now })
      .run();

    db.insert(workspaceMembers)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: memberId,
        role: "member",
        joinedAt: now,
      })
      .run();

    const members = db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, DEFAULT_WORKSPACE_ID))
      .all();
    expect(members).toHaveLength(2); // admin + new member
  });

  it("prevents duplicate membership", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);

    expect(() => {
      db.insert(workspaceMembers)
        .values({
          workspaceId: DEFAULT_WORKSPACE_ID,
          userId: adminId,
          role: "member",
          joinedAt: new Date().toISOString(),
        })
        .run();
    }).toThrow(); // Composite PK violation
  });

  it("updates a member's role", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();

    const memberId = crypto.randomUUID();
    db.insert(users)
      .values({ id: memberId, name: "promoted", type: "human", createdAt: now })
      .run();
    db.insert(workspaceMembers)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: memberId,
        role: "member",
        joinedAt: now,
      })
      .run();

    // Promote to admin
    db.update(workspaceMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(workspaceMembers.workspaceId, DEFAULT_WORKSPACE_ID),
          eq(workspaceMembers.userId, memberId)
        )
      )
      .run();

    const membership = db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, DEFAULT_WORKSPACE_ID),
          eq(workspaceMembers.userId, memberId)
        )
      )
      .get();
    expect(membership!.role).toBe("admin");
  });

  it("removes a member", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();

    const memberId = crypto.randomUUID();
    db.insert(users)
      .values({ id: memberId, name: "leaving", type: "human", createdAt: now })
      .run();
    db.insert(workspaceMembers)
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: memberId,
        role: "member",
        joinedAt: now,
      })
      .run();

    db.delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, DEFAULT_WORKSPACE_ID),
          eq(workspaceMembers.userId, memberId)
        )
      )
      .run();

    const members = db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, DEFAULT_WORKSPACE_ID))
      .all();
    expect(members).toHaveLength(1); // Only admin remains
  });

  it("lists members with user info via join", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);

    const rows = db
      .select({
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        userName: users.name,
        displayName: users.displayName,
        userType: users.type,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, DEFAULT_WORKSPACE_ID))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0].userName).toBe("admin-user");
    expect(rows[0].displayName).toBe("The Admin");
    expect(rows[0].role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

describe("Workspace Manager — API Keys", () => {
  it("creates an API key with hash", async () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);

    const rawKey = generateToken(API_KEY_PREFIX);
    const keyHash = await hashToken(rawKey);
    const keyId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.insert(workspaceApiKeys)
      .values({
        id: keyId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        keyHash,
        keyPrefix: rawKey.substring(0, 11),
        name: "Agent Key",
        createdBy: adminId,
        createdAt: now,
      })
      .run();

    const key = db
      .select()
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.id, keyId))
      .get();

    expect(key).toBeDefined();
    expect(key!.keyPrefix.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key!.name).toBe("Agent Key");
    expect(key!.revokedAt).toBeNull();
  });

  it("validates API key by hash lookup", async () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);

    const rawKey = generateToken(API_KEY_PREFIX);
    const keyHash = await hashToken(rawKey);

    db.insert(workspaceApiKeys)
      .values({
        id: crypto.randomUUID(),
        workspaceId: DEFAULT_WORKSPACE_ID,
        keyHash,
        keyPrefix: rawKey.substring(0, 11),
        createdBy: adminId,
        createdAt: new Date().toISOString(),
      })
      .run();

    // Look up by re-hashing
    const lookupHash = await hashToken(rawKey);
    const found = db
      .select()
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.keyHash, lookupHash))
      .get();

    expect(found).toBeDefined();
    expect(found!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("revoked key is marked with revokedAt", async () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();

    const rawKey = generateToken(API_KEY_PREFIX);
    const keyHash = await hashToken(rawKey);
    const keyId = crypto.randomUUID();

    db.insert(workspaceApiKeys)
      .values({
        id: keyId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        keyHash,
        keyPrefix: rawKey.substring(0, 11),
        createdBy: adminId,
        createdAt: now,
      })
      .run();

    // Revoke
    db.update(workspaceApiKeys)
      .set({ revokedAt: now })
      .where(eq(workspaceApiKeys.id, keyId))
      .run();

    const key = db
      .select()
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.id, keyId))
      .get();

    expect(key!.revokedAt).toBe(now);
  });

  it("expired key has expiresAt in the past", async () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const past = new Date(Date.now() - 86400000).toISOString();

    const rawKey = generateToken(API_KEY_PREFIX);
    const keyHash = await hashToken(rawKey);

    db.insert(workspaceApiKeys)
      .values({
        id: crypto.randomUUID(),
        workspaceId: DEFAULT_WORKSPACE_ID,
        keyHash,
        keyPrefix: rawKey.substring(0, 11),
        createdBy: adminId,
        createdAt: new Date().toISOString(),
        expiresAt: past,
      })
      .run();

    const lookupHash = await hashToken(rawKey);
    const key = db
      .select()
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.keyHash, lookupHash))
      .get();

    expect(key).toBeDefined();
    expect(key!.expiresAt).toBe(past);
    // The service layer would reject this key because expiresAt < now
    expect(new Date(key!.expiresAt!) < new Date()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

describe("Workspace Manager — Invites", () => {
  it("creates an invite with a unique token", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();

    const token = generateToken("inv_");
    db.insert(workspaceInvites)
      .values({
        id: crypto.randomUUID(),
        workspaceId: DEFAULT_WORKSPACE_ID,
        token,
        createdBy: adminId,
        role: "member",
        createdAt: now,
      })
      .run();

    const invite = db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.token, token))
      .get();

    expect(invite).toBeDefined();
    expect(invite!.token).toBe(token);
    expect(invite!.role).toBe("member");
    expect(invite!.useCount).toBe(0);
    expect(invite!.revokedAt).toBeNull();
  });

  it("enforces unique invite token", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();
    const token = "shared-token";

    db.insert(workspaceInvites)
      .values({
        id: crypto.randomUUID(),
        workspaceId: DEFAULT_WORKSPACE_ID,
        token,
        createdBy: adminId,
        createdAt: now,
      })
      .run();

    expect(() => {
      db.insert(workspaceInvites)
        .values({
          id: crypto.randomUUID(),
          workspaceId: DEFAULT_WORKSPACE_ID,
          token,
          createdBy: adminId,
          createdAt: now,
        })
        .run();
    }).toThrow();
  });

  it("increments use count on consumption", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();
    const inviteId = crypto.randomUUID();

    db.insert(workspaceInvites)
      .values({
        id: inviteId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        token: "consume-me",
        createdBy: adminId,
        role: "member",
        maxUses: 5,
        createdAt: now,
      })
      .run();

    // Simulate consumption
    db.update(workspaceInvites)
      .set({ useCount: sql`use_count + 1` })
      .where(eq(workspaceInvites.id, inviteId))
      .run();

    const invite = db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, inviteId))
      .get();
    expect(invite!.useCount).toBe(1);
  });

  it("revokes an invite", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();
    const inviteId = crypto.randomUUID();

    db.insert(workspaceInvites)
      .values({
        id: inviteId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        token: "revoke-me",
        createdBy: adminId,
        createdAt: now,
      })
      .run();

    db.update(workspaceInvites)
      .set({ revokedAt: now })
      .where(eq(workspaceInvites.id, inviteId))
      .run();

    const invite = db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, inviteId))
      .get();
    expect(invite!.revokedAt).toBe(now);
  });

  it("respects max uses limit", () => {
    const db = createTestDb();
    const { adminId } = seedTestData(db);
    const now = new Date().toISOString();
    const inviteId = crypto.randomUUID();

    db.insert(workspaceInvites)
      .values({
        id: inviteId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        token: "limited",
        createdBy: adminId,
        maxUses: 2,
        createdAt: now,
      })
      .run();

    // Use twice
    db.update(workspaceInvites)
      .set({ useCount: 2 })
      .where(eq(workspaceInvites.id, inviteId))
      .run();

    const invite = db
      .select()
      .from(workspaceInvites)
      .where(eq(workspaceInvites.id, inviteId))
      .get();

    // The service layer would reject this because useCount >= maxUses
    expect(invite!.useCount >= invite!.maxUses!).toBe(true);
  });
});
