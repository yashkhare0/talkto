/**
 * Tests for Codex CLI SDK wrapper.
 *
 * Pure unit tests — no live Codex subprocess. Tests cover:
 * - Thread liveness tracking (in-process Set)
 * - Thread busy tracking
 * - extractTextFromTurn
 * - SDK type shape validation (Turn, ThreadEvent, ThreadItem, Usage)
 * - Thread event discrimination
 * - Lifecycle simulation (registration → alive → invocation → ghost → re-register)
 *
 * Follows the same patterns as claude.test.ts.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  markSessionAlive,
  markSessionDead,
  isSessionAlive,
  isSessionBusy,
  extractTextFromTurn,
} from "../src/sdk/codex";
import type {
  Turn,
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  Usage,
  TurnCompletedEvent,
  TurnFailedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  ItemCompletedEvent,
  ThreadStartedEvent,
  ThreadErrorEvent,
} from "../src/sdk/codex";
import { agentStreamingEvent, agentTypingEvent } from "../src/services/broadcaster";

// ── Helpers ─────────────────────────────────────────────────────

/** Build a minimal Turn result with a final response. */
function mockTurn(opts: {
  text?: string;
  items?: ThreadItem[];
  usage?: Usage | null;
}): Turn {
  const text = opts.text ?? "Hello from Codex";
  const items: ThreadItem[] = opts.items ?? [
    {
      id: "msg_001",
      type: "agent_message",
      text,
    } as AgentMessageItem,
  ];
  const usage = opts.usage === undefined
    ? { input_tokens: 100, output_tokens: 50, cached_input_tokens: 0 }
    : opts.usage;
  return {
    finalResponse: text,
    items,
    usage,
  };
}

/** Build an AgentMessageItem. */
function mockAgentMessage(text: string, id = "msg_001"): AgentMessageItem {
  return { id, type: "agent_message", text };
}

// ── Thread Liveness Tracking ────────────────────────────────────

describe("Codex thread liveness tracking", () => {
  const threadId = "thread_test_001";

  beforeEach(() => {
    markSessionDead(threadId);
  });

  test("unknown thread is not alive", async () => {
    expect(await isSessionAlive("thread_nonexistent")).toBe(false);
  });

  test("markSessionAlive makes thread alive", async () => {
    markSessionAlive(threadId);
    expect(await isSessionAlive(threadId)).toBe(true);
  });

  test("markSessionDead makes thread not alive", async () => {
    markSessionAlive(threadId);
    markSessionDead(threadId);
    expect(await isSessionAlive(threadId)).toBe(false);
  });

  test("threads are isolated from each other", async () => {
    const other = "thread_other_001";
    markSessionDead(other);

    markSessionAlive(threadId);
    expect(await isSessionAlive(threadId)).toBe(true);
    expect(await isSessionAlive(other)).toBe(false);

    markSessionDead(other);
  });

  test("multiple threads can be alive simultaneously", async () => {
    const ids = ["thread_a", "thread_b", "thread_c"];
    for (const id of ids) markSessionAlive(id);

    for (const id of ids) {
      expect(await isSessionAlive(id)).toBe(true);
    }

    for (const id of ids) markSessionDead(id);
  });

  test("markSessionAlive is idempotent", async () => {
    markSessionAlive(threadId);
    markSessionAlive(threadId);
    markSessionAlive(threadId);
    expect(await isSessionAlive(threadId)).toBe(true);
  });

  test("markSessionDead is idempotent", async () => {
    markSessionDead(threadId);
    markSessionDead(threadId);
    expect(await isSessionAlive(threadId)).toBe(false);
  });

  test("revival after death", async () => {
    markSessionAlive(threadId);
    markSessionDead(threadId);
    expect(await isSessionAlive(threadId)).toBe(false);

    markSessionAlive(threadId);
    expect(await isSessionAlive(threadId)).toBe(true);
  });

  test("empty string thread ID", async () => {
    markSessionAlive("");
    expect(await isSessionAlive("")).toBe(true);
    markSessionDead("");
  });

  test("UUID-style thread ID", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    markSessionAlive(uuid);
    expect(await isSessionAlive(uuid)).toBe(true);
    markSessionDead(uuid);
  });
});

// ── Thread Busy Tracking ────────────────────────────────────────

