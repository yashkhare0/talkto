/** Tests for the Zustand app store. */
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./app-store";

// Reset store between tests
beforeEach(() => {
  useAppStore.setState({
    isOnboarded: false,
    activeChannelId: null,
    sidebarOpen: true,
    realtimeMessages: [],
    agentStatuses: new Map(),
    typingAgents: new Map(),
    streamingMessages: new Map(),
    invocationError: null,
    wsConnected: false,
    starredChannels: new Set(),
  });
});

describe("app-store", () => {
  describe("onboarding", () => {
    it("defaults to not onboarded", () => {
      expect(useAppStore.getState().isOnboarded).toBe(false);
    });

    it("setOnboarded updates the flag", () => {
      useAppStore.getState().setOnboarded(true);
      expect(useAppStore.getState().isOnboarded).toBe(true);
    });
  });

  describe("active channel", () => {
    it("defaults to null", () => {
      expect(useAppStore.getState().activeChannelId).toBeNull();
    });

    it("setActiveChannelId updates the channel and clears realtime messages", () => {
      // Add some realtime messages first
      useAppStore.getState().addRealtimeMessage({
        id: "m1",
        channel_id: "ch1",
        sender_id: "u1",
        sender_name: "test",
        sender_type: "agent",
        content: "hello",
        mentions: null,
        parent_id: null,
        created_at: "2026-01-01T00:00:00Z",
      });
      expect(useAppStore.getState().realtimeMessages).toHaveLength(1);

      // Switch channel
      useAppStore.getState().setActiveChannelId("ch2");
      expect(useAppStore.getState().activeChannelId).toBe("ch2");
      expect(useAppStore.getState().realtimeMessages).toHaveLength(0);
    });
  });

  describe("sidebar", () => {
    it("defaults to open", () => {
      expect(useAppStore.getState().sidebarOpen).toBe(true);
    });

    it("toggleSidebar flips the state", () => {
      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarOpen).toBe(false);

      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe("realtime messages", () => {
    it("addRealtimeMessage appends to the list", () => {
      const msg = {
        id: "m1",
        channel_id: "ch1",
        sender_id: "u1",
        sender_name: "agent-1",
        sender_type: "agent" as const,
        content: "hello",
        mentions: null,
        parent_id: null,
        created_at: "2026-01-01T00:00:00Z",
      };

      useAppStore.getState().addRealtimeMessage(msg);
      useAppStore.getState().addRealtimeMessage({ ...msg, id: "m2" });

      expect(useAppStore.getState().realtimeMessages).toHaveLength(2);
      expect(useAppStore.getState().realtimeMessages[0].id).toBe("m1");
      expect(useAppStore.getState().realtimeMessages[1].id).toBe("m2");
    });
  });

  describe("agent statuses", () => {
    it("defaults to empty map", () => {
      expect(useAppStore.getState().agentStatuses.size).toBe(0);
    });

    it("setAgentStatus adds and updates entries", () => {
      useAppStore.getState().setAgentStatus("cosmic-penguin", "online");
      expect(useAppStore.getState().agentStatuses.get("cosmic-penguin")).toBe("online");

      useAppStore.getState().setAgentStatus("cosmic-penguin", "offline");
      expect(useAppStore.getState().agentStatuses.get("cosmic-penguin")).toBe("offline");
    });

    it("setAgentStatus creates a new Map instance (immutability)", () => {
      const before = useAppStore.getState().agentStatuses;
      useAppStore.getState().setAgentStatus("turbo-flamingo", "online");
      const after = useAppStore.getState().agentStatuses;
      expect(before).not.toBe(after);
    });
  });

  describe("typing agents", () => {
    it("setAgentTyping adds an agent to a channel", () => {
      useAppStore.getState().setAgentTyping("ch1", "agent-a", true);

      const typing = useAppStore.getState().typingAgents.get("ch1");
      expect(typing).toBeDefined();
      expect(typing!.has("agent-a")).toBe(true);
    });

    it("setAgentTyping removes an agent when not typing", () => {
      useAppStore.getState().setAgentTyping("ch1", "agent-a", true);
      useAppStore.getState().setAgentTyping("ch1", "agent-a", false);

      // Channel key should be deleted when set is empty
      expect(useAppStore.getState().typingAgents.has("ch1")).toBe(false);
    });

    it("tracks multiple agents typing in the same channel", () => {
      useAppStore.getState().setAgentTyping("ch1", "agent-a", true);
      useAppStore.getState().setAgentTyping("ch1", "agent-b", true);

      const typing = useAppStore.getState().typingAgents.get("ch1");
      expect(typing!.size).toBe(2);

      // Remove one
      useAppStore.getState().setAgentTyping("ch1", "agent-a", false);
      const updated = useAppStore.getState().typingAgents.get("ch1");
      expect(updated!.size).toBe(1);
      expect(updated!.has("agent-b")).toBe(true);
    });

    it("sets invocationError when error param is provided", () => {
      useAppStore.getState().setAgentTyping("ch1", "agent-a", false, "Something went wrong");

      expect(useAppStore.getState().invocationError).toEqual({
        channelId: "ch1",
        message: "Something went wrong",
      });
    });

    it("does not overwrite invocationError when no error param", () => {
      useAppStore.setState({
        invocationError: { channelId: "ch1", message: "existing error" },
      });

      useAppStore.getState().setAgentTyping("ch1", "agent-a", true);
      expect(useAppStore.getState().invocationError).toEqual({
        channelId: "ch1",
        message: "existing error",
      });
    });
  });

  describe("streaming messages", () => {
    it("defaults to empty map", () => {
      expect(useAppStore.getState().streamingMessages.size).toBe(0);
    });

    it("appendStreamingDelta creates entry and accumulates text", () => {
      useAppStore.getState().appendStreamingDelta("ch1", "agent-a", "Hello ");
      useAppStore.getState().appendStreamingDelta("ch1", "agent-a", "world!");

      const channelStreams = useAppStore.getState().streamingMessages.get("ch1");
      expect(channelStreams).toBeDefined();
      expect(channelStreams!.get("agent-a")).toBe("Hello world!");
    });

    it("tracks multiple agents streaming in the same channel", () => {
      useAppStore.getState().appendStreamingDelta("ch1", "agent-a", "foo");
      useAppStore.getState().appendStreamingDelta("ch1", "agent-b", "bar");

      const channelStreams = useAppStore.getState().streamingMessages.get("ch1");
      expect(channelStreams!.size).toBe(2);
      expect(channelStreams!.get("agent-a")).toBe("foo");
      expect(channelStreams!.get("agent-b")).toBe("bar");
    });

    it("tracks agents streaming across different channels", () => {
      useAppStore.getState().appendStreamingDelta("ch1", "agent-a", "alpha");
      useAppStore.getState().appendStreamingDelta("ch2", "agent-a", "beta");

      expect(useAppStore.getState().streamingMessages.get("ch1")!.get("agent-a")).toBe("alpha");
      expect(useAppStore.getState().streamingMessages.get("ch2")!.get("agent-a")).toBe("beta");
    });

    it("clearStreamingMessage removes a specific agent from a channel", () => {
      useAppStore.getState().appendStreamingDelta("ch1", "agent-a", "foo");
      useAppStore.getState().appendStreamingDelta("ch1", "agent-b", "bar");

      useAppStore.getState().clearStreamingMessage("ch1", "agent-a");

      const channelStreams = useAppStore.getState().streamingMessages.get("ch1");
      expect(channelStreams!.has("agent-a")).toBe(false);
      expect(channelStreams!.get("agent-b")).toBe("bar");
    });

    it("clearStreamingMessage removes channel key when last agent is cleared", () => {
      useAppStore.getState().appendStreamingDelta("ch1", "agent-a", "foo");
      useAppStore.getState().clearStreamingMessage("ch1", "agent-a");

      expect(useAppStore.getState().streamingMessages.has("ch1")).toBe(false);
    });

    it("clearStreamingMessage is a no-op for non-existent entries", () => {
      useAppStore.getState().clearStreamingMessage("ch1", "ghost-agent");
      expect(useAppStore.getState().streamingMessages.size).toBe(0);
    });

    it("creates new Map instances on mutation (immutability)", () => {
      const before = useAppStore.getState().streamingMessages;
      useAppStore.getState().appendStreamingDelta("ch1", "agent-a", "delta");
      const after = useAppStore.getState().streamingMessages;
      expect(before).not.toBe(after);
    });
  });

  describe("invocation error", () => {
    it("clearInvocationError resets to null", () => {
      useAppStore.setState({
        invocationError: { channelId: "ch1", message: "oops" },
      });
      useAppStore.getState().clearInvocationError();
      expect(useAppStore.getState().invocationError).toBeNull();
    });
  });

  describe("websocket connection", () => {
    it("defaults to disconnected", () => {
      expect(useAppStore.getState().wsConnected).toBe(false);
    });

    it("setWsConnected updates the state", () => {
      useAppStore.getState().setWsConnected(true);
      expect(useAppStore.getState().wsConnected).toBe(true);
    });
  });

  describe("starred channels", () => {
    it("defaults to empty set", () => {
      expect(useAppStore.getState().starredChannels.size).toBe(0);
    });

    it("toggleStarredChannel adds a channel", () => {
      useAppStore.getState().toggleStarredChannel("ch-1");
      expect(useAppStore.getState().starredChannels.has("ch-1")).toBe(true);
    });

    it("toggleStarredChannel removes a starred channel", () => {
      useAppStore.getState().toggleStarredChannel("ch-2");
      expect(useAppStore.getState().starredChannels.has("ch-2")).toBe(true);
      useAppStore.getState().toggleStarredChannel("ch-2");
      expect(useAppStore.getState().starredChannels.has("ch-2")).toBe(false);
    });

    it("supports multiple starred channels", () => {
      useAppStore.getState().toggleStarredChannel("ch-a");
      useAppStore.getState().toggleStarredChannel("ch-b");
      expect(useAppStore.getState().starredChannels.size).toBe(2);
    });
  });
});
