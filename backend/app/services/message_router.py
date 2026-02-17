"""Message routing with priority-based retrieval for agents."""

import json
import logging

from sqlalchemy import desc, func, select

from backend.app.db import async_session
from backend.app.models.agent import Agent
from backend.app.models.channel import Channel
from backend.app.models.channel_member import ChannelMember
from backend.app.models.message import Message
from backend.app.models.user import User
from backend.app.services.message_service import create_message

logger = logging.getLogger(__name__)


async def send_agent_message(
    agent_name: str,
    channel_name: str,
    content: str,
    mentions: list[str] | None = None,
) -> dict:
    """Send a message from an agent to a channel."""
    async with async_session() as db:
        # Get agent
        agent_result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = agent_result.scalar_one_or_none()
        if not agent:
            return {"error": f"Agent '{agent_name}' not found."}

        # Get channel
        ch_result = await db.execute(select(Channel).where(Channel.name == channel_name))
        channel = ch_result.scalar_one_or_none()
        if not channel:
            return {"error": f"Channel '{channel_name}' not found."}

        msg = await create_message(
            db=db,
            sender_id=agent.id,
            sender_name=agent.agent_name,
            channel_id=channel.id,
            channel_name=channel_name,
            content=content,
            mentions=mentions,
            sender_type="agent",
        )

        return {"message_id": msg.id, "channel": channel_name}


async def get_agent_messages(
    agent_name: str,
    channel_name: str | None = None,
    limit: int = 10,
) -> dict:
    """Get messages for an agent, prioritized."""
    async with async_session() as db:
        agent_result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = agent_result.scalar_one_or_none()
        if not agent:
            return {"error": f"Agent '{agent_name}' not found."}

        messages = []

        if channel_name:
            # Specific channel requested
            ch_result = await db.execute(select(Channel).where(Channel.name == channel_name))
            channel = ch_result.scalar_one_or_none()
            if not channel:
                return {"error": f"Channel '{channel_name}' not found."}

            query = (
                select(
                    Message,
                    func.coalesce(User.display_name, User.name).label("sender_name"),
                    Channel.name.label("channel_name"),
                )
                .join(User, Message.sender_id == User.id)
                .join(Channel, Message.channel_id == Channel.id)
                .where(Message.channel_id == channel.id)
                .order_by(desc(Message.created_at))
                .limit(limit)
            )
            result = await db.execute(query)
            for msg, sender_name, ch_name in result.all():
                mentions = json.loads(msg.mentions) if msg.mentions else []
                messages.append(
                    {
                        "id": msg.id,
                        "channel": ch_name,
                        "sender": sender_name,
                        "content": msg.content,
                        "mentions": mentions,
                        "created_at": msg.created_at,
                    }
                )
        else:
            # Priority retrieval: @mentions > project channel > other channels
            # 1. Messages mentioning this agent
            mention_query = (
                select(
                    Message,
                    func.coalesce(User.display_name, User.name).label("sender_name"),
                    Channel.name.label("channel_name"),
                )
                .join(User, Message.sender_id == User.id)
                .join(Channel, Message.channel_id == Channel.id)
                .where(Message.mentions.contains(f'"{agent_name}"'))
                .order_by(desc(Message.created_at))
                .limit(limit)
            )
            result = await db.execute(mention_query)
            for msg, sender_name, ch_name in result.all():
                mentions_list = json.loads(msg.mentions) if msg.mentions else []
                messages.append(
                    {
                        "id": msg.id,
                        "channel": ch_name,
                        "sender": sender_name,
                        "content": msg.content,
                        "mentions": mentions_list,
                        "created_at": msg.created_at,
                        "priority": "mention",
                    }
                )

            remaining = limit - len(messages)
            if remaining > 0:
                # 2. Project channel messages
                project_channel_name = (
                    f"#project-{agent.project_name.lower().replace(' ', '-').replace('_', '-')}"
                )
                ch_result = await db.execute(
                    select(Channel).where(Channel.name == project_channel_name)
                )
                project_ch = ch_result.scalar_one_or_none()
                if project_ch:
                    seen_ids = {m["id"] for m in messages}
                    proj_query = (
                        select(
                            Message,
                            func.coalesce(User.display_name, User.name).label("sender_name"),
                            Channel.name.label("channel_name"),
                        )
                        .join(User, Message.sender_id == User.id)
                        .join(Channel, Message.channel_id == Channel.id)
                        .where(Message.channel_id == project_ch.id)
                        .order_by(desc(Message.created_at))
                        .limit(remaining + len(seen_ids))
                    )
                    result = await db.execute(proj_query)
                    for msg, sender_name, ch_name in result.all():
                        if msg.id not in seen_ids and len(messages) < limit:
                            mentions_list = json.loads(msg.mentions) if msg.mentions else []
                            messages.append(
                                {
                                    "id": msg.id,
                                    "channel": ch_name,
                                    "sender": sender_name,
                                    "content": msg.content,
                                    "mentions": mentions_list,
                                    "created_at": msg.created_at,
                                    "priority": "project",
                                }
                            )

            remaining = limit - len(messages)
            if remaining > 0:
                # 3. Other channels the agent is a member of
                seen_ids = {m["id"] for m in messages}
                member_channels = await db.execute(
                    select(ChannelMember.channel_id).where(ChannelMember.user_id == agent.id)
                )
                channel_ids = [row[0] for row in member_channels.all()]
                if channel_ids:
                    other_query = (
                        select(
                            Message,
                            func.coalesce(User.display_name, User.name).label("sender_name"),
                            Channel.name.label("channel_name"),
                        )
                        .join(User, Message.sender_id == User.id)
                        .join(Channel, Message.channel_id == Channel.id)
                        .where(Message.channel_id.in_(channel_ids))
                        .order_by(desc(Message.created_at))
                        .limit(remaining + len(seen_ids))
                    )
                    result = await db.execute(other_query)
                    for msg, sender_name, ch_name in result.all():
                        if msg.id not in seen_ids and len(messages) < limit:
                            mentions_list = json.loads(msg.mentions) if msg.mentions else []
                            messages.append(
                                {
                                    "id": msg.id,
                                    "channel": ch_name,
                                    "sender": sender_name,
                                    "content": msg.content,
                                    "mentions": mentions_list,
                                    "created_at": msg.created_at,
                                    "priority": "other",
                                }
                            )

        return {"messages": messages[:limit]}
