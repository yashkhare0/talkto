/**
 * Search endpoint — full-text message search across channels with snippet highlighting.
 *
 * GET /api/search?q=<query>&limit=<n>&channel=<name>
 *
 * Returns matching messages with highlighted content snippets showing
 * the search term in context, plus channel and sender metadata.
 */

import { Hono } from "hono";
import { eq, desc, like, sql, and } from "drizzle-orm";
import { getDb } from "../db";
import { channels, messages, users } from "../db/schema";
import type { AppBindings } from "../types";

const app = new Hono<AppBindings>();

/**
 * Generate a content snippet with the matched term highlighted using <mark> tags.
 * Returns a window of text around the first match occurrence.
 */
export function highlightSnippet(
  content: string,
  query: string,
  contextChars = 80
): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIdx = lowerContent.indexOf(lowerQuery);

  if (matchIdx === -1) {
    // Shouldn't happen since SQL already filtered, but fallback gracefully
    return content.length > contextChars * 2
      ? content.slice(0, contextChars * 2) + "…"
      : content;
  }

  // Calculate window boundaries
  const start = Math.max(0, matchIdx - contextChars);
  const end = Math.min(content.length, matchIdx + query.length + contextChars);

  let snippet = content.slice(start, end);

  // Add ellipsis indicators
  if (start > 0) snippet = "…" + snippet;
  if (end < content.length) snippet = snippet + "…";

  // Wrap matched text in <mark> tags (case-insensitive replace within snippet)
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  snippet = snippet.replace(
    new RegExp(escapedQuery, "gi"),
    (match) => `<mark>${match}</mark>`
  );

  return snippet;
}

/** GET /search — search messages across channels within the current workspace. */
app.get("/", (c) => {
  const auth = c.get("auth");
  const query = c.req.query("q");
  if (!query || query.trim().length === 0) {
    return c.json({ detail: "Query parameter 'q' is required" }, 400);
  }
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 50);
  const channelFilter = c.req.query("channel"); // optional channel name filter

  const db = getDb();

  // Escape LIKE wildcards to prevent '%' or '_' in user input from matching everything
  const escapedQuery = query.replace(/%/g, "\\%").replace(/_/g, "\\_");

  // Base conditions: text match + workspace scoping
  const conditions = [
    like(messages.content, `%${escapedQuery}%`),
    eq(channels.workspaceId, auth.workspaceId),
  ];
  if (channelFilter) {
    conditions.push(eq(channels.name, channelFilter));
  }

  const rows = db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      channelName: channels.name,
      senderId: messages.senderId,
      senderName: sql`coalesce(${users.displayName}, ${users.name})`,
      senderType: users.type,
      content: messages.content,
      mentions: messages.mentions,
      parentId: messages.parentId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(users, eq(messages.senderId, users.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .all();

  const results = rows.map((row: Record<string, unknown>) => ({
    id: row.id,
    channel_id: row.channelId,
    channel_name: row.channelName,
    sender_id: row.senderId,
    sender_name: row.senderName,
    sender_type: row.senderType,
    content: row.content,
    snippet: highlightSnippet(row.content as string, query),
    mentions: row.mentions ? JSON.parse(row.mentions as string) : null,
    parent_id: row.parentId,
    created_at: row.createdAt,
  }));

  return c.json({ query, results, count: results.length });
});

export default app;