describe("Codex thread busy tracking", () => {
  const threadId = "thread_busy_test";

  beforeEach(() => {
    markSessionDead(threadId);
  });

  test("unknown thread is not busy", async () => {
    expect(await isSessionBusy("thread_unknown")).toBe(false);
  });

  test("alive thread is not automatically busy", async () => {
    markSessionAlive(threadId);
    expect(await isSessionBusy(threadId)).toBe(false);
  });

  test("markSessionDead clears busy state", async () => {
    // busyThreads is private, but markSessionDead clears it
    markSessionAlive(threadId);
    markSessionDead(threadId);
    expect(await isSessionBusy(threadId)).toBe(false);
  });

  test("alive does not imply busy and vice versa", async () => {
    markSessionAlive(threadId);
    expect(await isSessionAlive(threadId)).toBe(true);
    expect(await isSessionBusy(threadId)).toBe(false);
  });
});

// ── extractTextFromTurn ─────────────────────────────────────────

describe("extractTextFromTurn", () => {
  test("extracts finalResponse", () => {
    const turn = mockTurn({ text: "The answer is 42" });
    expect(extractTextFromTurn(turn)).toBe("The answer is 42");
  });

  test("trims whitespace from finalResponse", () => {
    const turn = mockTurn({ text: "  padded text  " });
    expect(extractTextFromTurn(turn)).toBe("padded text");
  });

  test("trims leading whitespace", () => {
    const turn = mockTurn({ text: "\n  leading" });
    expect(extractTextFromTurn(turn)).toBe("leading");
  });

  test("trims trailing whitespace", () => {
    const turn = mockTurn({ text: "trailing  \n" });
    expect(extractTextFromTurn(turn)).toBe("trailing");
  });

  test("empty finalResponse falls back to items", () => {
    const turn: Turn = {
      finalResponse: "",
      items: [mockAgentMessage("from items")],
      usage: null,
    };
    expect(extractTextFromTurn(turn)).toBe("from items");
  });

  test("no agent_message items returns empty string", () => {
    const turn: Turn = {
      finalResponse: "",
      items: [
        { id: "cmd_001", type: "command_execution", command: "ls", aggregated_output: "", status: "completed" } as any,
      ],
      usage: null,
    };
    expect(extractTextFromTurn(turn)).toBe("");
  });

  test("multiple agent_messages returns last one", () => {
    const turn: Turn = {
      finalResponse: "",
      items: [
        mockAgentMessage("first", "msg_001"),
        mockAgentMessage("second", "msg_002"),
        mockAgentMessage("third", "msg_003"),
      ],
      usage: null,
    };
    expect(extractTextFromTurn(turn)).toBe("third");
  });

  test("preserves multiline text", () => {
    const turn = mockTurn({ text: "line 1\nline 2\nline 3" });
    expect(extractTextFromTurn(turn)).toBe("line 1\nline 2\nline 3");
  });

  test("preserves internal whitespace", () => {
    const turn = mockTurn({ text: "word1   word2\tword3" });
    expect(extractTextFromTurn(turn)).toBe("word1   word2\tword3");
  });

  test("handles markdown content", () => {
    const md = "# Title\n\n- item 1\n- item 2\n\n```js\nconsole.log('hi');\n```";
    const turn = mockTurn({ text: md });
    expect(extractTextFromTurn(turn)).toBe(md);
  });

  test("handles long text (100K chars)", () => {
    const long = "x".repeat(100_000);
    const turn = mockTurn({ text: long });
    expect(extractTextFromTurn(turn)).toBe(long);
    expect(extractTextFromTurn(turn).length).toBe(100_000);
  });

  test("handles unicode text", () => {
    const unicode = "Hello 世界 🌍 مرحبا мир";
    const turn = mockTurn({ text: unicode });
    expect(extractTextFromTurn(turn)).toBe(unicode);
  });
});

// ── Turn type validation ────────────────────────────────────────

