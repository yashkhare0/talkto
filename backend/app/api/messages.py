"""Message endpoints."""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models.channel import Channel
from backend.app.models.message import Message
from backend.app.models.user import User
from backend.app.schemas.message import MessageCreate, MessageResponse
from backend.app.services.message_service import create_message as create_msg

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
            User.type.label("sender_type"),
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
    for msg, sender_name, sender_type in rows:
        mentions = json.loads(msg.mentions) if msg.mentions else None
        messages.append(
            {
                "id": msg.id,
                "channel_id": msg.channel_id,
                "sender_id": msg.sender_id,
                "sender_name": sender_name,
                "sender_type": sender_type,
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

    # Look up channel name for invocation routing
    ch_name_result = await db.execute(select(Channel.name).where(Channel.id == channel_id))
    channel_name = ch_name_result.scalar_one_or_none()

    msg = await create_msg(
        db=db,
        sender_id=user.id,
        sender_name=user.display_name or user.name,
        channel_id=channel_id,
        channel_name=channel_name or "",
        content=data.content,
        mentions=data.mentions,
        sender_type=user.type,
    )

    return {
        "id": msg.id,
        "channel_id": msg.channel_id,
        "sender_id": msg.sender_id,
        "sender_name": user.display_name or user.name,
        "sender_type": user.type,
        "content": msg.content,
        "mentions": data.mentions,
        "parent_id": msg.parent_id,
        "created_at": msg.created_at,
    }
