/**
 * Tests for Claude Code SDK wrapper — session state tracking,
 * text extraction, type validation, and message type discrimination.
 *
 * These tests focus on pure utility functions and in-process state
 * tracking that don't require a live Claude Code process.
 *
 * Mirrors the depth of opencode.test.ts but adapted for Claude's
 * subprocess model (local state tracking vs REST API calls).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  markSessionAlive,
  markSessionDead,
  isSessionAlive,
  isSessionBusy,
  extractTextFromResult,
} from "../src/sdk/claude";
import type {
  SDKResultSuccess,
  SDKResultError,
  SDKResultMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKMessage,
} from "../src/sdk/claude";

// ---------------------------------------------------------------------------
// Session liveness tracking
// ---------------------------------------------------------------------------

describe("Claude session liveness tracking", () => {
  beforeEach(() => {
    // Clean up any leftover state between tests
    markSessionDead("ses_test_1");
    markSessionDead("ses_test_2");
    markSessionDead("ses_test_3");
  });

  test("new session is not alive by default", async () => {
    expect(await isSessionAlive("ses_unknown")).toBe(false);
  });

  test("markSessionAlive makes session alive", async () => {
    markSessionAlive("ses_test_1");
    expect(await isSessionAlive("ses_test_1")).toBe(true);
  });

  test("markSessionDead makes session dead", async () => {
    markSessionAlive("ses_test_1");
    expect(await isSessionAlive("ses_test_1")).toBe(true);
    markSessionDead("ses_test_1");
    expect(await isSessionAlive("ses_test_1")).toBe(false);
  });

  test("marking one session alive doesn't affect others", async () => {
    markSessionAlive("ses_test_1");
    expect(await isSessionAlive("ses_test_1")).toBe(true);
    expect(await isSessionAlive("ses_test_2")).toBe(false);
  });

  test("multiple sessions can be alive simultaneously", async () => {
    markSessionAlive("ses_test_1");
    markSessionAlive("ses_test_2");
    markSessionAlive("ses_test_3");
    expect(await isSessionAlive("ses_test_1")).toBe(true);
    expect(await isSessionAlive("ses_test_2")).toBe(true);
    expect(await isSessionAlive("ses_test_3")).toBe(true);
  });

  test("marking dead session dead again is idempotent", async () => {
    markSessionDead("ses_test_1");
    markSessionDead("ses_test_1");
    expect(await isSessionAlive("ses_test_1")).toBe(false);
  });

  test("re-marking alive session alive is idempotent", async () => {
    markSessionAlive("ses_test_1");
    markSessionAlive("ses_test_1");
    expect(await isSessionAlive("ses_test_1")).toBe(true);
  });

  test("session can be revived after being marked dead", async () => {
    markSessionAlive("ses_test_1");
    markSessionDead("ses_test_1");
    expect(await isSessionAlive("ses_test_1")).toBe(false);
    markSessionAlive("ses_test_1");
    expect(await isSessionAlive("ses_test_1")).toBe(true);
  });

  test("killing one session doesn't affect other alive sessions", async () => {
    markSessionAlive("ses_test_1");
    markSessionAlive("ses_test_2");
    markSessionAlive("ses_test_3");
    markSessionDead("ses_test_2");
    expect(await isSessionAlive("ses_test_1")).toBe(true);
    expect(await isSessionAlive("ses_test_2")).toBe(false);
    expect(await isSessionAlive("ses_test_3")).toBe(true);
  });

  test("handles empty string session ID", async () => {
    markSessionAlive("");
    expect(await isSessionAlive("")).toBe(true);
    markSessionDead("");
    expect(await isSessionAlive("")).toBe(false);
  });

  test("handles UUID-format session IDs", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    markSessionAlive(uuid);
    expect(await isSessionAlive(uuid)).toBe(true);
    markSessionDead(uuid);
    expect(await isSessionAlive(uuid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session busy tracking
// ---------------------------------------------------------------------------

describe("Claude session busy tracking", () => {
  beforeEach(() => {
    markSessionDead("ses_busy_1");
    markSessionDead("ses_busy_2");
  });

  test("session is not busy by default", async () => {
    expect(await isSessionBusy("ses_busy_1")).toBe(false);
  });

  test("unknown session is not busy", async () => {
    expect(await isSessionBusy("ses_never_seen")).toBe(false);
  });

  test("markSessionDead clears busy state", async () => {
    // markSessionDead should clear both alive and busy states
    markSessionDead("ses_busy_1");
    expect(await isSessionBusy("ses_busy_1")).toBe(false);
  });

  test("alive session is not automatically busy", async () => {
    markSessionAlive("ses_busy_1");
    expect(await isSessionBusy("ses_busy_1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractTextFromResult
// ---------------------------------------------------------------------------

describe("extractTextFromResult", () => {
  function mockResult(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
    return {
      type: "result",
      subtype: "success",
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 1,
      result: "Hello, world!",
      stop_reason: "end_turn",
      total_cost_usd: 0.001,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "test-uuid" as SDKResultSuccess["uuid"],
      session_id: "ses_test",
      ...overrides,
    };
  }

  test("extracts result text", () => {
    const result = mockResult({ result: "The answer is 42" });
    expect(extractTextFromResult(result)).toBe("The answer is 42");
  });

  test("trims leading whitespace", () => {
    const result = mockResult({ result: "  padded text" });
    expect(extractTextFromResult(result)).toBe("padded text");
  });

  test("trims trailing whitespace", () => {
    const result = mockResult({ result: "padded text   " });
    expect(extractTextFromResult(result)).toBe("padded text");
  });

  test("trims both sides", () => {
    const result = mockResult({ result: "  padded text  " });
    expect(extractTextFromResult(result)).toBe("padded text");
  });

  test("handles empty result", () => {
    const result = mockResult({ result: "" });
    expect(extractTextFromResult(result)).toBe("");
  });

  test("handles single-line result", () => {
    const result = mockResult({ result: "Just one line" });
    expect(extractTextFromResult(result)).toBe("Just one line");
  });

  test("handles multiline result", () => {
    const result = mockResult({ result: "line 1\nline 2\nline 3" });
    expect(extractTextFromResult(result)).toBe("line 1\nline 2\nline 3");
  });

  test("handles result with only whitespace", () => {
    const result = mockResult({ result: "   \n  \n  " });
    expect(extractTextFromResult(result)).toBe("");
  });

  test("preserves internal whitespace", () => {
    const result = mockResult({ result: "word1  word2\tword3" });
    expect(extractTextFromResult(result)).toBe("word1  word2\tword3");
  });

  test("handles result with markdown formatting", () => {
    const text = "## Summary\n\n- Item 1\n- Item 2\n\n```ts\nconsole.log('hi');\n```";
    const result = mockResult({ result: text });
    expect(extractTextFromResult(result)).toBe(text);
  });

  test("handles very long result", () => {
    const longText = "x".repeat(100_000);
    const result = mockResult({ result: longText });
    expect(extractTextFromResult(result)).toBe(longText);
    expect(extractTextFromResult(result).length).toBe(100_000);
  });

  test("handles result with unicode characters", () => {
    const result = mockResult({ result: "Hello 🌍 World 中文 العربية" });
    expect(extractTextFromResult(result)).toBe("Hello 🌍 World 中文 العربية");
  });
});

// ---------------------------------------------------------------------------
// SDKResultSuccess type shape tests
// ---------------------------------------------------------------------------

describe("SDKResultSuccess type validation", () => {
  test("success result has correct shape", () => {
    const result: SDKResultSuccess = {
      type: "result",
      subtype: "success",
      duration_ms: 1500,
      duration_api_ms: 1200,
      is_error: false,
      num_turns: 2,
      result: "Task completed",
      stop_reason: "end_turn",
      total_cost_usd: 0.005,
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 300,
      },
      modelUsage: {
        "claude-sonnet-4-20250514": {
          inputTokens: 500,
          outputTokens: 200,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 100,
          webSearchRequests: 0,
          costUSD: 0.005,
          contextWindow: 200000,
          maxOutputTokens: 16384,
        },
      },
      permission_denials: [],
      uuid: "result-uuid" as SDKResultSuccess["uuid"],
      session_id: "ses_result",
    };

    expect(result.type).toBe("result");
    expect(result.subtype).toBe("success");
    expect(result.is_error).toBe(false);
    expect(result.total_cost_usd).toBe(0.005);
    expect(result.usage.input_tokens).toBe(500);
    expect(result.usage.output_tokens).toBe(200);
    expect(result.duration_ms).toBe(1500);
    expect(result.num_turns).toBe(2);
    expect(result.session_id).toBe("ses_result");
  });

  test("zero cost and token fields", () => {
    const result: SDKResultSuccess = {
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      result: "Done",
      stop_reason: null,
      total_cost_usd: 0.0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "zero-uuid" as SDKResultSuccess["uuid"],
      session_id: "ses_zero",
    };

    expect(result.total_cost_usd).toBe(0);
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
    expect(result.usage.cache_creation_input_tokens).toBe(0);
    expect(result.usage.cache_read_input_tokens).toBe(0);
  });

  test("result with cache usage", () => {
    const result: SDKResultSuccess = {
      type: "result",
      subtype: "success",
      duration_ms: 500,
      duration_api_ms: 400,
      is_error: false,
      num_turns: 1,
      result: "Cached response",
      stop_reason: "end_turn",
      total_cost_usd: 0.001,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 2000,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "cache-uuid" as SDKResultSuccess["uuid"],
      session_id: "ses_cache",
    };

    expect(result.usage.cache_creation_input_tokens).toBe(500);
    expect(result.usage.cache_read_input_tokens).toBe(2000);
  });

  test("result with permission denials", () => {
    const result: SDKResultSuccess = {
      type: "result",
      subtype: "success",
      duration_ms: 200,
      duration_api_ms: 150,
      is_error: false,
      num_turns: 1,
      result: "Partial result",
      stop_reason: "end_turn",
      total_cost_usd: 0.002,
      usage: {
        input_tokens: 200,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [
        {
          tool_name: "Bash",
          tool_use_id: "tool_123",
          tool_input: { command: "rm -rf /" },
        },
        {
          tool_name: "Write",
          tool_use_id: "tool_456",
          tool_input: { path: "/etc/passwd" },
        },
      ],
      uuid: "denied-uuid" as SDKResultSuccess["uuid"],
      session_id: "ses_denied",
    };

    expect(result.permission_denials).toHaveLength(2);
    expect(result.permission_denials[0].tool_name).toBe("Bash");
    expect(result.permission_denials[1].tool_name).toBe("Write");
  });

  test("result with multiple model usage", () => {
    const result: SDKResultSuccess = {
      type: "result",
      subtype: "success",
      duration_ms: 3000,
      duration_api_ms: 2500,
      is_error: false,
      num_turns: 5,
      result: "Complex task done",
      stop_reason: "end_turn",
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 5000,
        output_tokens: 2000,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 3000,
      },
      modelUsage: {
        "claude-sonnet-4-20250514": {
          inputTokens: 3000,
          outputTokens: 1200,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 500,
          webSearchRequests: 0,
          costUSD: 0.03,
          contextWindow: 200000,
          maxOutputTokens: 16384,
        },
        "claude-haiku-4-20250514": {
          inputTokens: 2000,
          outputTokens: 800,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 500,
          webSearchRequests: 0,
          costUSD: 0.02,
          contextWindow: 200000,
          maxOutputTokens: 16384,
        },
      },
      permission_denials: [],
      uuid: "multi-model-uuid" as SDKResultSuccess["uuid"],
      session_id: "ses_multi",
    };

    expect(Object.keys(result.modelUsage)).toHaveLength(2);
    expect(result.modelUsage["claude-sonnet-4-20250514"].costUSD).toBe(0.03);
    expect(result.modelUsage["claude-haiku-4-20250514"].costUSD).toBe(0.02);
  });
});

// ---------------------------------------------------------------------------
// SDKResultError type shape tests
// ---------------------------------------------------------------------------

describe("SDKResultError type validation", () => {
  test("error result has correct shape", () => {
    const result: SDKResultError = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 500,
      duration_api_ms: 400,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.001,
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors: ["API key expired", "Rate limit exceeded"],
      uuid: "error-uuid" as SDKResultError["uuid"],
      session_id: "ses_error",
    };

    expect(result.type).toBe("result");
    expect(result.subtype).toBe("error_during_execution");
    expect(result.is_error).toBe(true);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toBe("API key expired");
    expect(result.errors[1]).toBe("Rate limit exceeded");
  });

  test("max_turns error subtype", () => {
    const result: SDKResultError = {
      type: "result",
      subtype: "error_max_turns",
      duration_ms: 60000,
      duration_api_ms: 55000,
      is_error: true,
      num_turns: 50,
      stop_reason: null,
      total_cost_usd: 1.5,
      usage: {
        input_tokens: 50000,
        output_tokens: 20000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors: ["Exceeded maximum number of turns"],
      uuid: "max-turns-uuid" as SDKResultError["uuid"],
      session_id: "ses_max_turns",
    };

    expect(result.subtype).toBe("error_max_turns");
    expect(result.num_turns).toBe(50);
  });

  test("max_budget error subtype", () => {
    const result: SDKResultError = {
      type: "result",
      subtype: "error_max_budget_usd",
      duration_ms: 30000,
      duration_api_ms: 25000,
      is_error: true,
      num_turns: 10,
      stop_reason: null,
      total_cost_usd: 5.0,
      usage: {
        input_tokens: 100000,
        output_tokens: 50000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors: ["Exceeded maximum budget of $5.00"],
      uuid: "max-budget-uuid" as SDKResultError["uuid"],
      session_id: "ses_max_budget",
    };

    expect(result.subtype).toBe("error_max_budget_usd");
    expect(result.total_cost_usd).toBe(5.0);
  });

  test("error with empty errors array", () => {
    const result: SDKResultError = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors: [],
      uuid: "empty-error-uuid" as SDKResultError["uuid"],
      session_id: "ses_empty_error",
    };

    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SDKResultMessage discriminated union tests
// ---------------------------------------------------------------------------

describe("SDKResultMessage union discrimination", () => {
  function mockSuccess(text: string): SDKResultSuccess {
    return {
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      result: text,
      stop_reason: "end_turn",
      total_cost_usd: 0.001,
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "success-uuid" as SDKResultSuccess["uuid"],
      session_id: "ses_success",
    };
  }

  function mockError(errors: string[]): SDKResultError {
    return {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        input_tokens: 50,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      errors,
      uuid: "error-uuid" as SDKResultError["uuid"],
      session_id: "ses_error",
    };
  }

  test("can discriminate success from error by subtype", () => {
    const success: SDKResultMessage = mockSuccess("Done");
    const error: SDKResultMessage = mockError(["Failed"]);

    expect(success.subtype).toBe("success");
    expect(error.subtype).toBe("error_during_execution");
  });

  test("can discriminate success from error by is_error", () => {
    const success: SDKResultMessage = mockSuccess("Done");
    const error: SDKResultMessage = mockError(["Failed"]);

    expect(success.is_error).toBe(false);
    expect(error.is_error).toBe(true);
  });

  test("success has result field, error has errors field", () => {
    const success = mockSuccess("Response text");
    const error = mockError(["Error 1", "Error 2"]);

    if (success.subtype === "success") {
      expect(success.result).toBe("Response text");
    }
    if (error.subtype === "error_during_execution") {
      expect(error.errors).toEqual(["Error 1", "Error 2"]);
    }
  });

  test("both variants share common fields", () => {
    const success: SDKResultMessage = mockSuccess("Done");
    const error: SDKResultMessage = mockError(["Failed"]);

    // Both have type, duration_ms, total_cost_usd, usage, session_id
    expect(success.type).toBe("result");
    expect(error.type).toBe("result");
    expect(typeof success.duration_ms).toBe("number");
    expect(typeof error.duration_ms).toBe("number");
    expect(typeof success.total_cost_usd).toBe("number");
    expect(typeof error.total_cost_usd).toBe("number");
    expect(success.session_id).toBeDefined();
    expect(error.session_id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SDKMessage type discrimination (the full union)
// ---------------------------------------------------------------------------

describe("SDKMessage type discrimination", () => {
  test("system init message has correct type and subtype", () => {
    // Simulate the shape of an SDK system init message
    const msg: SDKSystemMessage = {
      type: "system",
      subtype: "init",
      agents: [],
      apiKeySource: "user",
      betas: [],
      claude_code_version: "2.1.45",
      cwd: "/Users/test/project",
      tools: ["Read", "Write", "Bash"],
      mcp_servers: [{ name: "talkto", status: "connected" }],
      model: "claude-sonnet-4-20250514",
      permissionMode: "bypassPermissions",
      slash_commands: ["/help", "/clear"],
      output_style: "text",
      skills: [],
      plugins: [],
      uuid: "init-uuid" as SDKSystemMessage["uuid"],
      session_id: "ses_init",
    };

    expect(msg.type).toBe("system");
    expect(msg.subtype).toBe("init");
    expect(msg.claude_code_version).toBe("2.1.45");
    expect(msg.tools).toContain("Read");
    expect(msg.mcp_servers).toHaveLength(1);
    expect(msg.mcp_servers[0].name).toBe("talkto");
    expect(msg.session_id).toBe("ses_init");
  });

  test("can switch on message.type for routing", () => {
    // Simulate processing a sequence of messages from query()
    const messages: Array<{ type: string; subtype?: string }> = [
      { type: "system", subtype: "init" },
      { type: "assistant" },
      { type: "stream_event" },
      { type: "stream_event" },
      { type: "stream_event" },
      { type: "result", subtype: "success" },
    ];

    const typeCounts: Record<string, number> = {};
    for (const msg of messages) {
      typeCounts[msg.type] = (typeCounts[msg.type] ?? 0) + 1;
    }

    expect(typeCounts["system"]).toBe(1);
    expect(typeCounts["assistant"]).toBe(1);
    expect(typeCounts["stream_event"]).toBe(3);
    expect(typeCounts["result"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Streaming event shape tests (SDKPartialAssistantMessage)
// ---------------------------------------------------------------------------

describe("stream_event message parsing", () => {
  test("content_block_delta with text_delta has correct shape", () => {
    // This is the shape of the event we extract text deltas from
    // in promptSessionWithEvents
    const streamMsg = {
      type: "stream_event" as const,
      event: {
        type: "content_block_delta" as const,
        index: 0,
        delta: {
          type: "text_delta" as const,
          text: "Hello, ",
        },
      },
      parent_tool_use_id: null,
      uuid: "stream-uuid",
      session_id: "ses_stream",
    };

    expect(streamMsg.type).toBe("stream_event");
    expect(streamMsg.event.type).toBe("content_block_delta");
    expect(streamMsg.event.delta.type).toBe("text_delta");
    expect(streamMsg.event.delta.text).toBe("Hello, ");
  });

  test("can extract text delta from stream_event", () => {
    // Simulate the extraction logic from promptSessionWithEvents
    const events = [
      {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "text_delta" as const, text: "Hello" },
      },
      {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "text_delta" as const, text: ", " },
      },
      {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "text_delta" as const, text: "world!" },
      },
    ];

    let accumulated = "";
    for (const event of events) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        accumulated += event.delta.text;
      }
    }

    expect(accumulated).toBe("Hello, world!");
  });

  test("ignores non-text-delta content blocks", () => {
    // The stream can contain tool_use deltas, thinking deltas, etc.
    const events = [
      {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "text_delta" as const, text: "answer: " },
      },
      {
        type: "content_block_start" as const,
        index: 1,
        content_block: { type: "tool_use", id: "tool_1", name: "Read", input: {} },
      },
      {
        type: "content_block_delta" as const,
        index: 1,
        delta: { type: "input_json_delta" as const, partial_json: '{"path":' },
      },
      {
        type: "content_block_delta" as const,
        index: 2,
        delta: { type: "text_delta" as const, text: "42" },
      },
    ];

    let accumulated = "";
    for (const event of events) {
      if (
        event.type === "content_block_delta" &&
        "delta" in event &&
        event.delta.type === "text_delta"
      ) {
        accumulated += event.delta.text;
      }
    }

    expect(accumulated).toBe("answer: 42");
  });

  test("handles empty text deltas", () => {
    const events = [
      {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "text_delta" as const, text: "" },
      },
      {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "text_delta" as const, text: "actual text" },
      },
      {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "text_delta" as const, text: "" },
      },
    ];

    let accumulated = "";
    for (const event of events) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        accumulated += event.delta.text;
      }
    }

    expect(accumulated).toBe("actual text");
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle simulation tests
// ---------------------------------------------------------------------------

describe("session lifecycle simulation", () => {
  const SESSION_A = "ses_lifecycle_a";
  const SESSION_B = "ses_lifecycle_b";

  beforeEach(() => {
    markSessionDead(SESSION_A);
    markSessionDead(SESSION_B);
  });

  test("registration → alive → invocation → still alive", async () => {
    // 1. Agent registers — marked alive
    markSessionAlive(SESSION_A);
    expect(await isSessionAlive(SESSION_A)).toBe(true);
    expect(await isSessionBusy(SESSION_A)).toBe(false);

    // 2. After successful invocation — still alive
    // (In real code, promptSession marks alive on success)
    markSessionAlive(SESSION_A);
    expect(await isSessionAlive(SESSION_A)).toBe(true);
  });

  test("registration → dead → ghost → re-register → alive", async () => {
    // 1. Agent registers
    markSessionAlive(SESSION_A);
    expect(await isSessionAlive(SESSION_A)).toBe(true);

    // 2. Session dies (e.g., process crash)
    markSessionDead(SESSION_A);
    expect(await isSessionAlive(SESSION_A)).toBe(false);

    // 3. Agent re-registers with same session ID
    markSessionAlive(SESSION_A);
    expect(await isSessionAlive(SESSION_A)).toBe(true);
  });

  test("multiple agents with independent lifecycles", async () => {
    // Both register
    markSessionAlive(SESSION_A);
    markSessionAlive(SESSION_B);
    expect(await isSessionAlive(SESSION_A)).toBe(true);
    expect(await isSessionAlive(SESSION_B)).toBe(true);

    // A dies, B stays alive
    markSessionDead(SESSION_A);
    expect(await isSessionAlive(SESSION_A)).toBe(false);
    expect(await isSessionAlive(SESSION_B)).toBe(true);

    // A re-registers
    markSessionAlive(SESSION_A);
    expect(await isSessionAlive(SESSION_A)).toBe(true);
    expect(await isSessionAlive(SESSION_B)).toBe(true);

    // Both die
    markSessionDead(SESSION_A);
    markSessionDead(SESSION_B);
    expect(await isSessionAlive(SESSION_A)).toBe(false);
    expect(await isSessionAlive(SESSION_B)).toBe(false);
  });

  test("rapid alive/dead toggling doesn't corrupt state", async () => {
    for (let i = 0; i < 100; i++) {
      markSessionAlive(SESSION_A);
      markSessionDead(SESSION_A);
    }
    // Final state: dead
    expect(await isSessionAlive(SESSION_A)).toBe(false);

    // Final alive
    markSessionAlive(SESSION_A);
    expect(await isSessionAlive(SESSION_A)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cost and token extraction patterns (mirrors how agent-invoker uses results)
// ---------------------------------------------------------------------------

describe("result extraction patterns (agent-invoker integration)", () => {
  function mockSuccess(overrides: Partial<SDKResultSuccess> = {}): SDKResultSuccess {
    return {
      type: "result",
      subtype: "success",
      duration_ms: 1000,
      duration_api_ms: 800,
      is_error: false,
      num_turns: 1,
      result: "Response text",
      stop_reason: "end_turn",
      total_cost_usd: 0.005,
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "mock-uuid" as SDKResultSuccess["uuid"],
      session_id: "ses_mock",
      ...overrides,
    };
  }

  test("extracts text, cost, and tokens in invoker pattern", () => {
    // This mirrors the extraction logic in claude.ts promptSession
    const success = mockSuccess({
      result: "The file has been updated.",
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 1500,
        output_tokens: 350,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    const extracted = {
      text: success.result,
      cost: success.total_cost_usd ?? 0,
      tokens: {
        input: success.usage?.input_tokens ?? 0,
        output: success.usage?.output_tokens ?? 0,
      },
    };

    expect(extracted.text).toBe("The file has been updated.");
    expect(extracted.cost).toBe(0.0123);
    expect(extracted.tokens.input).toBe(1500);
    expect(extracted.tokens.output).toBe(350);
  });

  test("handles zero-cost result", () => {
    const success = mockSuccess({
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    const cost = success.total_cost_usd ?? 0;
    const input = success.usage?.input_tokens ?? 0;
    const output = success.usage?.output_tokens ?? 0;

    expect(cost).toBe(0);
    expect(input).toBe(0);
    expect(output).toBe(0);
  });

  test("formats cost for logging like agent-invoker does", () => {
    const success = mockSuccess({ total_cost_usd: 0.00456 });
    const costStr = `$${(success.total_cost_usd).toFixed(4)}`;
    expect(costStr).toBe("$0.0046");
  });

  test("calculates response length for logging", () => {
    const longText = "x".repeat(5000);
    const success = mockSuccess({ result: longText });
    expect(success.result.length).toBe(5000);
  });
});
