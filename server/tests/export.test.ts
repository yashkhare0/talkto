/**
 * Channel export API tests.
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../src/db";
import { users, channels, messages } from "../src/db/schema";
import { eq } from "drizzle-orm";

let app: Hono;
let generalChannelId: string;

beforeAll(async () => {
  process.env.TALKTO_PORT = "8091";
  const mod = await import("../src/index");
  app = mod.app;

  const db = getDb();
  const general = db
    .select()
    .from(channels)
    .where(eq(channels.name, "#general"))
    .get();
  if (!general) throw new Error("Seed data missing: #general channel");
  generalChannelId = general.id;

  // Ensure a human user exists
  const human = db.select().from(users).where(eq(users.type, "human")).get();
  if (!human) {
    await app.fetch(req("POST", "/api/users/onboard", { name: "export-tester" }));
  }
});

function req(method: string, path: string, body?: unknown) {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

describe("Channel Export", () => {
  it("GET /channels/:id/export returns channel history", async () => {
    const res = await app.fetch(
      req("GET", `/api/channels/${generalChannelId}/export`)
    );
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.channel).toBeDefined();
    expect(data.channel.id).toBe(generalChannelId);
    expect(data.channel.name).toBe("#general");
    expect(data.exported_at).toBeDefined();
    expect(typeof data.message_count).toBe("number");
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBe(data.message_count);

    // If messages exist, check structure
    if (data.messages.length > 0) {
      const msg = data.messages[0];
      expect(msg.id).toBeDefined();
      expect(msg.sender_name).toBeDefined();
      expect(msg.content).toBeDefined();
      expect(msg.created_at).toBeDefined();
    }
  });

  it("sets Content-Disposition header", async () => {
    const res = await app.fetch(
      req("GET", `/api/channels/${generalChannelId}/export`)
    );
    const disposition = res.headers.get("content-disposition");
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("general-export.json");
  });

  it("returns 404 for unknown channel", async () => {
    const res = await app.fetch(
      req("GET", "/api/channels/nonexistent-id/export")
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for unsupported format", async () => {
    const res = await app.fetch(
      req("GET", `/api/channels/${generalChannelId}/export?format=csv`)
    );
    expect(res.status).toBe(400);
  });

  it("messages are sorted chronologically (ascending)", async () => {
    const res = await app.fetch(
      req("GET", `/api/channels/${generalChannelId}/export`)
    );
    const data = await res.json();
    if (data.messages.length > 1) {
      for (let i = 1; i < data.messages.length; i++) {
        expect(data.messages[i].created_at >= data.messages[i - 1].created_at).toBe(true);
      }
    }
  });
});
