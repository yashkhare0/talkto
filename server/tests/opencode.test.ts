/**
 * Tests for OpenCode SDK client manager, discovery utilities,
 * and broadcaster event factories.
 *
 * These tests focus on pure utility functions that don't require
 * a live OpenCode server.
 */

import { describe, test, expect } from "bun:test";
import {
  matchSessionByProject,
  extractTextFromParts,
  filterEventsBySession,
} from "../src/sdk/opencode";
import {
  agentStreamingEvent,
  agentTypingEvent,
} from "../src/services/broadcaster";
import type {
  Session,
  Part,
  TextPart,
  OpenCodeEvent,
  EventSessionStatus,
  EventSessionIdle,
  EventMessagePartUpdated,
  EventSessionError,
  EventMessageUpdated,
  SessionStatus,
} from "../src/sdk/opencode";

// ---------------------------------------------------------------------------
// Helper: create a mock Session
// ---------------------------------------------------------------------------

function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_test123",
    projectID: "proj_test",
    directory: "/Users/test/project",
    title: "Test session",
    version: "1.0.0",
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// matchSessionByProject
// ---------------------------------------------------------------------------

describe("matchSessionByProject", () => {
  test("exact match", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "/Users/test/project-a" }),
      mockSession({ id: "ses_2", directory: "/Users/test/project-b" }),
    ];
    const result = matchSessionByProject(sessions, "/Users/test/project-b");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_2");
  });

  test("exact match with trailing slash normalization", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "/Users/test/project/" }),
    ];
    const result = matchSessionByProject(sessions, "/Users/test/project");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_1");
  });

  test("parent directory match", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "/Users/test/monorepo" }),
    ];
    const result = matchSessionByProject(
      sessions,
      "/Users/test/monorepo/packages/backend"
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_1");
  });

  test("child directory match", () => {
    const sessions = [
      mockSession({
        id: "ses_1",
        directory: "/Users/test/project/packages/server",
      }),
    ];
    const result = matchSessionByProject(sessions, "/Users/test/project");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_1");
  });

  test("no match returns null", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "/Users/test/other-project" }),
    ];
    const result = matchSessionByProject(sessions, "/Users/test/my-project");
    expect(result).toBeNull();
  });

  test("empty sessions returns null", () => {
    const result = matchSessionByProject([], "/Users/test/project");
    expect(result).toBeNull();
  });

  test("prefers exact match over parent match", () => {
    const sessions = [
      mockSession({ id: "ses_parent", directory: "/Users/test" }),
      mockSession({ id: "ses_exact", directory: "/Users/test/project" }),
    ];
    const result = matchSessionByProject(sessions, "/Users/test/project");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_exact");
  });

  test("does not match partial directory names", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "/Users/test/proj" }),
    ];
    // "/Users/test/project" should NOT match "/Users/test/proj"
    const result = matchSessionByProject(sessions, "/Users/test/project");
    expect(result).toBeNull();
  });

  // --- Windows path tests ---

  test("exact match with Windows backslash paths", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "C:\\Users\\dev\\project" }),
    ];
    const result = matchSessionByProject(sessions, "C:\\Users\\dev\\project");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_1");
  });

  test("matches Windows backslash session against forward-slash query", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "C:\\Users\\dev\\project" }),
    ];
    const result = matchSessionByProject(sessions, "C:/Users/dev/project");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_1");
  });

  test("parent directory match with Windows paths", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "C:\\Users\\dev\\monorepo" }),
    ];
    const result = matchSessionByProject(
      sessions,
      "C:\\Users\\dev\\monorepo\\packages\\server"
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_1");
  });

  test("child directory match with Windows paths", () => {
    const sessions = [
      mockSession({
        id: "ses_1",
        directory: "C:\\Users\\dev\\project\\packages\\server",
      }),
    ];
    const result = matchSessionByProject(sessions, "C:\\Users\\dev\\project");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_1");
  });

  test("mixed separators: backslash session, forward-slash parent match", () => {
    const sessions = [
      mockSession({ id: "ses_1", directory: "C:\\Users\\dev\\monorepo" }),
    ];
    const result = matchSessionByProject(
      sessions,
      "C:/Users/dev/monorepo/packages/backend"
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ses_1");
  });
});

// ---------------------------------------------------------------------------
// extractTextFromParts
// ---------------------------------------------------------------------------

