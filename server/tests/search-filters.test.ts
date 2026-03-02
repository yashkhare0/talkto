/**
 * Search filter tests — sender, after, before query params.
 */

import { describe, expect, it, beforeAll } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../src/db";
import { users, channels, messages } from "../src/db/schema";
import { eq } from "drizzle-orm";

let app: Hono;

beforeAll(async () => {
  process.env.TALKTO_PORT = "8092";
  const mod = await import("../src/index");
  app = mod.app;

  // Ensure human exists
  const db = getDb();
  const human = db.select().from(users).where(eq(users.type, "human")).get();
  if (!human) {
    await app.fetch(req("POST", "/api/users/onboard", { name: "search-tester" }));
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

describe("Search Filters", () => {
  it("accepts sender filter param", async () => {
    const res = await app.fetch(
      req("GET", "/api/search?q=hello&sender=nonexistent-user")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.results).toEqual([]);
  });

  it("accepts after date filter", async () => {
    const res = await app.fetch(
      req("GET", "/api/search?q=test&after=2099-01-01T00:00:00Z")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    // No messages should exist after 2099
    expect(data.results).toEqual([]);
  });

  it("accepts before date filter", async () => {
    const res = await app.fetch(
      req("GET", "/api/search?q=test&before=2000-01-01T00:00:00Z")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    // No messages should exist before 2000
    expect(data.results).toEqual([]);
  });

  it("combines multiple filters", async () => {
    const res = await app.fetch(
      req("GET", "/api/search?q=test&sender=nobody&after=2000-01-01T00:00:00Z&before=2099-01-01T00:00:00Z")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.results)).toBe(true);
  });

  it("still requires q param", async () => {
    const res = await app.fetch(
      req("GET", "/api/search?sender=someone")
    );
    expect(res.status).toBe(400);
  });
});
