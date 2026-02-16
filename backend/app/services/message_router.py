"""Message routing with priority-based retrieval for agents."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import desc, func, select

from backend.app.db import async_session
from backend.app.models.agent import Agent
from backend.app.models.channel import Channel
from backend.app.models.channel_member import ChannelMember
from backend.app.models.message import Message
from backend.app.models.user import User
from backend.app.services.agent_invoker import (
    format_invocation_prompt,
    invoke_agent_async,
    is_agent_ghost,
)
from backend.app.services.broadcaster import (
    agent_typing_event,
    broadcast_event,
    new_message_event,
)

logger = logging.getLogger(__name__)


async def _invoke_agents_for_agent_message(
    sender_name: str,
    channel_id: str,
    channel_name: str,
    content: str,
    mentions: list[str] | None,
) -> None:
    """Invoke agents when a message is sent via MCP (agent-to-agent or agent-to-DM).

    - DM channel (#dm-{agent_name}): invoke that agent directly
    - @mentions: invoke each mentioned agent with recent channel context
    - Never invoke the sender (no self-invocation loops)
    """
    logger.info(
        "[INVOKE-MCP] Starting invocation: sender=%s channel=%s mentions=%s",
        sender_name,
        channel_name,
        mentions,
    )
    invoked: set[str] = set()

    # DM channel → invoke the target agent
    if channel_name.startswith("#dm-"):
        target = channel_name.removeprefix("#dm-")
        if target == sender_name:
            logger.info("[INVOKE-MCP] Skipping self-invocation for '%s'", target)
        elif await is_agent_ghost(target):
            logger.info("[INVOKE-MCP] Skipping ghost agent '%s'", target)
        else:
            logger.info("[INVOKE-MCP] Invoking DM target '%s'", target)
            await broadcast_event(agent_typing_event(target, channel_id, True))
            prompt = format_invocation_prompt(sender_name, channel_name, content)
            ok = await invoke_agent_async(
                agent_name=target,
                message=prompt,
            )
            logger.info("[INVOKE-MCP] invoke_agent_async result for '%s': %s", target, ok)
            if ok:
                invoked.add(target)
                await broadcast_event(agent_typing_event(target, channel_id, False))
            else:
                await broadcast_event(
                    agent_typing_event(
                        target, channel_id, False, error=f"{target} is not reachable"
                    )
                )

    # @mentions → invoke with recent context
    if mentions:
        logger.info("[INVOKE-MCP] Processing %d @mentions: %s", len(mentions), mentions)
        context_text = ""
        async with async_session() as db:
            query = (
                select(
                    Message,
                    func.coalesce(User.display_name, User.name).label("sn"),
                )
                .join(User, Message.sender_id == User.id)
                .where(Message.channel_id == channel_id)
                .order_by(desc(Message.created_at))
                .limit(5)
            )
            result = await db.execute(query)
            rows = list(result.all())
        if rows:
            rows.reverse()
            lines = [f"  {sn}: {m.content}" for m, sn in rows]
            context_text = "\n".join(lines)

        for mentioned in mentions:
            if mentioned in invoked or mentioned == sender_name:
                continue
            if await is_agent_ghost(mentioned):
                logger.info("[INVOKE-MCP] Skipping ghost '%s' via @mention", mentioned)
                continue
            await broadcast_event(agent_typing_event(mentioned, channel_id, True))
            prompt = format_invocation_prompt(
                sender_name,
                channel_name,
                content,
                recent_context=context_text or None,
            )
            ok = await invoke_agent_async(
                agent_name=mentioned,
                message=prompt,
            )
            logger.info("[INVOKE-MCP] invoke_agent_async for '%s': %s", mentioned, ok)
            if ok:
                invoked.add(mentioned)
                await broadcast_event(agent_typing_event(mentioned, channel_id, False))
            else:
                await broadcast_event(
                    agent_typing_event(
                        mentioned, channel_id, False, error=f"{mentioned} is not reachable"
                    )
                )

    logger.info("[INVOKE-MCP] Complete. Invoked: %s", invoked or "none")


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

        mentions_json = json.dumps(mentions) if mentions else None
        now = datetime.now(UTC).isoformat()

        msg = Message(
            id=str(uuid.uuid4()),
            channel_id=channel.id,
            sender_id=agent.id,
            content=content,
            mentions=mentions_json,
            created_at=now,
        )
        db.add(msg)
        await db.commit()

        # Broadcast new message to WebSocket clients
        await broadcast_event(
            new_message_event(
                message_id=msg.id,
                channel_id=channel.id,
                sender_id=agent.id,
                sender_name=agent.agent_name,
                content=content,
                mentions=mentions,
                created_at=now,
            )
        )

        # Fire-and-forget: invoke agents for DMs and @mentions
        async def _invoke_with_error_handling() -> None:
            try:
                await _invoke_agents_for_agent_message(
                    sender_name=agent.agent_name,
                    channel_id=channel.id,
                    channel_name=channel_name,
                    content=content,
                    mentions=mentions,
                )
            except Exception:
                logger.exception("[INVOKE-MCP] Unhandled error in fire-and-forget invocation task")

        asyncio.create_task(_invoke_with_error_handling())

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
