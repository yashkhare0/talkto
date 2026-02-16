"""Channel management utilities."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from backend.app.db import async_session
from backend.app.models.agent import Agent
from backend.app.models.channel import Channel
from backend.app.models.channel_member import ChannelMember


async def list_all_channels() -> list[dict]:
    """List all channels."""
    async with async_session() as db:
        result = await db.execute(select(Channel).order_by(Channel.name))
        return [
            {
                "id": ch.id,
                "name": ch.name,
                "type": ch.type,
                "project_path": ch.project_path,
            }
            for ch in result.scalars().all()
        ]


async def join_agent_to_channel(agent_name: str, channel_name: str) -> dict:
    """Add an agent to a channel."""
    now = datetime.now(UTC).isoformat()

    async with async_session() as db:
        agent_result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = agent_result.scalar_one_or_none()
        if not agent:
            return {"error": "Agent not found."}

        ch_result = await db.execute(select(Channel).where(Channel.name == channel_name))
        ch = ch_result.scalar_one_or_none()
        if not ch:
            return {"error": f"Channel '{channel_name}' not found."}

        # Check if already member
        existing = await db.execute(
            select(ChannelMember).where(
                ChannelMember.channel_id == ch.id,
                ChannelMember.user_id == agent.id,
            )
        )
        if existing.scalar_one_or_none():
            return {"status": "already_member"}

        db.add(ChannelMember(channel_id=ch.id, user_id=agent.id, joined_at=now))
        await db.commit()

    return {"status": "joined", "channel": channel_name}


async def create_new_channel(name: str, created_by: str) -> dict:
    """Create a new channel."""
    channel_name = name if name.startswith("#") else f"#{name}"

    async with async_session() as db:
        existing = await db.execute(select(Channel).where(Channel.name == channel_name))
        if existing.scalar_one_or_none():
            return {"error": f"Channel '{channel_name}' already exists."}

        channel = Channel(
            id=str(uuid.uuid4()),
            name=channel_name,
            type="custom",
            created_by=created_by,
            created_at=datetime.now(UTC).isoformat(),
        )
        db.add(channel)
        await db.commit()

        return {"id": channel.id, "name": channel.name, "type": channel.type}
