/** HTTP API client for TalkTo backend.
 *
 * All endpoints are relative — Vite's proxy routes /api to :15377.
 */
import type { Agent, Channel, Feature, Message, User, UserOnboardPayload } from "./types";

const BASE = "/api";

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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
) {
  return request<Message>(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, mentions }),
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
