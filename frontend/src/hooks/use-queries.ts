/** TanStack Query hooks for all API endpoints. */
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import * as api from "@/lib/api";

// ── Keys ───────────────────────────────────────────────

export const queryKeys = {
  me: ["me"] as const,
  authMe: ["auth", "me"] as const,
  channels: ["channels"] as const,
  agents: ["agents"] as const,
  features: (status?: string) => ["features", status] as const,
  messages: (channelId: string) => ["messages", channelId] as const,
  workspaces: ["workspaces"] as const,
  workspace: (id: string) => ["workspace", id] as const,
  members: (workspaceId: string) => ["workspace", workspaceId, "members"] as const,
  apiKeys: (workspaceId: string) => ["workspace", workspaceId, "keys"] as const,
  invites: (workspaceId: string) => ["workspace", workspaceId, "invites"] as const,
};

// ── User ───────────────────────────────────────────────

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: api.getMe,
    retry: false,
    staleTime: Infinity,
  });
}

export function useOnboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import("@/lib/types").UserOnboardPayload) =>
      api.onboardUser(data),
    onSuccess: (user) => {
      qc.setQueryData(queryKeys.me, user);
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import("@/lib/types").UserOnboardPayload) =>
      api.updateProfile(data),
    onSuccess: (user) => {
      qc.setQueryData(queryKeys.me, user);
    },
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteProfile(),
    onSuccess: () => {
      qc.setQueryData(queryKeys.me, undefined);
      qc.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

// ── Channels ───────────────────────────────────────────

export function useChannels() {
  return useQuery({
    queryKey: queryKeys.channels,
    queryFn: api.listChannels,
    staleTime: 30_000,
  });
}

// ── Messages ───────────────────────────────────────────

export function useMessages(channelId: string | null) {
  return useQuery({
    queryKey: queryKeys.messages(channelId ?? ""),
    queryFn: () => api.getMessages(channelId!, { limit: 50 }),
    enabled: !!channelId,
    staleTime: 5_000,
  });
}

// ── Agents ─────────────────────────────────────────────

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents,
    queryFn: api.listAgents,
    staleTime: 10_000,
    refetchInterval: 30_000, // Poll for agent status changes
  });
}

// ── DMs ────────────────────────────────────────────────

export function useOpenDM() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentName: string) => api.getOrCreateDM(agentName),
    onSuccess: () => {
      // Refetch channels so the DM shows up in WebSocket subscriptions
      qc.invalidateQueries({ queryKey: queryKeys.channels });
    },
  });
}

// ── Features ───────────────────────────────────────────

export function useFeatures(status?: string) {
  return useQuery({
    queryKey: queryKeys.features(status),
    queryFn: () => api.listFeatures(status),
    staleTime: 15_000,
  });
}

export function useCreateFeature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ title, description }: { title: string; description: string }) =>
      api.createFeature(title, description),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["features"] });
    },
  });
}

export function useVoteFeature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ featureId, vote }: { featureId: string; vote: 1 | -1 }) =>
      api.voteFeature(featureId, vote),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["features"] });
    },
  });
}

export function useUpdateFeature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ featureId, status, reason }: { featureId: string; status: string; reason?: string }) =>
      api.updateFeature(featureId, status, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["features"] });
    },
  });
}

export function useDeleteFeature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ featureId }: { featureId: string }) =>
      api.deleteFeature(featureId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["features"] });
    },
  });
}

// ── Send Message ───────────────────────────────────────

export function useSendMessage() {
  return useMutation({
    mutationFn: ({
      channelId,
      content,
      mentions,
      parentId,
    }: {
      channelId: string;
      content: string;
      mentions?: string[];
      parentId?: string;
    }) => api.sendMessage(channelId, content, mentions, parentId),
    // Don't invalidate — WebSocket will push the new message
  });
}

// ── Edit Message ───────────────────────────────────────

export function useEditMessage() {
  return useMutation({
    mutationFn: ({
      channelId,
      messageId,
      content,
    }: {
      channelId: string;
      messageId: string;
      content: string;
    }) => api.editMessage(channelId, messageId, content),
  });
}

// ── React to Message ───────────────────────────────────

export function useReactToMessage() {
  return useMutation({
    mutationFn: ({
      channelId,
      messageId,
      emoji,
    }: {
      channelId: string;
      messageId: string;
      emoji: string;
    }) => api.reactToMessage(channelId, messageId, emoji),
  });
}

// ── Delete Message ─────────────────────────────────────

export function useDeleteMessage() {
  return useMutation({
    mutationFn: ({
      channelId,
      messageId,
    }: {
      channelId: string;
      messageId: string;
    }) => api.deleteMessage(channelId, messageId),
    // Don't invalidate — WebSocket will push the deletion
  });
}

export function usePinMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      channelId,
      messageId,
    }: {
      channelId: string;
      messageId: string;
    }) => api.pinMessage(channelId, messageId),
    onSuccess: (_, { channelId }) => {
      // Refetch messages to update pin state
      queryClient.invalidateQueries({ queryKey: ["messages", channelId] });
    },
  });
}

// ── Auth ────────────────────────────────────────────────

export function useAuthMe() {
  return useQuery({
    queryKey: queryKeys.authMe,
    queryFn: api.getAuthMe,
    retry: false,
    staleTime: Infinity,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      qc.clear();
    },
  });
}

export function useJoinWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, data }: { token: string; data: { name: string; display_name?: string; email?: string } }) =>
      api.joinWorkspace(token, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.authMe });
      qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

// ── Workspaces ──────────────────────────────────────────

export function useWorkspaces() {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: api.listWorkspaces,
    staleTime: 60_000,
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; slug: string; type?: string; description?: string }) =>
      api.createWorkspace(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

// ── Workspace Members ───────────────────────────────────

export function useMembers(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.members(workspaceId ?? ""),
    queryFn: () => api.listMembers(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, userId }: { workspaceId: string; userId: string }) =>
      api.removeMember(workspaceId, userId),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.members(vars.workspaceId) });
    },
  });
}

// ── API Keys ────────────────────────────────────────────

export function useApiKeys(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.apiKeys(workspaceId ?? ""),
    queryFn: () => api.listApiKeys(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data?: { name?: string; expires_in_days?: number } }) =>
      api.createApiKey(workspaceId, data),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.apiKeys(vars.workspaceId) });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, keyId }: { workspaceId: string; keyId: string }) =>
      api.revokeApiKey(workspaceId, keyId),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.apiKeys(vars.workspaceId) });
    },
  });
}

// ── Invites ─────────────────────────────────────────────

export function useInvites(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.invites(workspaceId ?? ""),
    queryFn: () => api.listInvites(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data?: { role?: string; max_uses?: number; expires_in_days?: number } }) =>
      api.createInvite(workspaceId, data),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.invites(vars.workspaceId) });
    },
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, inviteId }: { workspaceId: string; inviteId: string }) =>
      api.revokeInvite(workspaceId, inviteId),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.invites(vars.workspaceId) });
    },
  });
}
