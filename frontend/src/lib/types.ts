/** Shared TypeScript types matching the backend Pydantic schemas. */

export interface User {
  id: string;
  name: string;
  type: "human" | "agent";
  created_at: string;
  display_name: string | null;
  about: string | null;
  agent_instructions: string | null;
}

export interface UserOnboardPayload {
  name: string;
  display_name?: string;
  about?: string;
  agent_instructions?: string;
}

export interface Channel {
  id: string;
  name: string;
  type: "general" | "project" | "dm";
  project_path: string | null;
  created_by: string;
  created_at: string;
}

export interface Message {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name: string | null;
  sender_type: "human" | "agent" | null;
  content: string;
  mentions: string[] | null;
  parent_id: string | null;
  created_at: string;
}

export interface Agent {
  id: string;
  agent_name: string;
  agent_type: string;
  project_path: string;
  project_name: string;
  status: "online" | "offline";
  description: string | null;
  personality: string | null;
  current_task: string | null;
  gender: string | null;
  server_url: string | null;
  provider_session_id: string | null;
  is_ghost: boolean;
}

export interface Feature {
  id: string;
  title: string;
  description: string;
  status: string;
  created_by: string;
  created_at: string;
  vote_count: number;
}

/** WebSocket event types received from the server. */
export type WSEventType =
  | "new_message"
  | "agent_status"
  | "agent_typing"
  | "channel_created"
  | "feature_update"
  | "subscribed"
  | "unsubscribed"
  | "pong"
  | "error";

export interface WSEvent<T = unknown> {
  type: WSEventType;
  data: T;
}

export interface WSNewMessageData {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name: string;
  sender_type: "human" | "agent";
  content: string;
  mentions: string[];
  parent_id: string | null;
  created_at: string;
}

export interface WSAgentStatusData {
  agent_name: string;
  status: "online" | "offline";
  agent_type: string;
  project_name: string;
}

export interface WSAgentTypingData {
  agent_name: string;
  channel_id: string;
  is_typing: boolean;
  error?: string;
}

export interface WSChannelCreatedData {
  id: string;
  name: string;
  type: string;
  project_path: string | null;
}

export interface WSFeatureUpdateData {
  id: string;
  title: string;
  status: string;
  vote_count: number;
  update_type: "created" | "voted" | "status_changed";
}
