/**
 * Channel management utilities — used by MCP tools and REST API.
 */

import { eq, and } from "drizzle-orm";
import { getDb } from "../db";
import { agents, channels, channelMembers } from "../db/schema";
import { broadcastEvent, channelCreatedEvent } from "./broadcaster";

export function listAllChannels(): Array<{
  id: string;
  name: string;
  type: string;
  topic: string | null;
  project_path: string | null;
}> {
  const db = getDb();
  return db
    .select()
    .from(channels)
    .orderBy(channels.name)
    .all()
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      topic: ch.topic,
      project_path: ch.projectPath,
    }));
}

export function joinAgentToChannel(
  agentName: string,
  channelName: string
): Record<string, unknown> {
  const db = getDb();
  const now = new Date().toISOString();

  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.agentName, agentName))
    .get();
  if (!agent) return { error: "Agent not found." };

  const ch = db.select().from(channels).where(eq(channels.name, channelName)).get();
  if (!ch) return { error: `Channel '${channelName}' not found.` };

  // Check if already member
  const existing = db
    .select()
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, ch.id),
        eq(channelMembers.userId, agent.id)
      )
    )
    .get();
  if (existing) return { status: "already_member" };

  db.insert(channelMembers)
    .values({ channelId: ch.id, userId: agent.id, joinedAt: now })
    .run();

  return { status: "joined", channel: channelName };
}

export function createNewChannel(
  name: string,
  createdBy: string
): Record<string, unknown> {
  const channelName = name.startsWith("#") ? name : `#${name}`;
  const db = getDb();

  const existing = db
    .select()
    .from(channels)
    .where(eq(channels.name, channelName))
    .get();
  if (existing) return { error: `Channel '${channelName}' already exists.` };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.insert(channels)
    .values({
      id,
      name: channelName,
      type: "custom",
      createdBy,
      createdAt: now,
    })
    .run();

  broadcastEvent(
    channelCreatedEvent({
      channelId: id,
      channelName,
      channelType: "custom",
    })
  );

  return { id, name: channelName, type: "custom" };
}

export function setChannelTopic(
  channelName: string,
  topic: string
): Record<string, unknown> {
  const db = getDb();
  const ch = db.select().from(channels).where(eq(channels.name, channelName)).get();
  if (!ch) return { error: `Channel '${channelName}' not found.` };

  db.update(channels)
    .set({ topic: topic || null })
    .where(eq(channels.id, ch.id))
    .run();

  return { status: "updated", channel: channelName, topic: topic || null };
}
