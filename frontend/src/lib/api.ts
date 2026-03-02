/** HTTP API client for TalkTo backend.
 *
 * All endpoints are relative — Vite's proxy routes /api to :15377.
 */
import type { Agent, ApiKey, ApiKeyCreated, AuthInfo, Channel, Feature, Invite, JoinResult, Message, User, UserOnboardPayload, Workspace, WorkspaceMember } from "./types";

const BASE = "/api";

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Users ──────────────────────────────────────────────

export function onboardUser(data: UserOnboardPayload) {
  return request<User>("/users/onboard", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function getMe() {
  return request<User>("/users/me");
}

export function updateProfile(data: UserOnboardPayload) {
  return request<User>("/users/me", {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteProfile() {
  return request<void>("/users/me", { method: "DELETE" });
}

// ── Channels ───────────────────────────────────────────

export function listChannels() {
  return request<Channel[]>("/channels");
}

export function createChannel(name: string) {
  return request<Channel>("/channels", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

// ── Unread ─────────────────────────────────────────────

export interface UnreadCount {
  channel_id: string;
  channel_name: string;
  unread_count: number;
  last_read_at: string | null;
}

export function getUnreadCounts() {
  return request<UnreadCount[]>("/channels/unread/counts");
}

export function markChannelRead(channelId: string) {
  return request<{ channel_id: string; user_id: string; last_read_at: string }>(
    `/channels/${channelId}/read`,
    { method: "POST" },
  );
}

// ── Messages ───────────────────────────────────────────

export function getMessages(
  channelId: string,
  params?: { limit?: number; before?: string },
) {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.before) qs.set("before", params.before);
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return request<Message[]>(`/channels/${channelId}/messages${query}`);
}

export function sendMessage(
  channelId: string,
  content: string,
  mentions?: string[],
  parentId?: string,
) {
  return request<Message>(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, mentions, parent_id: parentId }),
  });
}

export interface SearchResult {
  id: string;
  channel_id: string;
  channel_name: string;
  sender_id: string;
  sender_name: string;
  sender_type: string;
  content: string;
  mentions: string[] | null;
  parent_id: string | null;
  created_at: string;
}

export function searchMessages(query: string, channel?: string, limit?: number) {
  const params = new URLSearchParams({ q: query });
  if (channel) params.set("channel", channel);
  if (limit) params.set("limit", String(limit));
  return request<{ query: string; results: SearchResult[]; count: number }>(
    `/search?${params}`,
  );
}

export function editMessage(channelId: string, messageId: string, content: string) {
  return request<{ id: string; content: string; edited_at: string }>(
    `/channels/${channelId}/messages/${messageId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ content }),
    },
  );
}

export function reactToMessage(channelId: string, messageId: string, emoji: string) {
  return request<{ action: string; emoji: string }>(
    `/channels/${channelId}/messages/${messageId}/react`,
    {
      method: "POST",
      body: JSON.stringify({ emoji }),
    },
  );
}

export function deleteMessage(channelId: string, messageId: string) {
  return request<{ deleted: boolean; id: string }>(
    `/channels/${channelId}/messages/${messageId}`,
    { method: "DELETE" },
  );
}

export function pinMessage(channelId: string, messageId: string) {
  return request<{ id: string; is_pinned: boolean; pinned_at: string | null }>(
    `/channels/${channelId}/messages/${messageId}/pin`,
    { method: "POST" },
  );
}

// ── Agents ─────────────────────────────────────────────

export function listAgents() {
  return request<Agent[]>("/agents");
}

export function getOrCreateDM(agentName: string) {
  return request<Channel>(`/agents/${agentName}/dm`, { method: "POST" });
}

// ── Features ───────────────────────────────────────────

export function listFeatures(status?: string) {
  const qs = status ? `?status=${status}` : "";
  return request<Feature[]>(`/features${qs}`);
}

export function createFeature(title: string, description: string) {
  return request<Feature>("/features", {
    method: "POST",
    body: JSON.stringify({ title, description }),
  });
}

export function voteFeature(featureId: string, vote: 1 | -1) {
  return request<{ status: string; vote: number }>(
    `/features/${featureId}/vote`,
    { method: "POST", body: JSON.stringify({ vote }) },
  );
}

export function updateFeature(featureId: string, status: string, reason?: string) {
  return request<Feature>(`/features/${featureId}`, {
    method: "PATCH",
    body: JSON.stringify({ status, reason }),
  });
}

export function deleteFeature(featureId: string) {
  return request<{ deleted: boolean; id: string }>(`/features/${featureId}`, {
    method: "DELETE",
  });
}

// ── Auth ────────────────────────────────────────────────

export function getAuthMe() {
  return request<AuthInfo>("/auth/me");
}

export function logout() {
  return request<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

export function joinWorkspace(token: string, data: { name: string; display_name?: string; email?: string }) {
  return request<JoinResult>(`/auth/join/${token}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ── Workspaces ──────────────────────────────────────────

export function listWorkspaces() {
  return request<Workspace[]>("/workspaces");
}

export function createWorkspace(data: { name: string; slug: string; type?: string; description?: string }) {
  return request<Workspace>("/workspaces", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function getWorkspace(workspaceId: string) {
  return request<Workspace>(`/workspaces/${workspaceId}`);
}

export function updateWorkspace(workspaceId: string, data: { name?: string; description?: string; onboarding_prompt?: string; human_welcome?: string }) {
  return request<Workspace>(`/workspaces/${workspaceId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export function deleteWorkspace(workspaceId: string) {
  return request<{ ok: boolean }>(`/workspaces/${workspaceId}`, { method: "DELETE" });
}

// ── Workspace Members ───────────────────────────────────

export function listMembers(workspaceId: string) {
  return request<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
}

export function updateMemberRole(workspaceId: string, userId: string, role: "admin" | "member") {
  return request<{ ok: boolean }>(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export function removeMember(workspaceId: string, userId: string) {
  return request<{ ok: boolean }>(`/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" });
}

// ── API Keys ────────────────────────────────────────────

export function listApiKeys(workspaceId: string) {
  return request<ApiKey[]>(`/workspaces/${workspaceId}/keys`);
}

export function createApiKey(workspaceId: string, data?: { name?: string; expires_in_days?: number }) {
  return request<ApiKeyCreated>(`/workspaces/${workspaceId}/keys`, {
    method: "POST",
    body: JSON.stringify(data ?? {}),
  });
}

export function revokeApiKey(workspaceId: string, keyId: string) {
  return request<{ ok: boolean }>(`/workspaces/${workspaceId}/keys/${keyId}`, { method: "DELETE" });
}

// ── Invites ─────────────────────────────────────────────

export function listInvites(workspaceId: string) {
  return request<Invite[]>(`/workspaces/${workspaceId}/invites`);
}

export function createInvite(workspaceId: string, data?: { role?: string; max_uses?: number; expires_in_days?: number }) {
  return request<Invite>(`/workspaces/${workspaceId}/invites`, {
    method: "POST",
    body: JSON.stringify(data ?? {}),
  });
}

export function revokeInvite(workspaceId: string, inviteId: string) {
  return request<{ ok: boolean }>(`/workspaces/${workspaceId}/invites/${inviteId}`, { method: "DELETE" });
}
