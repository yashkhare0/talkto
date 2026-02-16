from __future__ import annotations

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.db import Base


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    channel_id: Mapped[str] = mapped_column(String, ForeignKey("channels.id"), nullable=False)
    sender_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False)
    content: Mapped[str] = mapped_column(String, nullable=False)
    mentions: Mapped[str | None] = mapped_column(String, nullable=True)  # JSON array
    parent_id: Mapped[str | None] = mapped_column(String, ForeignKey("messages.id"), nullable=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False)

    __table_args__ = (
        Index("idx_messages_channel_created", "channel_id", "created_at"),
        Index("idx_messages_sender", "sender_id"),
    )

    # Relationships
    channel: Mapped[Channel] = relationship("Channel", back_populates="messages")
    sender: Mapped[User] = relationship("User", back_populates="messages")
