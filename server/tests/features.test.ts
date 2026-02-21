/**
 * Feature request management tests — Zod validation, DB round-trip,
 * and broadcaster events.
 */

import { describe, test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "./setup";
import { users, featureRequests, featureVotes } from "../src/db/schema";
import { FeatureUpdateSchema, FeatureCreateSchema } from "../src/types/index";
import { featureUpdateEvent } from "../src/services/broadcaster";

// ---------------------------------------------------------------------------
// FeatureUpdateSchema Zod validation
// ---------------------------------------------------------------------------

describe("FeatureUpdateSchema", () => {
  test("accepts valid status change", () => {
    const result = FeatureUpdateSchema.safeParse({ status: "done" });
    expect(result.success).toBe(true);
  });

  test("accepts status with reason", () => {
    const result = FeatureUpdateSchema.safeParse({
      status: "wontfix",
      reason: "Out of scope for v1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("wontfix");
      expect(result.data.reason).toBe("Out of scope for v1");
    }
  });

  test("accepts all valid statuses", () => {
    const statuses = ["open", "planned", "in_progress", "done", "closed", "wontfix"];
    for (const status of statuses) {
      const result = FeatureUpdateSchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid status", () => {
    const result = FeatureUpdateSchema.safeParse({ status: "cancelled" });
    expect(result.success).toBe(false);
  });

  test("rejects empty status", () => {
    const result = FeatureUpdateSchema.safeParse({ status: "" });
    expect(result.success).toBe(false);
  });

  test("rejects reason exceeding max length", () => {
    const result = FeatureUpdateSchema.safeParse({
      status: "closed",
      reason: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  test("accepts reason at max length", () => {
    const result = FeatureUpdateSchema.safeParse({
      status: "closed",
      reason: "x".repeat(500),
    });
    expect(result.success).toBe(true);
  });

  test("accepts status without reason (optional)", () => {
    const result = FeatureUpdateSchema.safeParse({ status: "planned" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Database: feature_requests with reason and updated_at
// ---------------------------------------------------------------------------

describe("Feature requests DB round-trip", () => {
  function seedUser(db: ReturnType<typeof createTestDb>) {
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    db.insert(users)
      .values({ id: userId, name: "human", type: "human", createdAt: now })
      .run();
    return { userId, now };
  }

  test("stores and retrieves reason and updatedAt", () => {
    const db = createTestDb();
    const { userId, now } = seedUser(db);
    const id = crypto.randomUUID();

    db.insert(featureRequests)
      .values({
        id,
        title: "Test Feature",
        description: "A feature",
        status: "closed",
        reason: "Duplicate of #42",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = db.select().from(featureRequests).where(eq(featureRequests.id, id)).get();
    expect(row).toBeDefined();
    expect(row!.status).toBe("closed");
    expect(row!.reason).toBe("Duplicate of #42");
    expect(row!.updatedAt).toBe(now);
  });

  test("stores null reason and updatedAt when not provided", () => {
    const db = createTestDb();
    const { userId, now } = seedUser(db);
    const id = crypto.randomUUID();

    db.insert(featureRequests)
      .values({
        id,
        title: "Open Feature",
        description: "Needs work",
        status: "open",
        createdBy: userId,
        createdAt: now,
      })
      .run();

    const row = db.select().from(featureRequests).where(eq(featureRequests.id, id)).get();
    expect(row!.reason).toBeNull();
    expect(row!.updatedAt).toBeNull();
  });

  test("updates status and reason on existing feature", () => {
    const db = createTestDb();
    const { userId, now } = seedUser(db);
    const id = crypto.randomUUID();

    db.insert(featureRequests)
      .values({
        id,
        title: "Feature X",
        description: "Do something",
        status: "open",
        createdBy: userId,
        createdAt: now,
      })
      .run();

    const updatedAt = new Date().toISOString();
    db.update(featureRequests)
      .set({ status: "wontfix", reason: "Not aligned with roadmap", updatedAt })
      .where(eq(featureRequests.id, id))
      .run();

    const row = db.select().from(featureRequests).where(eq(featureRequests.id, id)).get();
    expect(row!.status).toBe("wontfix");
    expect(row!.reason).toBe("Not aligned with roadmap");
    expect(row!.updatedAt).toBe(updatedAt);
  });

  test("deletes feature and its votes", () => {
    const db = createTestDb();
    const { userId, now } = seedUser(db);
    const featureId = crypto.randomUUID();

    db.insert(featureRequests)
      .values({
        id: featureId,
        title: "To Delete",
        description: "Gone soon",
        status: "open",
        createdBy: userId,
        createdAt: now,
      })
      .run();

    db.insert(featureVotes)
      .values({ featureId, userId, vote: 1 })
      .run();

    // Verify vote exists
    const votes = db.select().from(featureVotes).where(eq(featureVotes.featureId, featureId)).all();
    expect(votes).toHaveLength(1);

    // Delete votes then feature
    db.delete(featureVotes).where(eq(featureVotes.featureId, featureId)).run();
    db.delete(featureRequests).where(eq(featureRequests.id, featureId)).run();

    const deleted = db.select().from(featureRequests).where(eq(featureRequests.id, featureId)).get();
    expect(deleted).toBeUndefined();

    const deletedVotes = db.select().from(featureVotes).where(eq(featureVotes.featureId, featureId)).all();
    expect(deletedVotes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Broadcaster: featureUpdateEvent
// ---------------------------------------------------------------------------

describe("featureUpdateEvent", () => {
  test("emits status_changed event", () => {
    const event = featureUpdateEvent({
      featureId: "f1",
      title: "Cool Feature",
      status: "done",
      voteCount: 5,
      updateType: "status_changed",
    });
    expect(event.type).toBe("feature_update");
    expect(event.data.id).toBe("f1");
    expect(event.data.status).toBe("done");
    expect(event.data.vote_count).toBe(5);
    expect(event.data.update_type).toBe("status_changed");
  });

  test("emits deleted event", () => {
    const event = featureUpdateEvent({
      featureId: "f2",
      title: "Dead Feature",
      status: "deleted",
      updateType: "deleted",
    });
    expect(event.data.status).toBe("deleted");
    expect(event.data.update_type).toBe("deleted");
    expect(event.data.vote_count).toBe(0);
  });
});
