/**
 * Auth routes — session management, current user, invite acceptance.
 *
 * GET  /me           — get current authenticated user + workspace context
 * POST /logout       — clear session cookie
 * POST /join/:token  — accept an invite and create a session
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import type { AppBindings } from "../types/index";
import { getDb } from "../db/index";
import { users, workspaceMembers } from "../db/schema";
import {
  createSession,
  deleteSession,
  extractSessionToken,
  buildSessionCookie,
  buildClearSessionCookie,
  SESSION_COOKIE_NAME,
} from "../services/auth-service";
import { validateInvite, getMemberRole } from "../services/workspace-manager";

const app = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// GET /me — current user context
// ---------------------------------------------------------------------------

app.get("/me", (c) => {
  const auth = c.get("auth");

  if (!auth.userId) {
    return c.json({
      authenticated: false,
      workspace_id: auth.workspaceId,
      auth_method: auth.authMethod,
    });
  }

  const db = getDb();
  const user = db
    .select()
    .from(users)
    .where(eq(users.id, auth.userId))
    .get();

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      display_name: user.displayName,
      type: user.type,
      email: user.email,
      avatar_url: user.avatarUrl,
    },
    workspace_id: auth.workspaceId,
    role: auth.role,
    auth_method: auth.authMethod,
  });
});

// ---------------------------------------------------------------------------
// POST /logout — clear session
// ---------------------------------------------------------------------------

app.post("/logout", async (c) => {
  const cookieHeader = c.req.header("Cookie");
  const sessionToken = extractSessionToken(cookieHeader);

  if (sessionToken) {
    await deleteSession(sessionToken);
  }

  c.header("Set-Cookie", buildClearSessionCookie());
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /join/:token — accept an invite
// ---------------------------------------------------------------------------

const JoinSchema = z.object({
  name: z.string().min(1).max(100),
  display_name: z.string().max(100).optional(),
  email: z.string().email().optional(),
});

app.post("/join/:token", async (c) => {
  const token = c.req.param("token");

  // Validate the invite token
  const invite = validateInvite(token);
  if (!invite) {
    return c.json(
      { error: "Invalid, expired, or fully used invite" },
      400
    );
  }

  const body = await c.req.json();
  const parsed = JoinSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Check if user with this email already exists
  let userId: string;
  let isNewUser = false;

  if (parsed.data.email) {
    const existing = db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .get();

    if (existing) {
      userId = existing.id;
    } else {
      userId = crypto.randomUUID();
      isNewUser = true;
    }
  } else {
    userId = crypto.randomUUID();
    isNewUser = true;
  }

  // Create the user if new
  if (isNewUser) {
    db.insert(users)
      .values({
        id: userId,
        name: parsed.data.name,
        type: "human",
        createdAt: now,
        displayName: parsed.data.display_name ?? null,
        email: parsed.data.email ?? null,
      })
      .run();
  }

  // Check if already a member of this workspace
  const existingMembership = db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, invite.workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .get();

  if (!existingMembership) {
    db.insert(workspaceMembers)
      .values({
        workspaceId: invite.workspaceId,
        userId,
        role: invite.role,
        joinedAt: now,
      })
      .run();
  }

  // Create a session
  const session = await createSession(userId, invite.workspaceId);

  // Set session cookie
  c.header("Set-Cookie", buildSessionCookie(session.token, session.expiresAt));

  return c.json({
    ok: true,
    user_id: userId,
    workspace_id: invite.workspaceId,
    role: invite.role,
    is_new_user: isNewUser,
  }, 201);
});

export default app;
