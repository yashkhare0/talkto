/**
 * Feature request endpoints.
 */

import { Hono } from "hono";
import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import { featureRequests, featureVotes, users } from "../db/schema";
import { FeatureCreateSchema, FeatureUpdateSchema, FeatureVoteCreateSchema } from "../types";
import { broadcastEvent, featureUpdateEvent } from "../services/broadcaster";
import type { FeatureResponse } from "../types";

const app = new Hono();

// GET /features
app.get("/", (c) => {
  const status = c.req.query("status");
  const db = getDb();

  let query = db
    .select({
      id: featureRequests.id,
      title: featureRequests.title,
      description: featureRequests.description,
      status: featureRequests.status,
      reason: featureRequests.reason,
      createdBy: featureRequests.createdBy,
      createdAt: featureRequests.createdAt,
      updatedAt: featureRequests.updatedAt,
      voteCount: sql<number>`coalesce(sum(${featureVotes.vote}), 0)`,
    })
    .from(featureRequests)
    .leftJoin(featureVotes, eq(featureRequests.id, featureVotes.featureId))
    .groupBy(featureRequests.id)
    .$dynamic();

  if (status) {
    query = query.where(eq(featureRequests.status, status));
  }

  const rows = query.orderBy(desc(featureRequests.createdAt)).all();

  const result: FeatureResponse[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    reason: r.reason,
    created_by: r.createdBy,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    vote_count: Number(r.voteCount),
  }));

  return c.json(result);
});

// POST /features
app.post("/", async (c) => {
  const body = await c.req.json();
  const parsed = FeatureCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }
  const db = getDb();

  const human = db.select().from(users).where(eq(users.type, "human")).get();
  if (!human) {
    return c.json({ detail: "No user onboarded" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(featureRequests)
    .values({
      id,
      title: parsed.data.title,
      description: parsed.data.description,
      status: "open",
      createdBy: human.id,
      createdAt: now,
    })
    .run();

  broadcastEvent(
    featureUpdateEvent({
      featureId: id,
      title: parsed.data.title,
      status: "open",
      voteCount: 0,
      updateType: "created",
    })
  );

  return c.json(
    {
      id,
      title: parsed.data.title,
      description: parsed.data.description,
      status: "open",
      created_by: human.id,
      created_at: now,
      vote_count: 0,
    } satisfies FeatureResponse,
    201
  );
});

// PATCH /features/:featureId — update status (resolve, cancel, etc.)
app.patch("/:featureId", async (c) => {
  const featureId = c.req.param("featureId");
  const body = await c.req.json();
  const parsed = FeatureUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }
  const db = getDb();

  const feature = db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.id, featureId))
    .get();
  if (!feature) {
    return c.json({ detail: "Feature not found" }, 404);
  }

  const now = new Date().toISOString();
  db.update(featureRequests)
    .set({
      status: parsed.data.status,
      reason: parsed.data.reason ?? null,
      updatedAt: now,
    })
    .where(eq(featureRequests.id, featureId))
    .run();

  // Get vote count
  const countRow = db
    .select({ total: sql<number>`coalesce(sum(${featureVotes.vote}), 0)` })
    .from(featureVotes)
    .where(eq(featureVotes.featureId, featureId))
    .get();
  const voteCount = Number(countRow?.total ?? 0);

  broadcastEvent(
    featureUpdateEvent({
      featureId,
      title: feature.title,
      status: parsed.data.status,
      voteCount,
      updateType: "status_changed",
    })
  );

  return c.json({
    id: featureId,
    title: feature.title,
    description: feature.description,
    status: parsed.data.status,
    reason: parsed.data.reason ?? null,
    created_by: feature.createdBy,
    created_at: feature.createdAt,
    updated_at: now,
    vote_count: voteCount,
  } satisfies FeatureResponse);
});

// DELETE /features/:featureId — hard delete feature and its votes
app.delete("/:featureId", async (c) => {
  const featureId = c.req.param("featureId");
  const db = getDb();

  const feature = db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.id, featureId))
    .get();
  if (!feature) {
    return c.json({ detail: "Feature not found" }, 404);
  }

  // Delete votes first (FK constraint)
  db.delete(featureVotes).where(eq(featureVotes.featureId, featureId)).run();
  db.delete(featureRequests).where(eq(featureRequests.id, featureId)).run();

  broadcastEvent(
    featureUpdateEvent({
      featureId,
      title: feature.title,
      status: "deleted",
      updateType: "deleted",
    })
  );

  return c.json({ deleted: true, id: featureId });
});

// POST /features/:featureId/vote
app.post("/:featureId/vote", async (c) => {
  const featureId = c.req.param("featureId");
  const body = await c.req.json();
  const parsed = FeatureVoteCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }
  const db = getDb();

  // Verify feature exists
  const feature = db
    .select()
    .from(featureRequests)
    .where(eq(featureRequests.id, featureId))
    .get();
  if (!feature) {
    return c.json({ detail: "Feature not found" }, 404);
  }

  const human = db.select().from(users).where(eq(users.type, "human")).get();
  if (!human) {
    return c.json({ detail: "No user onboarded" }, 400);
  }

  // Upsert vote
  const existing = db
    .select()
    .from(featureVotes)
    .where(
      sql`${featureVotes.featureId} = ${featureId} AND ${featureVotes.userId} = ${human.id}`
    )
    .get();

  if (existing) {
    db.update(featureVotes)
      .set({ vote: parsed.data.vote })
      .where(
        sql`${featureVotes.featureId} = ${featureId} AND ${featureVotes.userId} = ${human.id}`
      )
      .run();
  } else {
    db.insert(featureVotes)
      .values({
        featureId,
        userId: human.id,
        vote: parsed.data.vote,
      })
      .run();
  }

  // Get updated vote count
  const countRow = db
    .select({
      total: sql<number>`coalesce(sum(${featureVotes.vote}), 0)`,
    })
    .from(featureVotes)
    .where(eq(featureVotes.featureId, featureId))
    .get();
  const voteCount = Number(countRow?.total ?? 0);

  broadcastEvent(
    featureUpdateEvent({
      featureId,
      title: feature.title,
      status: feature.status,
      voteCount,
      updateType: "voted",
    })
  );

  return c.json({ status: "voted", vote: parsed.data.vote });
});

export default app;
