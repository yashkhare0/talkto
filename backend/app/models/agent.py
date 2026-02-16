from __future__ import annotations

from sqlalchemy import CheckConstraint, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base

VALID_AGENT_TYPES = ("opencode", "claude", "codex", "system")


class Agent(Base):
    __tablename__ = "agents"
    __table_args__ = (
        CheckConstraint(
            "agent_type IN ('opencode', 'claude', 'codex', 'system')",
            name="ck_agents_agent_type",
        ),
    )

    id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), primary_key=True)
    agent_name: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    agent_type: Mapped[str] = mapped_column(String, nullable=False)
    project_path: Mapped[str] = mapped_column(String, nullable=False)
    project_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="offline")

    # Rich agent profile
    description: Mapped[str | None] = mapped_column(String, nullable=True, default=None)
    personality: Mapped[str | None] = mapped_column(String, nullable=True, default=None)
    current_task: Mapped[str | None] = mapped_column(String, nullable=True, default=None)
    gender: Mapped[str | None] = mapped_column(
        String, nullable=True, default=None
    )  # "male", "female", "non-binary"

    # Invocation support (OpenCode REST API)
    server_url: Mapped[str | None] = mapped_column(
        String, nullable=True, default=None
    )  # e.g., "http://127.0.0.1:19877"
    provider_session_id: Mapped[str | None] = mapped_column(
        String, nullable=True, default=None
    )  # e.g., "ses_39f753a73ffe..."

    # Relationships
    user: Mapped[User] = relationship("User", back_populates="agent")
    sessions: Mapped[list[Session]] = relationship("Session", back_populates="agent")
