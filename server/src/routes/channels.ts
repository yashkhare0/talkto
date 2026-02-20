/**
 * Channel CRUD endpoints.
 */

import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import { getDb } from "../db";
import { channels } from "../db/schema";
import { ChannelCreateSchema, ChannelTopicSchema } from "../types";
import type { ChannelResponse } from "../types";

const app = new Hono();

function channelToResponse(ch: typeof channels.$inferSelect): ChannelResponse {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    topic: ch.topic,
    project_path: ch.projectPath,
    created_by: ch.createdBy,
    created_at: ch.createdAt,
  };
}

// GET /channels
app.get("/", (c) => {
  const db = getDb();
  const result = db.select().from(channels).orderBy(asc(channels.name)).all();
  return c.json(result.map(channelToResponse));
});

// POST /channels
app.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = ChannelCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }

  const name = parsed.data.name.startsWith("#")
    ? parsed.data.name
    : `#${parsed.data.name}`;
  const db = getDb();

  // Check uniqueness
  const existing = db.select().from(channels).where(eq(channels.name, name)).get();
  if (existing) {
    return c.json({ detail: `Channel ${name} already exists` }, 409);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(channels)
    .values({
      id,
      name,
      type: "custom",
      createdBy: "human",
      createdAt: now,
    })
    .run();

  const channel = db.select().from(channels).where(eq(channels.id, id)).get()!;
  return c.json(channelToResponse(channel), 201);
});

// PATCH /channels/:channelId/topic — set channel topic
app.patch("/:channelId/topic", async (c) => {
  const body = await c.req.json();
  const parsed = ChannelTopicSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }

  const db = getDb();
  const channel = db
    .select()
    .from(channels)
    .where(eq(channels.id, c.req.param("channelId")))
    .get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }

  db.update(channels)
    .set({ topic: parsed.data.topic || null })
    .where(eq(channels.id, channel.id))
    .run();

  const updated = db.select().from(channels).where(eq(channels.id, channel.id)).get()!;
  return c.json(channelToResponse(updated));
});

// GET /channels/:channelId
app.get("/:channelId", (c) => {
  const db = getDb();
  const channel = db
    .select()
    .from(channels)
    .where(eq(channels.id, c.req.param("channelId")))
    .get();
  if (!channel) {
    return c.json({ detail: "Channel not found" }, 404);
  }
  return c.json(channelToResponse(channel));
});

export default app;
