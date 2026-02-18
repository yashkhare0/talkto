/**
 * Event broadcasting — event factories matching the Python backend's format.
 *
 * All events have shape: { type: "event_name", data: { ... } }
 * Single-process: broadcasts directly via ws-manager (no HTTP relay needed).
 */

import { broadcast } from "./ws-manager";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface WsEvent {
  type: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event factories — match Python backend signatures exactly
// ---------------------------------------------------------------------------

export function newMessageEvent(opts: {
  messageId: string;
  channelId: string;
  senderId: string;
  senderName: string;
  content: string;
  mentions?: string[] | null;
  parentId?: string | null;
  createdAt?: string;
  senderType?: string;
}): WsEvent {
  return {
    type: "new_message",
    data: {
      id: opts.messageId,
      channel_id: opts.channelId,
      sender_id: opts.senderId,
      sender_name: opts.senderName,
      sender_type: opts.senderType ?? "agent",
      content: opts.content,
      mentions: opts.mentions ?? [],
      parent_id: opts.parentId ?? null,
      created_at: opts.createdAt ?? "",
    },
  };
}

export function agentStatusEvent(opts: {
  agentName: string;
  status: string;
  agentType?: string;
  projectName?: string;
}): WsEvent {
  return {
    type: "agent_status",
    data: {
      agent_name: opts.agentName,
      status: opts.status,
      agent_type: opts.agentType ?? "",
      project_name: opts.projectName ?? "",
    },
  };
}

export function channelCreatedEvent(opts: {
  channelId: string;
  channelName: string;
  channelType?: string;
  projectPath?: string | null;
}): WsEvent {
  return {
    type: "channel_created",
    data: {
      id: opts.channelId,
      name: opts.channelName,
      type: opts.channelType ?? "project",
      project_path: opts.projectPath ?? null,
    },
  };
}

export function agentTypingEvent(
  agentName: string,
  channelId: string,
  isTyping: boolean,
  error?: string
): WsEvent {
  const data: Record<string, unknown> = {
    agent_name: agentName,
    channel_id: channelId,
    is_typing: isTyping,
  };
  if (error) data.error = error;
  return { type: "agent_typing", data };
}

export function agentStreamingEvent(
  agentName: string,
  channelId: string,
  delta: string
): WsEvent {
  return {
    type: "agent_streaming",
    data: {
      agent_name: agentName,
      channel_id: channelId,
      delta,
    },
  };
}

export function featureUpdateEvent(opts: {
  featureId: string;
  title: string;
  status: string;
  voteCount?: number;
  updateType?: string;
}): WsEvent {
  return {
    type: "feature_update",
    data: {
      id: opts.featureId,
      title: opts.title,
      status: opts.status,
      vote_count: opts.voteCount ?? 0,
      update_type: opts.updateType ?? "created",
    },
  };
}

// ---------------------------------------------------------------------------
// Broadcast helper
// ---------------------------------------------------------------------------

export function broadcastEvent(event: WsEvent): void {
  broadcast(event as unknown as Record<string, unknown>);
}
