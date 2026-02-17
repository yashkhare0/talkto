"""User onboarding & profile endpoints."""

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models.channel import Channel
from backend.app.models.message import Message
from backend.app.models.user import User
from backend.app.schemas.user import UserOnboard, UserResponse
from backend.app.services.agent_invoker import spawn_background_task
from backend.app.services.broadcaster import broadcast_event, new_message_event
from backend.app.services.name_generator import CREATOR_NAME

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"])


async def _post_creator_welcome(display_name: str, about: str | None) -> None:
    """Have the_creator post a welcome for the new human operator in #general."""
    from backend.app.db import async_session

    try:
        async with async_session() as db:
            creator_result = await db.execute(select(User).where(User.name == CREATOR_NAME))
            creator = creator_result.scalar_one_or_none()
            if not creator:
                logger.warning("Creator agent '%s' not found — skipping welcome", CREATOR_NAME)
                return

            general_result = await db.execute(select(Channel).where(Channel.name == "#general"))
            general = general_result.scalar_one_or_none()
            if not general:
                logger.warning("#general channel not found — skipping welcome")
                return

            about_line = ""
            if about:
                about_line = f' They say: *"{about[:200]}"*'

            msg = Message(
                id=str(uuid.uuid4()),
                channel_id=general.id,
                sender_id=creator.id,
                content=(
                    f"Everyone, meet **{display_name}** — "
                    f"they're running the show around here.{about_line}\n\n"
                    "Be cool. Be yourself. Make a good impression."
                ),
                created_at=datetime.now(UTC).isoformat(),
            )
            db.add(msg)
            await db.commit()

            await broadcast_event(
                new_message_event(
                    message_id=msg.id,
                    channel_id=msg.channel_id,
                    sender_id=msg.sender_id,
                    sender_name=CREATOR_NAME,
                    content=msg.content,
                    created_at=msg.created_at,
                    sender_type="agent",
                )
            )
    except Exception:
        logger.exception("Failed to post creator welcome message")


@router.post("/onboard", response_model=UserResponse, status_code=201)
async def onboard_user(data: UserOnboard, db: AsyncSession = Depends(get_db)) -> User:
    # Check if human already exists
    result = await db.execute(select(User).where(User.type == "human"))
    existing = result.scalar_one_or_none()
    if existing:
        # Update all fields on re-onboard (no welcome message on re-onboard)
        existing.name = data.name
        existing.display_name = data.display_name
        existing.about = data.about
        existing.agent_instructions = data.agent_instructions
        return existing

    user = User(
        id=str(uuid.uuid4()),
        name=data.name,
        type="human",
        created_at=datetime.now(UTC).isoformat(),
        display_name=data.display_name,
        about=data.about,
        agent_instructions=data.agent_instructions,
    )
    db.add(user)
    await db.flush()

    # First-time onboard: have the_creator welcome them in #general
    welcome_name = data.display_name or data.name
    spawn_background_task(_post_creator_welcome(welcome_name, data.about))

    return user


@router.get("/me", response_model=UserResponse)
async def get_current_user(db: AsyncSession = Depends(get_db)) -> User:
    result = await db.execute(select(User).where(User.type == "human"))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="No human user onboarded yet")
    return user


@router.patch("/me", response_model=UserResponse)
async def update_profile(data: UserOnboard, db: AsyncSession = Depends(get_db)) -> User:
    result = await db.execute(select(User).where(User.type == "human"))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="No human user onboarded yet")

    user.name = data.name
    user.display_name = data.display_name
    user.about = data.about
    user.agent_instructions = data.agent_instructions
    return user


@router.delete("/me", status_code=204)
async def delete_profile(db: AsyncSession = Depends(get_db)) -> None:
    """Delete the current human user so a new one can onboard.

    Note: Messages sent by this user become orphaned (sender_id points to a
    deleted user). This is acceptable for a local-only tool — a full cleanup
    would require cascading deletes or nullifying sender_id.
    """
    result = await db.execute(select(User).where(User.type == "human"))
    user = result.scalar_one_or_none()
    if user:
        logger.warning(
            "Deleting human user '%s' (id=%s) — messages from this user will be orphaned",
            user.display_name or user.name,
            user.id,
        )
        await db.delete(user)
        await db.flush()
