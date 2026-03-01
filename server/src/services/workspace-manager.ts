/**
 * Workspace management service — CRUD, membership, API keys, invites.
 *
 * All functions operate on the database directly.
 * No auth checking here — that's the middleware's job.
 */

import { eq, and, sql, inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { DEFAULT_WORKSPACE_ID } from "../db/index";
import {
  workspaces,
  workspaceMembers,
  workspaceApiKeys,
  workspaceInvites,
  channels,
  channelMembers,
  messages,
  messageReactions,
  readReceipts,
  agents,
  sessions,
  users,
} from "../db/schema";
import {
  hashToken,
  generateToken,
  API_KEY_PREFIX,
} from "./auth-service";
import type {
  WorkspaceResponse,
  MemberResponse,
  ApiKeyResponse,
  ApiKeyCreatedResponse,
  InviteResponse,
} from "../types/index";

// ---------------------------------------------------------------------------
// Workspace CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new workspace.
 */
export async function createWorkspace(opts: {
  name: string;
  slug: string;
  type: string;
  description?: string;
  createdBy: string;
}): Promise<WorkspaceResponse> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(workspaces)
    .values({
      id,
      name: opts.name,
      slug: opts.slug,
      type: opts.type,
      description: opts.description ?? null,
      createdBy: opts.createdBy,
      createdAt: now,
    })
    .run();

  // Creator is automatically an admin member
  db.insert(workspaceMembers)
    .values({
      workspaceId: id,
      userId: opts.createdBy,
      role: "admin",
      joinedAt: now,
    })
    .run();

  return {
    id,
    name: opts.name,
    slug: opts.slug,
    type: opts.type,
    description: opts.description ?? null,
    created_by: opts.createdBy,
    created_at: now,
    member_count: 1,
  };
}

/**
 * Get a workspace by ID.
 */
export function getWorkspace(
  workspaceId: string
): WorkspaceResponse | null {
  const db = getDb();
  const ws = db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();

  if (!ws) return null;

  const memberCount = db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .get();

  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    type: ws.type,
    description: ws.description,
    created_by: ws.createdBy,
    created_at: ws.createdAt,
    member_count: Number(memberCount?.count ?? 0),
  };
}

/**
 * List workspaces a user is a member of.
 */
export function listWorkspacesForUser(
  userId: string
): WorkspaceResponse[] {
  const db = getDb();

  const memberships = db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .all();

  const wsIds = memberships.map((m) => m.workspaceId);
  if (wsIds.length === 0) return [];

  const results: WorkspaceResponse[] = [];
  for (const wsId of wsIds) {
    const ws = getWorkspace(wsId);
    if (ws) results.push(ws);
  }

  return results;
}

/**
 * Update workspace settings.
 */
export function updateWorkspace(
  workspaceId: string,
  updates: {
    name?: string;
    description?: string;
    onboardingPrompt?: string;
    humanWelcome?: string;
  }
): WorkspaceResponse | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();

  if (!existing) return null;

  db.update(workspaces)
    .set({
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.description !== undefined && {
        description: updates.description,
      }),
      ...(updates.onboardingPrompt !== undefined && {
        onboardingPrompt: updates.onboardingPrompt,
      }),
      ...(updates.humanWelcome !== undefined && {
        humanWelcome: updates.humanWelcome,
      }),
      updatedAt: now,
    })
    .where(eq(workspaces.id, workspaceId))
    .run();

  return getWorkspace(workspaceId);
}

/**
 * Delete a workspace and all its dependents. Cannot delete the default workspace.
 *
 * With CASCADE FKs this could be a single workspace delete, but we
 * do explicit deletes for clarity and to support older DBs without CASCADE.
 */
