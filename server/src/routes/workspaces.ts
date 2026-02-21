/**
 * Workspace routes — CRUD, members, API keys, invites.
 *
 * All endpoints are behind authMiddleware.
 * Admin-only endpoints use requireAdmin.
 */

import { Hono } from "hono";
import type { AppBindings } from "../types/index";
import {
  WorkspaceCreateSchema,
  WorkspaceUpdateSchema,
  ApiKeyCreateSchema,
  InviteCreateSchema,
  MemberUpdateSchema,
} from "../types/index";
import { requireAdmin, requireUser } from "../middleware/auth";
import {
  createWorkspace,
  getWorkspace,
  listWorkspacesForUser,
  updateWorkspace,
  deleteWorkspace,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  createInvite,
  listInvites,
  revokeInvite,
} from "../services/workspace-manager";
import { config } from "../lib/config";

const app = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

/** GET / — list workspaces for the current user. */
app.get("/", requireUser, (c) => {
  const auth = c.get("auth");
  const workspaces = listWorkspacesForUser(auth.userId!);
  return c.json(workspaces);
});

/** POST / — create a new workspace. */
app.post("/", requireUser, async (c) => {
  const auth = c.get("auth");
  const body = await c.req.json();
  const parsed = WorkspaceCreateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  try {
    const ws = await createWorkspace({
      name: parsed.data.name,
      slug: parsed.data.slug,
      type: parsed.data.type,
      description: parsed.data.description,
      createdBy: auth.userId!,
    });
    return c.json(ws, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create workspace";
    // SQLite unique constraint
    if (msg.includes("UNIQUE constraint")) {
      return c.json({ error: "Workspace name or slug already exists" }, 409);
    }
    return c.json({ error: msg }, 500);
  }
});

/** GET /:workspaceId — get workspace details. */
app.get("/:workspaceId", (c) => {
  const workspaceId = c.req.param("workspaceId");
  const ws = getWorkspace(workspaceId);

  if (!ws) return c.json({ error: "Workspace not found" }, 404);
  return c.json(ws);
});

/** PATCH /:workspaceId — update workspace settings (admin only). */
app.patch("/:workspaceId", requireAdmin, async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const auth = c.get("auth");

  // Ensure the admin is modifying their own workspace
  if (auth.workspaceId !== workspaceId && auth.role !== "admin") {
    return c.json({ error: "Not authorized for this workspace" }, 403);
  }

  const body = await c.req.json();
  const parsed = WorkspaceUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const ws = updateWorkspace(workspaceId, {
    name: parsed.data.name,
    description: parsed.data.description,
    onboardingPrompt: parsed.data.onboarding_prompt,
    humanWelcome: parsed.data.human_welcome,
  });

  if (!ws) return c.json({ error: "Workspace not found" }, 404);
  return c.json(ws);
});

/** DELETE /:workspaceId — delete workspace (admin only). */
app.delete("/:workspaceId", requireAdmin, (c) => {
  const workspaceId = c.req.param("workspaceId");
  const result = deleteWorkspace(workspaceId);

  if (result.error) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** GET /:workspaceId/members — list workspace members. */
app.get("/:workspaceId/members", (c) => {
  const workspaceId = c.req.param("workspaceId");
  const members = listMembers(workspaceId);
  return c.json(members);
});

/** POST /:workspaceId/members — add a member (admin only). */
app.post("/:workspaceId/members", requireAdmin, async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const body = await c.req.json();

  const userId = body.user_id;
  const role = body.role ?? "member";

  if (!userId) return c.json({ error: "user_id is required" }, 400);

  const result = addMember(workspaceId, userId, role);
  if (result.error) return c.json({ error: result.error }, 400);

  return c.json({ ok: true }, 201);
});

/** PATCH /:workspaceId/members/:userId — update member role (admin only). */
app.patch("/:workspaceId/members/:userId", requireAdmin, async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const userId = c.req.param("userId");

  const body = await c.req.json();
  const parsed = MemberUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const result = updateMemberRole(workspaceId, userId, parsed.data.role);
  if (result.error) return c.json({ error: result.error }, 404);

  return c.json({ ok: true });
});

/** DELETE /:workspaceId/members/:userId — remove member (admin only). */
app.delete("/:workspaceId/members/:userId", requireAdmin, (c) => {
  const workspaceId = c.req.param("workspaceId");
  const userId = c.req.param("userId");

  const result = removeMember(workspaceId, userId);
  if (result.error) return c.json({ error: result.error }, 400);

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

/** GET /:workspaceId/keys — list API keys (admin only). */
app.get("/:workspaceId/keys", requireAdmin, (c) => {
  const workspaceId = c.req.param("workspaceId");
  const keys = listApiKeys(workspaceId);
  return c.json(keys);
});

/** POST /:workspaceId/keys — create API key (admin only). */
app.post("/:workspaceId/keys", requireAdmin, async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const auth = c.get("auth");

  const body = await c.req.json().catch(() => ({}));
  const parsed = ApiKeyCreateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const key = await createApiKey({
    workspaceId,
    name: parsed.data.name,
    createdBy: auth.userId!,
    expiresInDays: parsed.data.expires_in_days,
  });

  return c.json(key, 201);
});

/** DELETE /:workspaceId/keys/:keyId — revoke API key (admin only). */
app.delete("/:workspaceId/keys/:keyId", requireAdmin, (c) => {
  const workspaceId = c.req.param("workspaceId");
  const keyId = c.req.param("keyId");

  const result = revokeApiKey(keyId, workspaceId);
  if (result.error) return c.json({ error: result.error }, 400);

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/** GET /:workspaceId/invites — list invites (admin only). */
app.get("/:workspaceId/invites", requireAdmin, (c) => {
  const workspaceId = c.req.param("workspaceId");
  const invites = listInvites(workspaceId, config.baseUrl);
  return c.json(invites);
});

/** POST /:workspaceId/invites — create invite (admin only). */
app.post("/:workspaceId/invites", requireAdmin, async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const auth = c.get("auth");

  const body = await c.req.json().catch(() => ({}));
  const parsed = InviteCreateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const invite = await createInvite({
    workspaceId,
    createdBy: auth.userId!,
    role: parsed.data.role,
    maxUses: parsed.data.max_uses,
    expiresInDays: parsed.data.expires_in_days,
    baseUrl: config.baseUrl,
  });

  return c.json(invite, 201);
});

/** DELETE /:workspaceId/invites/:inviteId — revoke invite (admin only). */
app.delete("/:workspaceId/invites/:inviteId", requireAdmin, (c) => {
  const workspaceId = c.req.param("workspaceId");
  const inviteId = c.req.param("inviteId");

  const result = revokeInvite(inviteId, workspaceId);
  if (result.error) return c.json({ error: result.error }, 400);

  return c.json({ ok: true });
});

export default app;