describe("Turn type validation", () => {
  test("full Turn shape with all fields", () => {
    const turn = mockTurn({
      text: "Done",
      usage: { input_tokens: 500, output_tokens: 200, cached_input_tokens: 100 },
    });

    expect(turn.finalResponse).toBe("Done");
    expect(turn.items).toHaveLength(1);
    expect(turn.items[0].type).toBe("agent_message");
    expect(turn.usage).toBeDefined();
    expect(turn.usage!.input_tokens).toBe(500);
    expect(turn.usage!.output_tokens).toBe(200);
    expect(turn.usage!.cached_input_tokens).toBe(100);
  });

  test("Turn with null usage", () => {
    const turn = mockTurn({ usage: null });
    expect(turn.usage).toBeNull();
  });

  test("Turn with zero token usage", () => {
    const turn = mockTurn({
      usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
    });
    expect(turn.usage!.input_tokens).toBe(0);
    expect(turn.usage!.output_tokens).toBe(0);
  });

  test("Turn with empty items array", () => {
    const turn: Turn = {
      finalResponse: "text",
      items: [],
      usage: null,
    };
    expect(turn.items).toHaveLength(0);
  });

  test("Turn with multiple item types", () => {
    const items: ThreadItem[] = [
      mockAgentMessage("thinking..."),
      {
        id: "cmd_001",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "all passed",
        exit_code: 0,
        status: "completed",
      } as any,
      mockAgentMessage("Tests pass!"),
    ];
    const turn: Turn = {
      finalResponse: "Tests pass!",
      items,
      usage: { input_tokens: 300, output_tokens: 100, cached_input_tokens: 0 },
    };
    expect(turn.items).toHaveLength(3);
    expect(turn.items[0].type).toBe("agent_message");
    expect(turn.items[1].type).toBe("command_execution");
    expect(turn.items[2].type).toBe("agent_message");
  });
});

// ── ThreadItem discrimination ───────────────────────────────────

describe("ThreadItem type discrimination", () => {
  test("agent_message item shape", () => {
    const item: ThreadItem = mockAgentMessage("Hello");
    expect(item.type).toBe("agent_message");
    expect(item.id).toBe("msg_001");
    if (item.type === "agent_message") {
      expect(item.text).toBe("Hello");
    }
  });

  test("command_execution item shape", () => {
    const item: ThreadItem = {
      id: "cmd_001",
      type: "command_execution",
      command: "git status",
      aggregated_output: "On branch main\nnothing to commit",
      exit_code: 0,
      status: "completed",
    };
    expect(item.type).toBe("command_execution");
    if (item.type === "command_execution") {
      expect(item.command).toBe("git status");
      expect(item.exit_code).toBe(0);
      expect(item.status).toBe("completed");
    }
  });

  test("file_change item shape", () => {
    const item: ThreadItem = {
      id: "patch_001",
      type: "file_change",
      changes: [
        { path: "src/index.ts", kind: "update" },
        { path: "src/new.ts", kind: "add" },
      ],
      status: "completed",
    };
    expect(item.type).toBe("file_change");
    if (item.type === "file_change") {
      expect(item.changes).toHaveLength(2);
      expect(item.changes[0].kind).toBe("update");
      expect(item.status).toBe("completed");
    }
  });

  test("error item shape", () => {
    const item: ThreadItem = {
      id: "err_001",
      type: "error",
      message: "Something went wrong",
    };
    expect(item.type).toBe("error");
    if (item.type === "error") {
      expect(item.message).toBe("Something went wrong");
    }
  });

  test("mcp_tool_call item shape", () => {
    const item: ThreadItem = {
      id: "mcp_001",
      type: "mcp_tool_call",
      server: "talkto",
      tool: "send_message",
      arguments: { channel: "#general", content: "hi" },
      status: "completed",
    };
    expect(item.type).toBe("mcp_tool_call");
    if (item.type === "mcp_tool_call") {
      expect(item.server).toBe("talkto");
      expect(item.tool).toBe("send_message");
      expect(item.status).toBe("completed");
    }
  });

  test("type-based routing simulation", () => {
    const items: ThreadItem[] = [
      mockAgentMessage("Planning..."),
      {
        id: "cmd_001",
        type: "command_execution",
        command: "bun test",
        aggregated_output: "OK",
        exit_code: 0,
        status: "completed",
      } as any,
      {
        id: "patch_001",
        type: "file_change",
        changes: [{ path: "src/fix.ts", kind: "update" }],
        status: "completed",
      } as any,
      mockAgentMessage("Done!"),
    ];

    const messages: string[] = [];
    const commands: string[] = [];
    const patches: number[] = [];

    for (const item of items) {
      switch (item.type) {
        case "agent_message":
          messages.push((item as AgentMessageItem).text);
          break;
        case "command_execution":
          commands.push((item as any).command);
          break;
        case "file_change":
          patches.push((item as any).changes.length);
          break;
      }
    }

    expect(messages).toEqual(["Planning...", "Done!"]);
    expect(commands).toEqual(["bun test"]);
    expect(patches).toEqual([1]);
  });
});

// ── ThreadEvent discrimination ──────────────────────────────────

