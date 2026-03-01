/**
 * Tests for message ownership checks and safe JSON handling.
 *
 * Verifies that:
 * - Only message authors can edit/delete their own messages
 * - Malformed JSON returns 400 (not a server crash)
 * - POST response includes actual parent_id
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../src/db";
import { users, channels, messages, agents } from "../src/db/schema";
import { eq } from "drizzle-orm";

let app: Hono;

// Cached IDs
let generalChannelId: string;
let humanUserId: string;
let agentUserId: string; // the_creator's user ID

function req(method: string, path: string, body?: unknown) {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

/** Send a raw request with a raw string body (for malformed JSON tests) */
function rawReq(method: string, path: string, rawBody: string) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
}

beforeAll(async () => {
  process.env.TALKTO_PORT = "8100";
  const mod = await import("../src/index");
  app = mod.app;

  const db = getDb();

  const general = db.select().from(channels).where(eq(channels.name, "#general")).get();
  if (!general) throw new Error("Seed data missing: #general channel");
  generalChannelId = general.id;

  // Ensure a human user exists
  const human = db.select().from(users).where(eq(users.type, "human")).get();
  if (!human) {
    const onboardRes = await app.fetch(
      req("POST", "/api/users/onboard", {
        name: "test-boss",
        display_name: "the Boss",
      })
    );
    const data = await onboardRes.json();
    humanUserId = data.id;
  } else {
    humanUserId = human.id;
  }

  // Find the_creator agent's user ID (system-seeded agent)
  const creator = db.select().from(agents).where(eq(agents.agentName, "the_creator")).get();
  if (!creator) throw new Error("Seed data missing: the_creator agent");
  agentUserId = creator.id;
});

/**
 * Insert a message directly into the DB as the_creator (bypassing API).
 * This simulates a message sent by a different user.
 */
function insertAgentMessage(channelId: string, content: string): string {
  const db = getDb();
  const msgId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.insert(messages)
    .values({
      id: msgId,
      channelId,
      senderId: agentUserId,
      content,
      createdAt: now,
    })
    .run();
  return msgId;
}

// ---------------------------------------------------------------------------
// Ownership checks on PATCH (Edit)
// ---------------------------------------------------------------------------

describe("Message ownership — PATCH (Edit)", () => {
  it("allows editing own message", async () => {
    // Create a message as the human (via API)
    const createRes = await app.fetch(
      req("POST", `/api/channels/${generalChannelId}/messages`, {
        content: "My own message for edit test",
      })
    );
    const created = await createRes.json();

    const editRes = await app.fetch(
      req("PATCH", `/api/channels/${generalChannelId}/messages/${created.id}`, {
        content: "Edited by me",
      })
    );
    expect(editRes.status).toBe(200);
    const edited = await editRes.json();
    expect(edited.content).toBe("Edited by me");
  });

  it("rejects editing another user's message with 403", async () => {
    // Insert a message as the_creator (not the human)
    const agentMsgId = insertAgentMessage(generalChannelId, "Agent message — hands off");

    const editRes = await app.fetch(
      req("PATCH", `/api/channels/${generalChannelId}/messages/${agentMsgId}`, {
        content: "Trying to edit agent's message",
      })
    );
    expect(editRes.status).toBe(403);
    const data = await editRes.json();
    expect(data.detail).toContain("own messages");
  });
});

// ---------------------------------------------------------------------------
// Ownership checks on DELETE
// ---------------------------------------------------------------------------

describe("Message ownership — DELETE", () => {
  it("allows deleting own message", async () => {
    const createRes = await app.fetch(
      req("POST", `/api/channels/${generalChannelId}/messages`, {
        content: "My own message for delete test",
      })
    );
    const created = await createRes.json();

    const deleteRes = await app.fetch(
      req("DELETE", `/api/channels/${generalChannelId}/messages/${created.id}`)
    );
    expect(deleteRes.status).toBe(200);
    const data = await deleteRes.json();
    expect(data.deleted).toBe(true);
  });

  it("rejects deleting another user's message with 403", async () => {
    const agentMsgId = insertAgentMessage(generalChannelId, "Agent message — do not delete");

    const deleteRes = await app.fetch(
      req("DELETE", `/api/channels/${generalChannelId}/messages/${agentMsgId}`)
    );
    expect(deleteRes.status).toBe(403);
    const data = await deleteRes.json();
    expect(data.detail).toContain("own messages");
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON body handling
// ---------------------------------------------------------------------------

describe("Malformed JSON body", () => {
  it("POST message with malformed JSON returns 400", async () => {
    const res = await app.fetch(
      rawReq("POST", `/api/channels/${generalChannelId}/messages`, "{not valid json")
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toBeDefined();
  });

  it("PATCH message with malformed JSON returns 400", async () => {
    // Create a valid message first
    const createRes = await app.fetch(
      req("POST", `/api/channels/${generalChannelId}/messages`, {
        content: "Will try to edit with bad JSON",
      })
    );
    const created = await createRes.json();

    const res = await app.fetch(
      rawReq(
        "PATCH",
        `/api/channels/${generalChannelId}/messages/${created.id}`,
        "{{invalid"
      )
    );
    expect(res.status).toBe(400);
  });

  it("POST react with malformed JSON returns 400", async () => {
    const createRes = await app.fetch(
      req("POST", `/api/channels/${generalChannelId}/messages`, {
        content: "Will try to react with bad JSON",
      })
    );
    const created = await createRes.json();

    const res = await app.fetch(
      rawReq(
        "POST",
        `/api/channels/${generalChannelId}/messages/${created.id}/react`,
        "not-json"
      )
    );
    expect(res.status).toBe(400);
  });

  it("POST to features with malformed JSON returns 400", async () => {
    const res = await app.fetch(
      rawReq("POST", "/api/features", "{broken json")
    );
    expect(res.status).toBe(400);
  });

  it("POST to channels with malformed JSON returns 400", async () => {
    const res = await app.fetch(
      rawReq("POST", "/api/channels", "{nope")
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST response includes actual parent_id
// ---------------------------------------------------------------------------

describe("POST response — parent_id", () => {
  it("includes parent_id in response when replying", async () => {
    // Create a parent message
    const parentRes = await app.fetch(
      req("POST", `/api/channels/${generalChannelId}/messages`, {
        content: "I am the parent",
      })
    );
    const parent = await parentRes.json();

    // Reply to it
    const replyRes = await app.fetch(
      req("POST", `/api/channels/${generalChannelId}/messages`, {
        content: "I am the reply",
        parent_id: parent.id,
      })
    );
    expect(replyRes.status).toBe(201);
    const reply = await replyRes.json();
    expect(reply.parent_id).toBe(parent.id);
  });

  it("includes null parent_id for top-level messages", async () => {
    const res = await app.fetch(
      req("POST", `/api/channels/${generalChannelId}/messages`, {
        content: "Top-level message",
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.parent_id).toBeNull();
  });
});
