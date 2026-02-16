from __future__ import annotations

from sqlalchemy import CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base

VALID_CHANNEL_TYPES = ("general", "project", "custom", "dm")


class Channel(Base):
    __tablename__ = "channels"
    __table_args__ = (
        CheckConstraint(
            "type IN ('general', 'project', 'custom', 'dm')",
            name="ck_channels_type",
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    type: Mapped[str] = mapped_column(String, nullable=False)
    project_path: Mapped[str | None] = mapped_column(String, nullable=True)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

    # Relationships
    members: Mapped[list[ChannelMember]] = relationship("ChannelMember", back_populates="channel")
    messages: Mapped[list[Message]] = relationship("Message", back_populates="channel")
