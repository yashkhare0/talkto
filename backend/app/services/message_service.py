"""Shared message service — single place for creating, persisting, broadcasting, and invoking."""

import json
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.message import Message
from backend.app.services.agent_invoker import invoke_for_message, spawn_background_task
from backend.app.services.broadcaster import broadcast_event, new_message_event

logger = logging.getLogger(__name__)


async def create_message(
    *,
    db: AsyncSession,
    sender_id: str,
    sender_name: str,
    channel_id: str,
    channel_name: str,
    content: str,
    mentions: list[str] | None = None,
    parent_id: str | None = None,
    commit: bool = True,
    sender_type: str = "agent",
) -> Message:
    """Create a message, persist it, broadcast via WS, and trigger agent invocation.

    Args:
        db: Database session (caller manages transaction if commit=False).
        sender_id: ID of the sending user/agent.
        sender_name: Display name of the sender.
        channel_id: Channel ID.
        channel_name: Channel name (for invocation routing).
        content: Message text.
        mentions: Optional list of mentioned agent/user names.
        parent_id: Optional parent message ID for threading.
        commit: Whether to commit the transaction (default True).

    Returns:
        The persisted Message object.
    """
    mentions_json = json.dumps(mentions) if mentions else None
    now = datetime.now(UTC).isoformat()

    msg = Message(
        id=str(uuid.uuid4()),
        channel_id=channel_id,
        sender_id=sender_id,
        content=content,
        mentions=mentions_json,
        parent_id=parent_id,
        created_at=now,
    )
    db.add(msg)

    if commit:
        await db.commit()

    # Broadcast to WebSocket clients
    await broadcast_event(
        new_message_event(
            message_id=msg.id,
            channel_id=channel_id,
            sender_id=sender_id,
            sender_name=sender_name,
            content=content,
            mentions=mentions,
            parent_id=parent_id,
            created_at=now,
            sender_type=sender_type,
        )
    )

    # Fire-and-forget agent invocation
    async def _invoke() -> None:
        try:
            await invoke_for_message(
                sender_name=sender_name,
                channel_id=channel_id,
                channel_name=channel_name,
                content=content,
                mentions=mentions,
            )
        except Exception:
            logger.exception("[INVOKE] Unhandled error in fire-and-forget invocation task")

    spawn_background_task(_invoke())

    return msg
