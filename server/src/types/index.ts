/**
 * Shared Zod schemas for request validation and response types.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export const UserOnboardSchema = z.object({
  name: z.string().min(1),
  display_name: z.string().optional(),
  about: z.string().optional(),
  agent_instructions: z.string().optional(),
});
export type UserOnboard = z.infer<typeof UserOnboardSchema>;

export const UserUpdateSchema = z.object({
  display_name: z.string().optional(),
  about: z.string().optional(),
  agent_instructions: z.string().optional(),
});
export type UserUpdate = z.infer<typeof UserUpdateSchema>;

export interface UserResponse {
  id: string;
  name: string;
  type: string;
  created_at: string;
  display_name?: string | null;
  about?: string | null;
  agent_instructions?: string | null;
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export const ChannelCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^#?[a-z0-9][a-z0-9_-]*$/),
});
export type ChannelCreate = z.infer<typeof ChannelCreateSchema>;

export const ChannelTopicSchema = z.object({
  topic: z.string().max(500),
});
export type ChannelTopic = z.infer<typeof ChannelTopicSchema>;

export interface ChannelResponse {
  id: string;
  name: string;
  type: string;
  topic?: string | null;
  project_path?: string | null;
  created_by: string;
  created_at: string;
  is_archived?: boolean;
  archived_at?: string | null;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const MessageEditSchema = z.object({
  content: z.string().min(1).max(32000),
});
export type MessageEdit = z.infer<typeof MessageEditSchema>;

export const MessageCreateSchema = z.object({
  content: z.string().min(1).max(32000),
  mentions: z.array(z.string()).max(50).optional(),
  parent_id: z.string().uuid().optional(),
});
export type MessageCreate = z.infer<typeof MessageCreateSchema>;

export interface MessageResponse {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name?: string | null;
  sender_type?: string | null;
  content: string;
  mentions?: string[] | null;
  parent_id?: string | null;
  is_pinned: boolean;
  pinned_at?: string | null;
  pinned_by?: string | null;
  edited_at?: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface AgentResponse {
  id: string;
  agent_name: string;
  agent_type: string;
  project_path: string;
  project_name: string;
  status: string;
  description?: string | null;
  personality?: string | null;
  current_task?: string | null;
  gender?: string | null;
  server_url?: string | null;
  provider_session_id?: string | null;
  is_ghost: boolean;
  message_count?: number;
  last_message_at?: string | null;
}

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

export const FeatureCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});
export type FeatureCreate = z.infer<typeof FeatureCreateSchema>;

export const FeatureVoteCreateSchema = z.object({
  vote: z.number().int().refine((v) => v === 1 || v === -1, {
    message: "Vote must be +1 or -1",
  }),
});
export type FeatureVoteCreate = z.infer<typeof FeatureVoteCreateSchema>;

export const FEATURE_STATUSES = [
  "open", "planned", "in_progress", "done", "closed", "wontfix",
] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const FeatureUpdateSchema = z.object({
  status: z.enum(FEATURE_STATUSES),
  reason: z.string().max(500).optional(),
});
export type FeatureUpdate = z.infer<typeof FeatureUpdateSchema>;

export interface FeatureResponse {
  id: string;
  title: string;
  description: string;
  status: string;
  reason?: string | null;
  created_by: string;
  created_at: string;
  updated_at?: string | null;
  vote_count: number;
}

// ---------------------------------------------------------------------------
// Reaction
// ---------------------------------------------------------------------------

export const ReactionToggleSchema = z.object({
  emoji: z.string().min(1).max(32),
});
export type ReactionToggle = z.infer<typeof ReactionToggleSchema>;

export interface ReactionResponse {
  message_id: string;
  emoji: string;
  users: string[]; // user names
  count: number;
}

export interface ReactionEvent {
  message_id: string;
  channel_id: string;
  emoji: string;
  user_name: string;
  action: "add" | "remove";
}
