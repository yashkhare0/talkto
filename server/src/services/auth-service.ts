/**
 * Authentication service — session tokens, API key hashing, and validation.
 *
 * Handles three auth paths:
 * 1. Session cookies (human browser access)
 * 2. API keys (agent MCP connections)
 * 3. Localhost bypass (default workspace, no auth)
 */

import { eq, and, gt } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  userSessions,
  workspaceApiKeys,
  users,
} from "../db/schema";
import type { AuthContext } from "../types/index";
import { DEFAULT_WORKSPACE_ID } from "../db/index";

/** Default session TTL: 30 days. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** API key prefix for identification. */
export const API_KEY_PREFIX = "tk_";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash a string. Used for both session tokens and API keys.
 * Returns a hex-encoded hash.
 */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a cryptographically random token string.
 * Format: `{prefix}{random_hex}` (e.g., "tk_a1b2c3d4e5f6...")
 */
export function generateToken(prefix: string = ""): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${hex}`;
}

// ---------------------------------------------------------------------------
// Session tokens (human browser sessions)
// ---------------------------------------------------------------------------

/**
 * Create a new browser session for a human user.
 * Returns the raw session token (to be set as HTTP-only cookie).
 */
export async function createSession(
  userId: string,
  workspaceId: string,
  ttlMs: number = SESSION_TTL_MS
): Promise<{ sessionId: string; token: string; expiresAt: string }> {
  const db = getDb();
  const sessionId = crypto.randomUUID();
  const token = generateToken("ses_");
  const tokenHash = await hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  db.insert(userSessions)
    .values({
      id: sessionId,
      userId,
      tokenHash,
      workspaceId,
      createdAt: now.toISOString(),
      expiresAt,
    })
    .run();

  return { sessionId, token, expiresAt };
}

/**
 * Validate a session token from a cookie.
 * Returns the auth context if valid, null if invalid/expired.
 */
export async function validateSession(
  token: string
): Promise<AuthContext | null> {
  const db = getDb();
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();

  const session = db
    .select()
    .from(userSessions)
    .where(
      and(
        eq(userSessions.tokenHash, tokenHash),
        gt(userSessions.expiresAt, now)
      )
    )
    .get();

  if (!session) return null;

  // Update last_active_at
  db.update(userSessions)
    .set({ lastActiveAt: now })
    .where(eq(userSessions.id, session.id))
    .run();

  // Look up workspace membership for role
  const { workspaceMembers } = await import("../db/schema");
  const membership = db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, session.workspaceId),
        eq(workspaceMembers.userId, session.userId)
      )
    )
    .get();

  return {
    userId: session.userId,
    workspaceId: session.workspaceId,
    role: (membership?.role as "admin" | "member") ?? "none",
    authMethod: "session",
  };
}

/**
 * Delete a session (logout).
 */
export async function deleteSession(token: string): Promise<void> {
  const db = getDb();
  const tokenHash = await hashToken(token);
  db.delete(userSessions)
    .where(eq(userSessions.tokenHash, tokenHash))
    .run();
}

/**
 * Delete all sessions for a user in a workspace.
 */
export function deleteUserSessions(
  userId: string,
  workspaceId: string
): void {
  const db = getDb();
  db.delete(userSessions)
    .where(
      and(
        eq(userSessions.userId, userId),
        eq(userSessions.workspaceId, workspaceId)
      )
    )
    .run();
}

// ---------------------------------------------------------------------------
// API keys (agent MCP connections)
// ---------------------------------------------------------------------------

/**
 * Validate an API key from the Authorization header.
 * Returns the workspace ID if valid, null if invalid/revoked/expired.
 */
export async function validateApiKey(
  rawKey: string
): Promise<{ workspaceId: string } | null> {
  const db = getDb();
  const keyHash = await hashToken(rawKey);
  const now = new Date().toISOString();

  const key = db
    .select()
    .from(workspaceApiKeys)
    .where(eq(workspaceApiKeys.keyHash, keyHash))
    .get();

  if (!key) return null;

  // Check revocation
  if (key.revokedAt) return null;

  // Check expiry
  if (key.expiresAt && key.expiresAt < now) return null;

  // Update last_used_at
  db.update(workspaceApiKeys)
    .set({ lastUsedAt: now })
    .where(eq(workspaceApiKeys.id, key.id))
    .run();

  return { workspaceId: key.workspaceId };
}

// ---------------------------------------------------------------------------
// Localhost detection
// ---------------------------------------------------------------------------

/** IPs considered "localhost" for auth bypass. */
const LOCALHOST_IPS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
]);

/**
 * Check if a request originates from localhost.
 * Uses the request's remote address (from Bun's server info).
 */
export function isLocalhost(remoteAddr: string | undefined): boolean {
  if (!remoteAddr) return true; // In tests or when address is unavailable, assume local
  return LOCALHOST_IPS.has(remoteAddr);
}

/**
 * Build an auth context for unauthenticated localhost access
 * to the default workspace.
 */
export async function getLocalhostAuth(): Promise<AuthContext> {
  const db = getDb();

  // Find the local human user (if onboarded)
  const human = db
    .select()
    .from(users)
    .where(eq(users.type, "human"))
    .get();

  return {
    userId: human?.id ?? null,
    workspaceId: DEFAULT_WORKSPACE_ID,
    role: human ? "admin" : "none",
    authMethod: "localhost",
  };
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/** Name of the session cookie. */
export const SESSION_COOKIE_NAME = "talkto_session";

/**
 * Parse a cookie header string and extract the session token.
 */
export function extractSessionToken(
  cookieHeader: string | undefined
): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split("=");
    if (name === SESSION_COOKIE_NAME) {
      return valueParts.join("="); // Rejoin in case value contains =
    }
  }
  return null;
}

/**
 * Build a Set-Cookie header value for the session token.
 */
export function buildSessionCookie(
  token: string,
  expiresAt: string,
  secure: boolean = false
): string {
  const expires = new Date(expiresAt).toUTCString();
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Expires=${expires}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Build a Set-Cookie header to clear the session cookie.
 */
export function buildClearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
