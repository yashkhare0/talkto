/**
 * User onboarding & profile endpoints.
 */

import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { getDb, DEFAULT_WORKSPACE_ID } from "../db";
import {
  users,
  channels,
  messages,
  workspaceMembers,
  channelMembers,
  messageReactions,
  readReceipts,
  featureRequests,
  featureVotes,
  userSessions,
} from "../db/schema";
import { UserOnboardSchema } from "../types";
import { broadcastEvent, newMessageEvent } from "../services/broadcaster";
import { CREATOR_NAME } from "../services/name-generator";
import type { AppBindings, UserResponse } from "../types";

const app = new Hono<AppBindings>();

function userToResponse(u: typeof users.$inferSelect): UserResponse {
  return {
    id: u.id,
    name: u.name,
    type: u.type,
    created_at: u.createdAt,
    display_name: u.displayName,
    about: u.about,
    agent_instructions: u.agentInstructions,
  };
}

/** Have the_creator post a welcome for the new human operator in #general */
function postCreatorWelcome(displayName: string, about: string | null, workspaceId: string): void {
  const db = getDb();

  const creator = db
    .select()
    .from(users)
    .where(eq(users.name, CREATOR_NAME))
    .get();
  if (!creator) return;

  const general = db
    .select()
    .from(channels)
    .where(and(eq(channels.name, "#general"), eq(channels.workspaceId, workspaceId)))
    .get();
  if (!general) return;

  const aboutLine = about ? ` They say: *"${about.slice(0, 200)}"*` : "";

  const msgId = crypto.randomUUID();
  const now = new Date().toISOString();
  const content =
    `Everyone, meet **${displayName}** — ` +
    `they're running the show around here.${aboutLine}\n\n` +
    "Be cool. Be yourself. Make a good impression.";

  db.insert(messages)
    .values({
      id: msgId,
      channelId: general.id,
      senderId: creator.id,
      content,
      createdAt: now,
    })
    .run();

  broadcastEvent(
    newMessageEvent({
      messageId: msgId,
      channelId: general.id,
      senderId: creator.id,
      senderName: CREATOR_NAME,
      content,
      createdAt: now,
      senderType: "agent",
    })
  );
}

// POST /users/onboard
app.post("/onboard", async (c) => {
  const auth = c.get("auth");
  const body = await c.req.json();
  const parsed = UserOnboardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }
  const data = parsed.data;
  const db = getDb();
  const workspaceId = auth.workspaceId || DEFAULT_WORKSPACE_ID;

  // Check if human already exists — prefer auth context, fall back to type lookup
  const existing = auth.userId
    ? db.select().from(users).where(eq(users.id, auth.userId)).get()
    : db.select().from(users).where(eq(users.type, "human")).get();

  if (existing) {
    // Re-onboard: update fields
    db.update(users)
      .set({
        name: data.name,
        displayName: data.display_name ?? null,
        about: data.about ?? null,
        agentInstructions: data.agent_instructions ?? null,
      })
      .where(eq(users.id, existing.id))
      .run();

    // Ensure workspace membership exists
    const membership = db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, existing.id)
        )
      )
      .get();
    if (!membership) {
      db.insert(workspaceMembers)
        .values({
          workspaceId,
          userId: existing.id,
          role: "admin",
          joinedAt: new Date().toISOString(),
        })
        .run();
    }

    const updated = db.select().from(users).where(eq(users.id, existing.id)).get()!;
    return c.json(userToResponse(updated), 201);
  }

  // New onboard
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(users)
    .values({
      id: userId,
      name: data.name,
      type: "human",
      createdAt: now,
      displayName: data.display_name ?? null,
      about: data.about ?? null,
      agentInstructions: data.agent_instructions ?? null,
    })
    .run();

  // Create workspace membership for new user
  db.insert(workspaceMembers)
    .values({
      workspaceId,
      userId,
      role: "admin",
      joinedAt: now,
    })
    .run();

  // Fire-and-forget: creator welcome
  const welcomeName = data.display_name ?? data.name;
  try {
    postCreatorWelcome(welcomeName, data.about ?? null, workspaceId);
  } catch (e) {
    console.error("Failed to post creator welcome:", e);
  }

  const user = db.select().from(users).where(eq(users.id, userId)).get()!;
  return c.json(userToResponse(user), 201);
});

// GET /users/me
app.get("/me", (c) => {
  const auth = c.get("auth");
  const db = getDb();
  const user = auth.userId
    ? db.select().from(users).where(eq(users.id, auth.userId)).get()
    : db.select().from(users).where(eq(users.type, "human")).get();
  if (!user) {
    return c.json({ detail: "No human user onboarded yet" }, 404);
  }
  return c.json(userToResponse(user));
});

// PATCH /users/me
app.patch("/me", async (c) => {
  const auth = c.get("auth");
  const body = await c.req.json();
  const parsed = UserOnboardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ detail: parsed.error.message }, 400);
  }
  const data = parsed.data;
  const db = getDb();

  const user = auth.userId
    ? db.select().from(users).where(eq(users.id, auth.userId)).get()
    : db.select().from(users).where(eq(users.type, "human")).get();
  if (!user) {
    return c.json({ detail: "No human user onboarded yet" }, 404);
  }

  db.update(users)
    .set({
      name: data.name,
      displayName: data.display_name ?? null,
      about: data.about ?? null,
      agentInstructions: data.agent_instructions ?? null,
    })
    .where(eq(users.id, user.id))
    .run();

  const updated = db.select().from(users).where(eq(users.id, user.id)).get()!;
  return c.json(userToResponse(updated));
});

// DELETE /users/me
app.delete("/me", (c) => {
  const auth = c.get("auth");
  const db = getDb();
  const user = auth.userId
    ? db.select().from(users).where(eq(users.id, auth.userId)).get()
    : db.select().from(users).where(eq(users.type, "human")).get();
  if (user) {
    console.warn(
      `Deleting human user '${user.displayName ?? user.name}' (id=${user.id})`
    );

    // Clean up dependents in FK-safe order (children before parent).
    // With CASCADE FKs on new DBs this is redundant but ensures
    // correctness on older DBs that haven't run the migration yet.
    const userMsgIds = db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.senderId, user.id))
      .all()
      .map((m) => m.id);
    if (userMsgIds.length > 0) {
      db.delete(messageReactions)
        .where(inArray(messageReactions.messageId, userMsgIds))
        .run();
    }
    db.delete(messageReactions)
      .where(eq(messageReactions.userId, user.id))
      .run();
    db.delete(messages)
      .where(eq(messages.senderId, user.id))
      .run();
    db.delete(readReceipts)
      .where(eq(readReceipts.userId, user.id))
      .run();
    db.delete(channelMembers)
      .where(eq(channelMembers.userId, user.id))
      .run();
    db.delete(featureVotes)
      .where(eq(featureVotes.userId, user.id))
      .run();
    db.delete(featureRequests)
      .where(eq(featureRequests.createdBy, user.id))
      .run();
    db.delete(userSessions)
      .where(eq(userSessions.userId, user.id))
      .run();
    db.delete(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id))
      .run();
    db.delete(users).where(eq(users.id, user.id)).run();
  }
  return c.body(null, 204);
});

export default app;