describe("extractTextFromParts", () => {
  const basePart = {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
  };

  test("extracts text from TextPart", () => {
    const parts: Part[] = [
      { ...basePart, type: "text", text: "Hello, world!" } as TextPart,
    ];
    expect(extractTextFromParts(parts)).toBe("Hello, world!");
  });

  test("concatenates multiple text parts", () => {
    const parts: Part[] = [
      { ...basePart, id: "p1", type: "text", text: "First part" } as TextPart,
      { ...basePart, id: "p2", type: "text", text: "Second part" } as TextPart,
    ];
    expect(extractTextFromParts(parts)).toBe("First part\nSecond part");
  });

  test("ignores non-text parts", () => {
    const parts: Part[] = [
      { ...basePart, type: "text", text: "The answer is 42" } as TextPart,
      {
        ...basePart,
        id: "p2",
        type: "tool",
        callID: "call_1",
        tool: "Read",
        state: { status: "completed", input: {}, output: "file content", title: "Read", metadata: {}, time: { start: 0, end: 1 } },
      } as Part,
      {
        ...basePart,
        id: "p3",
        type: "reasoning",
        text: "thinking...",
        time: { start: 0 },
      } as Part,
    ];
    expect(extractTextFromParts(parts)).toBe("The answer is 42");
  });

  test("skips ignored text parts", () => {
    const parts: Part[] = [
      { ...basePart, id: "p1", type: "text", text: "Keep this" } as TextPart,
      {
        ...basePart,
        id: "p2",
        type: "text",
        text: "Skip this",
        ignored: true,
      } as TextPart,
    ];
    expect(extractTextFromParts(parts)).toBe("Keep this");
  });

  test("returns empty string for no text parts", () => {
    const parts: Part[] = [
      {
        ...basePart,
        type: "tool",
        callID: "call_1",
        tool: "Bash",
        state: { status: "completed", input: {}, output: "done", title: "Bash", metadata: {}, time: { start: 0, end: 1 } },
      } as Part,
    ];
    expect(extractTextFromParts(parts)).toBe("");
  });

  test("trims whitespace from result", () => {
    const parts: Part[] = [
      { ...basePart, type: "text", text: "  trimmed  " } as TextPart,
    ];
    expect(extractTextFromParts(parts)).toBe("trimmed");
  });

  test("handles empty parts array", () => {
    expect(extractTextFromParts([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// filterEventsBySession
// ---------------------------------------------------------------------------

describe("filterEventsBySession", () => {
  /** Helper: create an async generator from an array of events */
  async function* fromArray(
    events: OpenCodeEvent[]
  ): AsyncGenerator<OpenCodeEvent, void, unknown> {
    for (const e of events) {
      yield e;
    }
  }

  /** Helper: collect all events from an async generator into an array */
  async function collectAll(
    gen: AsyncGenerator<OpenCodeEvent, void, unknown>
  ): Promise<OpenCodeEvent[]> {
    const results: OpenCodeEvent[] = [];
    for await (const e of gen) {
      results.push(e);
    }
    return results;
  }

  test("filters session.status events by sessionID", async () => {
    const events: OpenCodeEvent[] = [
      {
        type: "session.status",
        properties: { sessionID: "ses_A", status: { type: "busy" } },
      } as EventSessionStatus,
      {
        type: "session.status",
        properties: { sessionID: "ses_B", status: { type: "idle" } },
      } as EventSessionStatus,
      {
        type: "session.idle",
        properties: { sessionID: "ses_A" },
      } as EventSessionIdle,
    ];

    const filtered = await collectAll(
      filterEventsBySession(fromArray(events), "ses_A")
    );
    expect(filtered).toHaveLength(2);
    expect(filtered[0].type).toBe("session.status");
    expect(filtered[1].type).toBe("session.idle");
  });

  test("filters message.updated events by sessionID in info", async () => {
    const events: OpenCodeEvent[] = [
      {
        type: "message.updated",
        properties: {
          info: { sessionID: "ses_A", id: "msg_1", role: "assistant" },
        },
      } as unknown as EventMessageUpdated,
      {
        type: "message.updated",
        properties: {
          info: { sessionID: "ses_B", id: "msg_2", role: "assistant" },
        },
      } as unknown as EventMessageUpdated,
    ];

    const filtered = await collectAll(
      filterEventsBySession(fromArray(events), "ses_A")
    );
    expect(filtered).toHaveLength(1);
    expect(
      (filtered[0] as EventMessageUpdated).properties.info.id
    ).toBe("msg_1");
  });

  test("filters message.part.updated events by sessionID in part", async () => {
    const events: OpenCodeEvent[] = [
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses_A", id: "part_1", type: "text", text: "hello" },
          delta: "hello",
        },
      } as unknown as EventMessagePartUpdated,
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses_B", id: "part_2", type: "text", text: "world" },
          delta: "world",
        },
      } as unknown as EventMessagePartUpdated,
    ];

    const filtered = await collectAll(
      filterEventsBySession(fromArray(events), "ses_A")
    );
    expect(filtered).toHaveLength(1);
    expect(
      (filtered[0] as unknown as { properties: { delta: string } }).properties.delta
    ).toBe("hello");
  });

  test("filters session.error events", async () => {
    const events: OpenCodeEvent[] = [
      {
        type: "session.error",
        properties: {
          sessionID: "ses_A",
          error: { name: "ApiError" },
        },
      } as unknown as EventSessionError,
      {
        type: "session.error",
        properties: {
          sessionID: "ses_C",
          error: { name: "Timeout" },
        },
      } as unknown as EventSessionError,
    ];

    const filtered = await collectAll(
      filterEventsBySession(fromArray(events), "ses_A")
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].type).toBe("session.error");
  });

  test("returns empty for no matching events", async () => {
    const events: OpenCodeEvent[] = [
      {
        type: "session.status",
        properties: { sessionID: "ses_X", status: { type: "busy" } },
      } as EventSessionStatus,
    ];

    const filtered = await collectAll(
      filterEventsBySession(fromArray(events), "ses_A")
    );
    expect(filtered).toHaveLength(0);
  });

  test("handles empty stream", async () => {
    const filtered = await collectAll(
      filterEventsBySession(fromArray([]), "ses_A")
    );
    expect(filtered).toHaveLength(0);
  });

  test("passes through events with matching properties.sessionID", async () => {
    // Test with session.idle, session.compacted — all have sessionID directly
    const events: OpenCodeEvent[] = [
      { type: "session.idle", properties: { sessionID: "ses_A" } } as EventSessionIdle,
      {
        type: "session.status",
        properties: { sessionID: "ses_A", status: { type: "idle" } },
      } as EventSessionStatus,
    ];

    const filtered = await collectAll(
      filterEventsBySession(fromArray(events), "ses_A")
    );
    expect(filtered).toHaveLength(2);
  });

  test("ignores events without properties", async () => {
    // server.connected has empty properties — should not match
    const events: OpenCodeEvent[] = [
      {
        type: "server.connected",
        properties: {},
      } as OpenCodeEvent,
    ];

    const filtered = await collectAll(
      filterEventsBySession(fromArray(events), "ses_A")
    );
    expect(filtered).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SessionStatus type shape tests
// ---------------------------------------------------------------------------

describe("SessionStatus types", () => {
  test("idle status has correct shape", () => {
    const status: SessionStatus = { type: "idle" };
    expect(status.type).toBe("idle");
  });

  test("busy status has correct shape", () => {
    const status: SessionStatus = { type: "busy" };
    expect(status.type).toBe("busy");
  });

  test("retry status has attempt and message", () => {
    const status: SessionStatus = {
      type: "retry",
      attempt: 2,
      message: "Rate limited",
      next: Date.now() + 5000,
    };
    expect(status.type).toBe("retry");
    expect((status as { attempt: number }).attempt).toBe(2);
    expect((status as { message: string }).message).toBe("Rate limited");
  });
});

// ---------------------------------------------------------------------------
// Broadcaster event factory tests
// ---------------------------------------------------------------------------

describe("agentStreamingEvent", () => {
  test("produces correct event shape", () => {
    const event = agentStreamingEvent("spicy-bat", "ch-123", "Hello ");
    expect(event.type).toBe("agent_streaming");
    expect(event.data).toEqual({
      agent_name: "spicy-bat",
      channel_id: "ch-123",
      delta: "Hello ",
    });
  });

  test("handles empty delta", () => {
    const event = agentStreamingEvent("spicy-bat", "ch-123", "");
    expect(event.data.delta).toBe("");
  });

  test("handles multi-line delta", () => {
    const event = agentStreamingEvent("agent", "ch", "line1\nline2\nline3");
    expect(event.data.delta).toBe("line1\nline2\nline3");
  });
});

describe("agentTypingEvent", () => {
  test("produces typing start event", () => {
    const event = agentTypingEvent("spicy-bat", "ch-123", true);
    expect(event.type).toBe("agent_typing");
    expect(event.data).toEqual({
      agent_name: "spicy-bat",
      channel_id: "ch-123",
      is_typing: true,
    });
  });

  test("produces typing stop event with error", () => {
    const event = agentTypingEvent("spicy-bat", "ch-123", false, "timed out");
    expect(event.type).toBe("agent_typing");
    expect(event.data.is_typing).toBe(false);
    expect(event.data.error).toBe("timed out");
  });

  test("omits error field when not provided", () => {
    const event = agentTypingEvent("spicy-bat", "ch-123", false);
    expect(event.data.error).toBeUndefined();
  });
});
