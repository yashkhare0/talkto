/** Global application store using Zustand.
 *
 * Manages UI state, active channel, and real-time data that comes via WebSocket.
 * API-fetched data (channels, agents, messages) lives in TanStack Query cache.
 * This store holds ephemeral UI state and WebSocket-pushed updates.
 */
import { create } from "zustand";
import type { Message } from "@/lib/types";

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

  // ── Agent status updates (from WebSocket) ──
  agentStatuses: Map<string, "online" | "offline">;
  setAgentStatus: (name: string, status: "online" | "offline") => void;

  // ── Typing indicators (from WebSocket) ──
  typingAgents: Map<string, Set<string>>; // channelId → Set<agent_name>
  setAgentTyping: (channelId: string, agentName: string, isTyping: boolean, error?: string) => void;

  // ── Invocation errors (transient, auto-clear) ──
  invocationError: { channelId: string; message: string } | null;
  clearInvocationError: () => void;

  // ── Connection status ──
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Onboarding
  isOnboarded: false,
  setOnboarded: (v) => set({ isOnboarded: v }),

  // Active channel
  activeChannelId: null,
  setActiveChannelId: (id) =>
    set({ activeChannelId: id, realtimeMessages: [] }),

  // Sidebar
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  // Real-time messages
  realtimeMessages: [],
  addRealtimeMessage: (msg) =>
    set((s) => ({
      realtimeMessages: [...s.realtimeMessages, msg],
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

  // Invocation errors
  invocationError: null,
  clearInvocationError: () => set({ invocationError: null }),

  // WebSocket
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),
}));