describe("ThreadEvent discrimination", () => {
  test("thread.started event shape", () => {
    const event: ThreadEvent = {
      type: "thread.started",
      thread_id: "thread_abc123",
    };
    expect(event.type).toBe("thread.started");
    if (event.type === "thread.started") {
      expect(event.thread_id).toBe("thread_abc123");
    }
  });

  test("turn.started event shape", () => {
    const event: ThreadEvent = { type: "turn.started" };
    expect(event.type).toBe("turn.started");
  });

  test("turn.completed event shape", () => {
    const event: ThreadEvent = {
      type: "turn.completed",
      usage: { input_tokens: 400, output_tokens: 150, cached_input_tokens: 50 },
    };
    expect(event.type).toBe("turn.completed");
    if (event.type === "turn.completed") {
      expect(event.usage.input_tokens).toBe(400);
      expect(event.usage.output_tokens).toBe(150);
      expect(event.usage.cached_input_tokens).toBe(50);
    }
  });

  test("turn.failed event shape", () => {
    const event: ThreadEvent = {
      type: "turn.failed",
      error: { message: "Model error" },
    };
    expect(event.type).toBe("turn.failed");
    if (event.type === "turn.failed") {
      expect(event.error.message).toBe("Model error");
    }
  });

  test("item.started with agent_message", () => {
    const event: ThreadEvent = {
      type: "item.started",
      item: mockAgentMessage(""),
    };
    expect(event.type).toBe("item.started");
    if (event.type === "item.started") {
      expect(event.item.type).toBe("agent_message");
    }
  });

  test("item.updated with progressive text", () => {
    const event: ThreadEvent = {
      type: "item.updated",
      item: mockAgentMessage("Hello wor"),
    };
    expect(event.type).toBe("item.updated");
    if (event.type === "item.updated" && event.item.type === "agent_message") {
      expect((event.item as AgentMessageItem).text).toBe("Hello wor");
    }
  });

  test("item.completed with final text", () => {
    const event: ThreadEvent = {
      type: "item.completed",
      item: mockAgentMessage("Hello world!"),
    };
    expect(event.type).toBe("item.completed");
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      expect((event.item as AgentMessageItem).text).toBe("Hello world!");
    }
  });

  test("error event shape", () => {
    const event: ThreadEvent = {
      type: "error",
      message: "Fatal stream error",
    };
    expect(event.type).toBe("error");
    if (event.type === "error") {
      expect(event.message).toBe("Fatal stream error");
    }
  });

  test("event type routing simulation", () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.started", item: mockAgentMessage("") },
      { type: "item.updated", item: mockAgentMessage("He") },
      { type: "item.updated", item: mockAgentMessage("Hello") },
      { type: "item.completed", item: mockAgentMessage("Hello!") },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
      },
    ];

    let threadId = "";
    let finalText = "";
    let totalInput = 0;
    const deltas: string[] = [];
    let lastText = "";

    for (const event of events) {
      switch (event.type) {
        case "thread.started":
          threadId = event.thread_id;
          break;
        case "item.updated":
          if (event.item.type === "agent_message") {
            const current = (event.item as AgentMessageItem).text;
            if (current.length > lastText.length) {
              deltas.push(current.slice(lastText.length));
            }
            lastText = current;
          }
          break;
        case "item.completed":
          if (event.item.type === "agent_message") {
            finalText = (event.item as AgentMessageItem).text;
          }
          break;
        case "turn.completed":
          totalInput = event.usage.input_tokens;
          break;
      }
    }

    expect(threadId).toBe("t1");
    expect(finalText).toBe("Hello!");
    expect(totalInput).toBe(10);
    expect(deltas).toEqual(["He", "llo"]);
  });
});

// ── Lifecycle simulation ────────────────────────────────────────