export function deleteWorkspace(
  workspaceId: string
): { error?: string } {
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    return { error: "Cannot delete the default workspace" };
  }

  const db = getDb();

  // Gather channel IDs in this workspace
  const wsChannels = db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.workspaceId, workspaceId))
    .all();
  const channelIds = wsChannels.map((c) => c.id);

  // Gather agent IDs in this workspace
  const wsAgents = db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .all();
  const agentIds = wsAgents.map((a) => a.id);

  // Delete in FK-safe order (children before parents)
  if (channelIds.length > 0) {
    db.delete(messageReactions)
      .where(
        inArray(
          messageReactions.messageId,
          db
            .select({ id: messages.id })
            .from(messages)
            .where(inArray(messages.channelId, channelIds))
        )
      )
      .run();
    db.delete(messages)
      .where(inArray(messages.channelId, channelIds))
      .run();
    db.delete(readReceipts)
      .where(inArray(readReceipts.channelId, channelIds))
      .run();
    db.delete(channelMembers)
      .where(inArray(channelMembers.channelId, channelIds))
      .run();
    db.delete(channels)
      .where(eq(channels.workspaceId, workspaceId))
      .run();
  }

  if (agentIds.length > 0) {
    db.delete(sessions)
      .where(inArray(sessions.agentId, agentIds))
      .run();
    db.delete(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .run();
  }

  db.delete(workspaceInvites)
    .where(eq(workspaceInvites.workspaceId, workspaceId))
    .run();
  db.delete(workspaceApiKeys)
    .where(eq(workspaceApiKeys.workspaceId, workspaceId))
    .run();
  db.delete(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .run();
  db.delete(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .run();

  return {};
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * List all members of a workspace.
 */
export function listMembers(workspaceId: string): MemberResponse[] {
  const db = getDb();

  const rows = db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      userName: users.name,
      displayName: users.displayName,
      userType: users.type,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .all();

  return rows.map((r) => ({
    user_id: r.userId,
    user_name: r.userName,
    display_name: r.displayName,
    user_type: r.userType,
    role: r.role,
    joined_at: r.joinedAt,
  }));
}

/**
 * Add a member to a workspace.
 */
export function addMember(
  workspaceId: string,
  userId: string,
  role: "admin" | "member" = "member"
): { error?: string } {
  const db = getDb();
  const now = new Date().toISOString();

  // Check user exists
  const user = db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!user) return { error: "User not found" };

  // Check not already a member
  const existing = db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .get();
  if (existing) return { error: "User is already a member" };

  db.insert(workspaceMembers)
    .values({ workspaceId, userId, role, joinedAt: now })
    .run();

  return {};
}

/**
 * Update a member's role.
 */
export function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: "admin" | "member"
): { error?: string } {
  const db = getDb();

  const existing = db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .get();

  if (!existing) return { error: "Member not found" };

  db.update(workspaceMembers)
    .set({ role })
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .run();

  return {};
}

/**
 * Remove a member from a workspace.
 * Cannot remove the last admin.
 */
export function removeMember(
  workspaceId: string,
  userId: string
): { error?: string } {
  const db = getDb();

  const existing = db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .get();

  if (!existing) return { error: "Member not found" };

  // Don't allow removing the last admin
  if (existing.role === "admin") {
    const adminCount = db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.role, "admin")
        )
      )
      .get();

    if (Number(adminCount?.count ?? 0) <= 1) {
      return { error: "Cannot remove the last admin" };
    }
  }

  db.delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .run();

  return {};
}

/**
 * Get a user's role in a workspace. Returns null if not a member.
 */
export function getMemberRole(
  workspaceId: string,
  userId: string
): "admin" | "member" | null {
  const db = getDb();
  const membership = db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .get();

  return (membership?.role as "admin" | "member") ?? null;
}

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

/**
 * Create a new API key for a workspace.
 * Returns the full key (only shown once) + the DB record.
 */
export async function createApiKey(opts: {
  workspaceId: string;
  name?: string;
  createdBy: string;
  expiresInDays?: number;
}): Promise<ApiKeyCreatedResponse> {
  const db = getDb();
  const id = crypto.randomUUID();
  const rawKey = generateToken(API_KEY_PREFIX);
  const keyHash = await hashToken(rawKey);
  const keyPrefix = rawKey.substring(0, 11); // "tk_" + first 8 hex chars
  const now = new Date().toISOString();

  const expiresAt = opts.expiresInDays
    ? new Date(
        Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000
      ).toISOString()
    : null;

  db.insert(workspaceApiKeys)
    .values({
      id,
      workspaceId: opts.workspaceId,
      keyHash,
      keyPrefix,
      name: opts.name ?? null,
      createdBy: opts.createdBy,
      createdAt: now,
      expiresAt,
    })
    .run();

  return {
    id,
    workspace_id: opts.workspaceId,
    key_prefix: keyPrefix,
    name: opts.name ?? null,
    created_by: opts.createdBy,
    created_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    last_used_at: null,
    raw_key: rawKey,
  };
}

/**
 * List API keys for a workspace (without hashes).
 */
