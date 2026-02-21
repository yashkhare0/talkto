/**
 * Auth service tests — token hashing, session CRUD, API key validation.
 *
 * Uses in-memory database via createTestDb().
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, DEFAULT_WORKSPACE_ID } from "./setup";
import {
  users,
  workspaces,
  workspaceMembers,
  workspaceApiKeys,
  userSessions,
} from "../src/db/schema";

// We need to mock getDb() to return our test DB
// Since the auth service uses getDb() directly, we'll test the pure functions
// and test the DB-dependent functions via the workspace-manager tests.

import {
  hashToken,
  generateToken,
  extractSessionToken,
  buildSessionCookie,
  buildClearSessionCookie,
  isLocalhost,
  API_KEY_PREFIX,
  SESSION_COOKIE_NAME,
} from "../src/services/auth-service";

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("Auth Service — Token Hashing", () => {
  it("produces a consistent SHA-256 hash", async () => {
    const hash1 = await hashToken("test-token-123");
    const hash2 = await hashToken("test-token-123");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // 32 bytes = 64 hex chars
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await hashToken("token-a");
    const hash2 = await hashToken("token-b");
    expect(hash1).not.toBe(hash2);
  });

  it("produces a hex string", async () => {
    const hash = await hashToken("anything");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Auth Service — Token Generation", () => {
  it("generates a random hex string", () => {
    const token = generateToken();
    expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("generates with prefix", () => {
    const token = generateToken("tk_");
    expect(token.startsWith("tk_")).toBe(true);
    expect(token).toHaveLength(67); // 3 (prefix) + 64 (hex)
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken());
    }
    expect(tokens.size).toBe(100);
  });

  it("API_KEY_PREFIX is tk_", () => {
    expect(API_KEY_PREFIX).toBe("tk_");
  });
});

describe("Auth Service — Cookie Parsing", () => {
  it("extracts session token from cookie header", () => {
    const token = extractSessionToken(
      `${SESSION_COOKIE_NAME}=ses_abc123; other_cookie=value`
    );
    expect(token).toBe("ses_abc123");
  });

  it("returns null when cookie header is undefined", () => {
    expect(extractSessionToken(undefined)).toBeNull();
  });

  it("returns null when session cookie is not present", () => {
    expect(extractSessionToken("other_cookie=value")).toBeNull();
  });

  it("handles cookie with equals sign in value", () => {
    const token = extractSessionToken(
      `${SESSION_COOKIE_NAME}=ses_abc=123=`
    );
    expect(token).toBe("ses_abc=123=");
  });

  it("handles multiple cookies", () => {
    const token = extractSessionToken(
      `a=1; ${SESSION_COOKIE_NAME}=mytoken; b=2`
    );
    expect(token).toBe("mytoken");
  });
});

describe("Auth Service — Cookie Building", () => {
  it("builds a valid Set-Cookie header", () => {
    const cookie = buildSessionCookie(
      "ses_abc123",
      "2026-03-21T00:00:00.000Z"
    );
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=ses_abc123`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Expires=");
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure flag when requested", () => {
    const cookie = buildSessionCookie(
      "ses_abc123",
      "2026-03-21T00:00:00.000Z",
      true
    );
    expect(cookie).toContain("Secure");
  });

  it("builds a clear cookie header", () => {
    const cookie = buildClearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("Auth Service — Localhost Detection", () => {
  it("detects 127.0.0.1 as localhost", () => {
    expect(isLocalhost("127.0.0.1")).toBe(true);
  });

  it("detects ::1 as localhost", () => {
    expect(isLocalhost("::1")).toBe(true);
  });

  it("detects ::ffff:127.0.0.1 as localhost", () => {
    expect(isLocalhost("::ffff:127.0.0.1")).toBe(true);
  });

  it("detects 'localhost' as localhost", () => {
    expect(isLocalhost("localhost")).toBe(true);
  });

  it("returns true for undefined (test/unknown environment)", () => {
    expect(isLocalhost(undefined)).toBe(true);
  });

  it("returns false for external IPs", () => {
    expect(isLocalhost("192.168.1.100")).toBe(false);
    expect(isLocalhost("10.0.0.1")).toBe(false);
    expect(isLocalhost("8.8.8.8")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB-dependent functions (tested via direct DB manipulation)
// ---------------------------------------------------------------------------

describe("Auth Service — Session CRUD (direct DB)", () => {
  it("session tokens hash correctly for DB lookup", async () => {
    const db = createTestDb();

    // Seed workspace
    db.insert(workspaces)
      .values({
        id: DEFAULT_WORKSPACE_ID,
        name: "Default",
        slug: "default",
        type: "personal",
        createdBy: "system",
        createdAt: new Date().toISOString(),
      })
      .run();

    // Seed user
    const userId = crypto.randomUUID();
    db.insert(users)
      .values({
        id: userId,
        name: "test-human",
        type: "human",
        createdAt: new Date().toISOString(),
      })
      .run();

    // Simulate creating a session (what createSession does)
    const rawToken = generateToken("ses_");
    const tokenHash = await hashToken(rawToken);
    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 86400000).toISOString();

    db.insert(userSessions)
      .values({
        id: sessionId,
        userId,
        tokenHash,
        workspaceId: DEFAULT_WORKSPACE_ID,
        createdAt: now,
        expiresAt,
      })
      .run();

    // Verify we can look it up by hashing the raw token again
    const lookupHash = await hashToken(rawToken);
    const session = db
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, lookupHash))
      .get();

    expect(session).toBeDefined();
    expect(session!.userId).toBe(userId);
    expect(session!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("API key tokens hash correctly for DB lookup", async () => {
    const db = createTestDb();

    // Seed workspace + user
    db.insert(workspaces)
      .values({
        id: DEFAULT_WORKSPACE_ID,
        name: "Default",
        slug: "default",
        type: "personal",
        createdBy: "system",
        createdAt: new Date().toISOString(),
      })
      .run();

    const userId = crypto.randomUUID();
    db.insert(users)
      .values({
        id: userId,
        name: "admin",
        type: "human",
        createdAt: new Date().toISOString(),
      })
      .run();

    // Simulate creating an API key
    const rawKey = generateToken(API_KEY_PREFIX);
    const keyHash = await hashToken(rawKey);
    const keyId = crypto.randomUUID();

    db.insert(workspaceApiKeys)
      .values({
        id: keyId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        keyHash,
        keyPrefix: rawKey.substring(0, 11),
        name: "Test Key",
        createdBy: userId,
        createdAt: new Date().toISOString(),
      })
      .run();

    // Verify lookup by re-hashing the raw key
    const lookupHash = await hashToken(rawKey);
    const key = db
      .select()
      .from(workspaceApiKeys)
      .where(eq(workspaceApiKeys.keyHash, lookupHash))
      .get();

    expect(key).toBeDefined();
    expect(key!.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
    expect(key!.name).toBe("Test Key");
    expect(rawKey.startsWith(API_KEY_PREFIX)).toBe(true);
  });
});