describe("Codex thread lifecycle simulation", () => {
  test("registration → alive → invocation pattern", async () => {
    const threadId = "thread_lifecycle_001";
    markSessionDead(threadId);

    // Before registration: ghost
    expect(await isSessionAlive(threadId)).toBe(false);
    expect(await isSessionBusy(threadId)).toBe(false);

    // Registration: mark alive
    markSessionAlive(threadId);
    expect(await isSessionAlive(threadId)).toBe(true);
    expect(await isSessionBusy(threadId)).toBe(false);

    // Cleanup
    markSessionDead(threadId);
  });

  test("registration → dead → ghost → re-register", async () => {
    const threadId = "thread_lifecycle_002";
    markSessionDead(threadId);

    // Register
    markSessionAlive(threadId);
    expect(await isSessionAlive(threadId)).toBe(true);

    // Process dies — mark dead
    markSessionDead(threadId);
    expect(await isSessionAlive(threadId)).toBe(false);

    // Agent re-registers with new thread
    const newThreadId = "thread_lifecycle_002_new";
    markSessionAlive(newThreadId);
    expect(await isSessionAlive(newThreadId)).toBe(true);
    expect(await isSessionAlive(threadId)).toBe(false);

    // Cleanup
    markSessionDead(newThreadId);
  });

  test("multiple independent lifecycles", async () => {
    const agents = ["thread_agent_a", "thread_agent_b", "thread_agent_c"];
    for (const id of agents) markSessionDead(id);

    // All register
    for (const id of agents) markSessionAlive(id);
    for (const id of agents) {
      expect(await isSessionAlive(id)).toBe(true);
    }

    // Agent B dies
    markSessionDead(agents[1]);
    expect(await isSessionAlive(agents[0])).toBe(true);
    expect(await isSessionAlive(agents[1])).toBe(false);
    expect(await isSessionAlive(agents[2])).toBe(true);

    // Agent B re-registers
    markSessionAlive(agents[1]);
    for (const id of agents) {
      expect(await isSessionAlive(id)).toBe(true);
    }

    // Cleanup
    for (const id of agents) markSessionDead(id);
  });

  test("rapid state toggling (100 iterations)", async () => {
    const threadId = "thread_rapid_toggle";
    markSessionDead(threadId);

    for (let i = 0; i < 100; i++) {
      markSessionAlive(threadId);
      expect(await isSessionAlive(threadId)).toBe(true);
      markSessionDead(threadId);
      expect(await isSessionAlive(threadId)).toBe(false);
    }
  });
});

// ── Broadcaster event integration ───────────────────────────────

describe("Codex broadcaster event shapes", () => {
  test("agentStreamingEvent for Codex agent", () => {
    const event = agentStreamingEvent("codex-agent", "#general", "Hello from Codex");
    expect(event.type).toBe("agent_streaming");
    expect(event.data).toEqual({
      agent_name: "codex-agent",
      channel_id: "#general",
      delta: "Hello from Codex",
    });
  });

  test("agentStreamingEvent with empty delta", () => {
    const event = agentStreamingEvent("codex-agent", "#project", "");
    expect(event.data.delta).toBe("");
  });

  test("agentTypingEvent start for Codex agent", () => {
    const event = agentTypingEvent("codex-agent", "#general", true);
    expect(event.type).toBe("agent_typing");
    expect(event.data).toEqual({
      agent_name: "codex-agent",
      channel_id: "#general",
      is_typing: true,
    });
  });

  test("agentTypingEvent stop with error for Codex agent", () => {
    const event = agentTypingEvent("codex-agent", "#general", false, "Thread failed");
    expect(event.data.is_typing).toBe(false);
    expect(event.data.error).toBe("Thread failed");
  });
});

// ── Result extraction patterns ──────────────────────────────────

describe("Codex result extraction patterns", () => {
  test("invoker-pattern extraction from Turn", () => {
    const turn = mockTurn({
      text: "I fixed the bug in src/index.ts",
      usage: { input_tokens: 1200, output_tokens: 450, cached_input_tokens: 200 },
    });

    // This is what the invoker does after promptSession returns
    const result = {
      text: extractTextFromTurn(turn),
      tokens: {
        input: turn.usage?.input_tokens ?? 0,
        output: turn.usage?.output_tokens ?? 0,
      },
    };

    expect(result.text).toBe("I fixed the bug in src/index.ts");
    expect(result.tokens.input).toBe(1200);
    expect(result.tokens.output).toBe(450);
  });

  test("zero token usage", () => {
    const turn = mockTurn({
      text: "Quick response",
      usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
    });
    expect(turn.usage!.input_tokens).toBe(0);
    expect(turn.usage!.output_tokens).toBe(0);
  });

  test("cached tokens are separate from input tokens", () => {
    const turn = mockTurn({
      text: "Cached response",
      usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 800 },
    });
    expect(turn.usage!.input_tokens).toBe(1000);
    expect(turn.usage!.cached_input_tokens).toBe(800);
    // TalkTo only tracks input/output, not cached
  });

  test("response text length", () => {
    const text = "A".repeat(5000);
    const turn = mockTurn({ text });
    expect(extractTextFromTurn(turn).length).toBe(5000);
  });
});