export function listApiKeys(workspaceId: string): ApiKeyResponse[] {
  const db = getDb();
  const rows = db
    .select()
    .from(workspaceApiKeys)
    .where(eq(workspaceApiKeys.workspaceId, workspaceId))
    .all();

  return rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspaceId,
    key_prefix: r.keyPrefix,
    name: r.name,
    created_by: r.createdBy,
    created_at: r.createdAt,
    expires_at: r.expiresAt,
    revoked_at: r.revokedAt,
    last_used_at: r.lastUsedAt,
  }));
}

/**
 * Revoke an API key.
 */
export function revokeApiKey(
  keyId: string,
  workspaceId: string
): { error?: string } {
  const db = getDb();
  const now = new Date().toISOString();

  const key = db
    .select()
    .from(workspaceApiKeys)
    .where(
      and(
        eq(workspaceApiKeys.id, keyId),
        eq(workspaceApiKeys.workspaceId, workspaceId)
      )
    )
    .get();

  if (!key) return { error: "API key not found" };
  if (key.revokedAt) return { error: "API key already revoked" };

  db.update(workspaceApiKeys)
    .set({ revokedAt: now })
    .where(eq(workspaceApiKeys.id, keyId))
    .run();

  return {};
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/**
 * Create a workspace invite.
 */
export async function createInvite(opts: {
  workspaceId: string;
  createdBy: string;
  role?: "admin" | "member";
  maxUses?: number;
  expiresInDays?: number;
  baseUrl: string;
}): Promise<InviteResponse> {
  const db = getDb();
  const id = crypto.randomUUID();
  const token = generateToken("inv_");
  const now = new Date().toISOString();

  const expiresAt = opts.expiresInDays
    ? new Date(
        Date.now() + opts.expiresInDays * 24 * 60 * 60 * 1000
      ).toISOString()
    : null;

  db.insert(workspaceInvites)
    .values({
      id,
      workspaceId: opts.workspaceId,
      token,
      createdBy: opts.createdBy,
      role: opts.role ?? "member",
      maxUses: opts.maxUses ?? null,
      createdAt: now,
      expiresAt,
    })
    .run();

  return {
    id,
    workspace_id: opts.workspaceId,
    token,
    role: opts.role ?? "member",
    max_uses: opts.maxUses ?? null,
    use_count: 0,
    expires_at: expiresAt,
    created_at: now,
    revoked_at: null,
    invite_url: `${opts.baseUrl}/join/${token}`,
  };
}

/**
 * List invites for a workspace.
 */
export function listInvites(
  workspaceId: string,
  baseUrl: string
): InviteResponse[] {
  const db = getDb();
  const rows = db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.workspaceId, workspaceId))
    .all();

  return rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspaceId,
    token: r.token,
    role: r.role,
    max_uses: r.maxUses,
    use_count: r.useCount,
    expires_at: r.expiresAt,
    created_at: r.createdAt,
    revoked_at: r.revokedAt,
    invite_url: `${baseUrl}/join/${r.token}`,
  }));
}

/**
 * Revoke an invite.
 */
export function revokeInvite(
  inviteId: string,
  workspaceId: string
): { error?: string } {
  const db = getDb();
  const now = new Date().toISOString();

  const invite = db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.id, inviteId),
        eq(workspaceInvites.workspaceId, workspaceId)
      )
    )
    .get();

  if (!invite) return { error: "Invite not found" };
  if (invite.revokedAt) return { error: "Invite already revoked" };

  db.update(workspaceInvites)
    .set({ revokedAt: now })
    .where(eq(workspaceInvites.id, inviteId))
    .run();

  return {};
}

/**
 * Validate and consume an invite token.
 * Returns the invite details if valid, null otherwise.
 */
export function validateInvite(token: string): {
  workspaceId: string;
  role: string;
  inviteId: string;
} | null {
  const db = getDb();
  const now = new Date().toISOString();

  const invite = db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.token, token))
    .get();

  if (!invite) return null;
  if (invite.revokedAt) return null;
  if (invite.expiresAt && invite.expiresAt < now) return null;
  if (invite.maxUses && invite.useCount >= invite.maxUses) return null;

  // Increment use count
  db.update(workspaceInvites)
    .set({ useCount: invite.useCount + 1 })
    .where(eq(workspaceInvites.id, invite.id))
    .run();

  return {
    workspaceId: invite.workspaceId,
    role: invite.role,
    inviteId: invite.id,
  };
}
