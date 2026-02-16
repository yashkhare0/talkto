"""Message endpoints."""

import json
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models.channel import Channel
from backend.app.models.message import Message
from backend.app.models.user import User
from backend.app.schemas.message import MessageCreate, MessageResponse
from backend.app.services.agent_invoker import invoke_for_message, spawn_background_task
from backend.app.services.broadcaster import broadcast_event, new_message_event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/channels/{channel_id}/messages", tags=["messages"])


@router.get("", response_model=list[MessageResponse])
async def get_messages(
    channel_id: str,
    limit: int = Query(default=50, le=100),
    before: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    # Verify channel exists
    ch = await db.execute(select(Channel).where(Channel.id == channel_id))
    if not ch.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Channel not found")

    query = (
        select(
            Message,
            func.coalesce(User.display_name, User.name).label("sender_name"),
        )
        .join(User, Message.sender_id == User.id)
        .where(Message.channel_id == channel_id)
    )
    if before:
        # Get the created_at of the 'before' message for cursor pagination
        before_msg = await db.execute(select(Message.created_at).where(Message.id == before))
        before_ts = before_msg.scalar_one_or_none()
        if before_ts:
            query = query.where(Message.created_at < before_ts)

    query = query.order_by(desc(Message.created_at)).limit(limit)
    result = await db.execute(query)
    rows = result.all()

    messages = []
    for msg, sender_name in rows:
        mentions = json.loads(msg.mentions) if msg.mentions else None
        messages.append(
            {
                "id": msg.id,
                "channel_id": msg.channel_id,
                "sender_id": msg.sender_id,
                "sender_name": sender_name,
                "content": msg.content,
                "mentions": mentions,
                "parent_id": msg.parent_id,
                "created_at": msg.created_at,
            }
        )

    return messages


@router.post("", response_model=MessageResponse, status_code=201)
async def send_message(
    channel_id: str,
    data: MessageCreate,
    db: AsyncSession = Depends(get_db),
) -> dict:
    # Verify channel
    ch = await db.execute(select(Channel).where(Channel.id == channel_id))
    if not ch.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Channel not found")

    # Get the human user as sender (for now)
    sender = await db.execute(select(User).where(User.type == "human"))
    user = sender.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="No user onboarded")

    mentions_json = json.dumps(data.mentions) if data.mentions else None

    msg = Message(
        id=str(uuid.uuid4()),
        channel_id=channel_id,
        sender_id=user.id,
        content=data.content,
        mentions=mentions_json,
        created_at=datetime.now(UTC).isoformat(),
    )
    db.add(msg)

    # Look up channel name for invocation routing
    ch_name_result = await db.execute(select(Channel.name).where(Channel.id == channel_id))
    channel_name = ch_name_result.scalar_one_or_none()

    # C5 FIX: Commit BEFORE broadcasting so the message is persisted.
    # If the commit fails, no broadcast or invocation happens.
    await db.commit()

    # Broadcast new message to WebSocket clients (message is now persisted)
    await broadcast_event(
        new_message_event(
            message_id=msg.id,
            channel_id=msg.channel_id,
            sender_id=msg.sender_id,
            sender_name=user.display_name or user.name,
            content=msg.content,
            mentions=data.mentions,
            parent_id=msg.parent_id,
            created_at=msg.created_at,
        )
    )

    # C4 FIX: Use spawn_background_task instead of bare asyncio.create_task
    # to prevent GC of unfinished tasks.
    async def _invoke_with_error_handling() -> None:
        try:
            await invoke_for_message(
                sender_name=user.display_name or user.name,
                channel_id=channel_id,
                channel_name=channel_name or "",
                content=data.content,
                mentions=data.mentions,
            )
        except Exception:
            logger.exception("[INVOKE] Unhandled error in fire-and-forget invocation task")

    spawn_background_task(_invoke_with_error_handling())

    return {
        "id": msg.id,
        "channel_id": msg.channel_id,
        "sender_id": msg.sender_id,
        "sender_name": user.display_name or user.name,
        "content": msg.content,
        "mentions": data.mentions,
        "parent_id": msg.parent_id,
        "created_at": msg.created_at,
    }
