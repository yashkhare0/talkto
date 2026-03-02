/** Global application store using Zustand.
 *
 * Manages UI state, active channel, and real-time data that comes via WebSocket.
 * API-fetched data (channels, agents, messages) lives in TanStack Query cache.
 * This store holds ephemeral UI state and WebSocket-pushed updates.
 */
import { create } from "zustand";
import type { AuthInfo, Message, Workspace } from "@/lib/types";

function readStarredChannels(): Set<string> {
  try {
    const raw = localStorage.getItem("talkto-starred-channels");
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function writeStarredChannels(ids: Set<string>): void {
  try {
    localStorage.setItem("talkto-starred-channels", JSON.stringify([...ids]));
  } catch {
    // Storage unavailable
  }
}

function readDarkMode(): boolean {
  try {
    return localStorage.getItem("talkto-dark-mode") === "true";
  } catch {
    return false;
  }
}

function writeDarkMode(value: boolean): void {
  try {
    localStorage.setItem("talkto-dark-mode", String(value));
  } catch {
    // Storage unavailable (test env, etc.)
  }
}

function applyDarkClass(dark: boolean): void {
  try {
    document.documentElement.classList.toggle("dark", dark);
  } catch {
    // DOM unavailable (test env, etc.)
  }
}

interface AppState {
  // ── Onboarding ──
  isOnboarded: boolean;
  setOnboarded: (v: boolean) => void;

  // ── Active channel ──
  activeChannelId: string | null;
  setActiveChannelId: (id: string | null) => void;

  // ── Sidebar ──
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  // ── Real-time messages (optimistic, from WebSocket) ──
  // These are merged with TanStack Query cache in the message feed component
  realtimeMessages: Message[];
  addRealtimeMessage: (msg: Message) => void;
  removeRealtimeMessage: (msgId: string) => void;

  // ── Agent status updates (from WebSocket) ──
  agentStatuses: Map<string, "online" | "offline">;
  setAgentStatus: (name: string, status: "online" | "offline") => void;

  // ── Typing indicators (from WebSocket) ──
  typingAgents: Map<string, Set<string>>; // channelId → Set<agent_name>
  setAgentTyping: (channelId: string, agentName: string, isTyping: boolean, error?: string) => void;

  // ── Streaming text (from agent_streaming WebSocket events) ──
  // channelId → agentName → accumulated text so far
  streamingMessages: Map<string, Map<string, string>>;
  appendStreamingDelta: (channelId: string, agentName: string, delta: string) => void;
  clearStreamingMessage: (channelId: string, agentName: string) => void;

  // ── Reply-to state ──
  replyToMessage: Message | null;
  setReplyToMessage: (msg: Message | null) => void;

  // ── Invocation errors (transient, auto-clear) ──
  invocationError: { channelId: string; message: string } | null;
  clearInvocationError: () => void;

  // ── Starred channels ──
  starredChannels: Set<string>;
  toggleStarredChannel: (channelId: string) => void;

  // ── Dark mode ──
  darkMode: boolean;
  toggleDarkMode: () => void;

  // ── Connection status ──
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;

  // ── Workspace context ──
  activeWorkspaceId: string | null;
  setActiveWorkspaceId: (id: string | null) => void;
  workspaces: Workspace[];
  setWorkspaces: (ws: Workspace[]) => void;
  authInfo: AuthInfo | null;
  setAuthInfo: (info: AuthInfo | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Onboarding
  isOnboarded: false,
  setOnboarded: (v) => set({ isOnboarded: v }),

  // Active channel
  activeChannelId: null,
  setActiveChannelId: (id) =>
    set({ activeChannelId: id, realtimeMessages: [], replyToMessage: null }),

  // Sidebar
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  // Real-time messages (capped at 200 to prevent unbounded growth)
  realtimeMessages: [],
  addRealtimeMessage: (msg) =>
    set((s) => {
      const next = [...s.realtimeMessages, msg];
      return { realtimeMessages: next.length > 200 ? next.slice(-200) : next };
    }),
  removeRealtimeMessage: (msgId) =>
    set((s) => ({
      realtimeMessages: s.realtimeMessages.filter((m) => m.id !== msgId),
    })),

  // Agent statuses
  agentStatuses: new Map(),
  setAgentStatus: (name, status) =>
    set((s) => {
      const next = new Map(s.agentStatuses);
      next.set(name, status);
      return { agentStatuses: next };
    }),

  // Typing indicators
  typingAgents: new Map(),
  setAgentTyping: (channelId, agentName, isTyping, error?) =>
    set((s) => {
      const next = new Map(s.typingAgents);
      const agents = new Set(next.get(channelId) ?? []);
      if (isTyping) {
        agents.add(agentName);
      } else {
        agents.delete(agentName);
      }
      if (agents.size === 0) {
        next.delete(channelId);
      } else {
        next.set(channelId, agents);
      }
      return {
        typingAgents: next,
        invocationError: error ? { channelId, message: error } : s.invocationError,
      };
    }),

  // Streaming messages
  streamingMessages: new Map(),
  appendStreamingDelta: (channelId, agentName, delta) =>
    set((s) => {
      const next = new Map(s.streamingMessages);
      const channelStreams = new Map(next.get(channelId) ?? []);
      const current = channelStreams.get(agentName) ?? "";
      channelStreams.set(agentName, current + delta);
      next.set(channelId, channelStreams);
      return { streamingMessages: next };
    }),
  clearStreamingMessage: (channelId, agentName) =>
    set((s) => {
      const next = new Map(s.streamingMessages);
      const channelStreams = next.get(channelId);
      if (channelStreams) {
        const updated = new Map(channelStreams);
        updated.delete(agentName);
        if (updated.size === 0) {
          next.delete(channelId);
        } else {
          next.set(channelId, updated);
        }
      }
      return { streamingMessages: next };
    }),

  // Invocation errors
  invocationError: null,
  replyToMessage: null,
  setReplyToMessage: (msg) => set({ replyToMessage: msg }),

  clearInvocationError: () => set({ invocationError: null }),

  // Starred channels
  starredChannels: readStarredChannels(),
  toggleStarredChannel: (channelId) =>
    set((s) => {
      const next = new Set(s.starredChannels);
      if (next.has(channelId)) {
        next.delete(channelId);
      } else {
        next.add(channelId);
      }
      writeStarredChannels(next);
      return { starredChannels: next };
    }),

  // Dark mode — read initial value from localStorage
  darkMode: readDarkMode(),
  toggleDarkMode: () =>
    set((s) => {
      const next = !s.darkMode;
      writeDarkMode(next);
      applyDarkClass(next);
      return { darkMode: next };
    }),

  // WebSocket
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),

  // Workspace context
  activeWorkspaceId: null,
  setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),
  workspaces: [],
  setWorkspaces: (ws) => set({ workspaces: ws }),
  authInfo: null,
  setAuthInfo: (info) => set({ authInfo: info }),
}));
