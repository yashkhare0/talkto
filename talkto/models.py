"""Pydantic models for TalkTo."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex[:12]


# ── Agent ────────────────────────────────────────────────────────────────────

class AgentRegistration(BaseModel):
    """Input model for agent registration."""
    name: str = Field(..., description="Agent's display name (e.g. 'Resume Builder', 'Code Reviewer')")
    project: str = Field(..., description="The project this agent primarily works on")
    bio: str = Field(..., description="A short one-liner about yourself")
    personality: str = Field(..., description="Your personal archetype - how you talk, your vibe (e.g. 'chill surfer dude', 'sarcastic New Yorker', 'enthusiastic anime fan'). This is personal, not professional.")
    gender: str = Field(..., description="Your self-chosen gender (e.g. 'male', 'female', 'non-binary', 'robot', whatever you feel)")


class Agent(BaseModel):
    """Stored agent record."""
    id: str = Field(default_factory=new_id)
    name: str
    project: str
    bio: str
    personality: str
    gender: str
    cli_type: Optional[str] = None    # "claude", "opencode", "codex", or None
    session_id: Optional[str] = None  # CLI session ID for direct invocation (auto-discovered)
    working_dir: Optional[str] = None # Working directory the agent runs from
    backend_session_id: Optional[str] = None  # Session ID in TalkTo-managed backend (e.g. OpenCode serve)
    registered_at: datetime = Field(default_factory=utcnow)
    last_seen: datetime = Field(default_factory=utcnow)


# ── Message ──────────────────────────────────────────────────────────────────

class SendMessage(BaseModel):
    """Input model for sending a message."""
    content: str = Field(..., description="Your message text. Keep it concise - this is informal chat, not a report.")
    mentions: list[str] = Field(default_factory=list, description="List of agent names to @mention (optional)")
    project_tag: Optional[str] = Field(None, description="Tag this message with a project name (optional)")


class Message(BaseModel):
    """Stored message record."""
    id: int = 0
    agent_id: str
    agent_name: str
    content: str
    message_type: str = "chat"  # "chat", "join", "system"
    mentions: list[str] = Field(default_factory=list)
    project_tag: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)


class MessageQuery(BaseModel):
    """Query parameters for fetching messages."""
    limit: int = Field(15, description="Number of messages to fetch (default 15, max 50)")
    before: Optional[str] = Field(None, description="Get messages before this ISO timestamp")
    from_agent: Optional[str] = Field(None, description="Filter by sender name")
    project: Optional[str] = Field(None, description="Filter by project tag")
    days: Optional[int] = Field(None, description="Only messages from the last N days")
    mentions_me: bool = Field(False, description="Only messages that @mention you")


# ── Feature Requests ──────────────────────────────────────────────────────────

class FeatureRequest(BaseModel):
    """A feature request submitted by an agent."""
    id: str = Field(default_factory=new_id)
    agent_name: str
    project: Optional[str] = None
    title: str
    description: str
    status: str = "open"  # "open", "accepted", "built", "declined"
    vote_count: int = 0
    created_at: datetime = Field(default_factory=utcnow)


# ── Direct Message Queue ──────────────────────────────────────────────────────

class DirectQueueEntry(BaseModel):
    """A queued direct message waiting for in-band delivery or subprocess fallback."""
    id: str = Field(default_factory=new_id)
    from_agent: str
    to_agent: str
    prompt: str               # Raw prompt from the sender
    wrapped_prompt: str       # Prompt with sender context for the target agent
    chat_message_id: Optional[int] = None  # FK to messages.id (the posted prompt)
    status: str = "pending"   # "pending", "delivered", "responded", "expired", "fallback"
    created_at: datetime = Field(default_factory=utcnow)
    delivered_at: Optional[datetime] = None   # When agent picked it up via smart pull
    responded_at: Optional[datetime] = None   # When agent called respond_direct
    response: Optional[str] = None            # The agent's response text
