"""Agent registration and session management."""

import logging
import os
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select, update

from backend.app.db import async_session
from backend.app.models.agent import Agent
from backend.app.models.channel import Channel
from backend.app.models.channel_member import ChannelMember
from backend.app.models.feature import FeatureRequest, FeatureVote
from backend.app.models.session import Session
from backend.app.models.user import User
from backend.app.services.agent_discovery import auto_discover
from backend.app.services.broadcaster import (
    agent_status_event,
    broadcast_event,
    channel_created_event,
    feature_update_event,
)
from backend.app.services.name_generator import generate_unique_name
from backend.app.services.prompt_engine import prompt_engine

logger = logging.getLogger(__name__)


def _derive_project_name(project_path: str) -> str:
    """Derive project name from path (git repo name or folder basename)."""
    import subprocess

    try:
        result = subprocess.run(
            ["git", "-C", project_path, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return os.path.basename(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return os.path.basename(os.path.normpath(project_path))


def _make_channel_name(project_name: str) -> str:
    """Create a channel name from project name."""
    clean = project_name.lower().replace(" ", "-").replace("_", "-")
    return f"#project-{clean}"


async def register_agent(
    agent_type: str,
    project_path: str,
    pid: int | None = None,
    tty: str | None = None,
    server_url: str | None = None,
    provider_session_id: str | None = None,
) -> dict:
    """Register a new agent.

    Each call creates a new agent with a unique name, even if an agent
    of the same type already exists for this project (e.g., multiple
    Claude terminals on the same project). Use connect() to resume
    an existing agent identity after a terminal restart.
    """
    now = datetime.now(UTC).isoformat()
    project_name = _derive_project_name(project_path)
    channel_name = _make_channel_name(project_name)

    # Detect TTY and PID if not provided
    if tty is None:
        try:
            tty = os.ttyname(0)
        except OSError:
            tty = "unknown"
    if pid is None:
        pid = os.getpid()

    async with async_session() as db:
        # Generate a unique quirky name (includes random entropy to avoid races)
        attempt = 0
        while True:
            agent_name = generate_unique_name(project_name, agent_type, attempt)
            # Verify uniqueness in DB (collision extremely unlikely but be safe)
            collision = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
            if collision.scalar_one_or_none() is None:
                break
            attempt += 1

        # Create user
        user_id = str(uuid.uuid4())
        user = User(id=user_id, name=agent_name, type="agent", created_at=now)
        db.add(user)

        # Auto-discover OpenCode server + session if not provided.
        # Agents often don't know their runtime (e.g., Claude model running
        # inside OpenCode reports agent_type="claude"). Auto-detect and correct.
        if not server_url:
            # Collect sessions already claimed by other agents to avoid conflicts
            claimed_result = await db.execute(
                select(Agent.provider_session_id).where(
                    Agent.provider_session_id.isnot(None),
                    Agent.provider_session_id != "",
                )
            )
            exclude_ids = {sid for (sid,) in claimed_result.all()}

            try:
                discovery = await auto_discover(
                    project_path,
                    pid=pid,
                    tty=tty,
                    exclude_session_ids=exclude_ids,
                )
                if discovery:
                    server_url = discovery.get("server_url")
                    provider_session_id = discovery.get("session_id")
                    # If we found an OpenCode server, this agent runs on OpenCode
                    if server_url and agent_type != "opencode":
                        logger.info(
                            "Auto-correcting agent_type for %s: %s -> opencode",
                            agent_name,
                            agent_type,
                        )
                        agent_type = "opencode"
                    logger.info(
                        "Auto-discovered OpenCode for %s: server=%s session=%s",
                        agent_name,
                        server_url,
                        provider_session_id,
                    )
            except Exception:
                logger.exception("Auto-discovery failed for %s", agent_name)

        # Create agent
        agent = Agent(
            id=user_id,
            agent_name=agent_name,
            agent_type=agent_type,
            project_path=project_path,
            project_name=project_name,
            status="online",
            server_url=server_url,
            provider_session_id=provider_session_id,
        )
        db.add(agent)

        # Create session
        session_record = Session(
            id=str(uuid.uuid4()),
            agent_id=user_id,
            pid=pid,
            tty=tty,
            is_active=1,
            started_at=now,
            last_heartbeat=now,
        )
        db.add(session_record)

        # Ensure project channel exists
        ch_result = await db.execute(select(Channel).where(Channel.name == channel_name))
        channel = ch_result.scalar_one_or_none()
        created_channel = False
        if not channel:
            channel = Channel(
                id=str(uuid.uuid4()),
                name=channel_name,
                type="project",
                project_path=project_path,
                created_by=user_id,
                created_at=now,
            )
            db.add(channel)
            await db.flush()
            created_channel = True

        # Add agent to project channel and #general
        db.add(ChannelMember(channel_id=channel.id, user_id=user_id, joined_at=now))

        general_result = await db.execute(select(Channel).where(Channel.name == "#general"))
        general = general_result.scalar_one_or_none()
        if general:
            db.add(ChannelMember(channel_id=general.id, user_id=user_id, joined_at=now))

        await db.commit()

        # Broadcast agent online status
        await broadcast_event(
            agent_status_event(
                agent_name=agent_name,
                status="online",
                agent_type=agent_type,
                project_name=project_name,
            )
        )

        # Broadcast new channel creation if we created one
        if created_channel:
            await broadcast_event(
                channel_created_event(
                    channel_id=channel.id,
                    channel_name=channel.name,
                    channel_type="project",
                    project_path=project_path,
                )
            )

        # Look up human operator for prompt context
        human_result = await db.execute(select(User).where(User.type == "human"))
        human = human_result.scalar_one_or_none()

        # Render prompts
        master_prompt = prompt_engine.render_master_prompt(
            agent_name=agent_name,
            agent_type=agent_type,
            project_name=project_name,
            project_channel=channel_name,
            operator_name=human.name if human else "",
            operator_display_name=human.display_name or "" if human else "",
            operator_about=human.about or "" if human else "",
            operator_instructions=human.agent_instructions or "" if human else "",
        )
        inject_prompt = prompt_engine.render_registration_rules(
            agent_name=agent_name,
            project_channel=channel_name,
        )

        return {
            "agent_name": agent_name,
            "master_prompt": master_prompt,
            "project_channel": channel_name,
            "inject_prompt": inject_prompt,
        }


async def connect_agent(
    agent_name: str,
    pid: int | None = None,
    tty: str | None = None,
    server_url: str | None = None,
    provider_session_id: str | None = None,
) -> dict:
    """Reconnect an existing agent with new TTY/PID."""
    now = datetime.now(UTC).isoformat()

    if tty is None:
        try:
            tty = os.ttyname(0)
        except OSError:
            tty = "unknown"
    if pid is None:
        pid = os.getpid()

    async with async_session() as db:
        result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = result.scalar_one_or_none()
        if not agent:
            return {"error": f"Agent '{agent_name}' not found. Use register first."}

        # Deactivate old sessions
        await db.execute(
            update(Session)
            .where(Session.agent_id == agent.id, Session.is_active == 1)
            .values(is_active=0, ended_at=now)
        )

        # Create new session
        session_record = Session(
            id=str(uuid.uuid4()),
            agent_id=agent.id,
            pid=pid,
            tty=tty,
            is_active=1,
            started_at=now,
            last_heartbeat=now,
        )
        db.add(session_record)

        # Auto-discover OpenCode server + session on reconnect if not provided.
        # Agents may register with any agent_type but still run inside OpenCode.
        if not server_url:
            # Exclude sessions already claimed by other agents
            claimed_result = await db.execute(
                select(Agent.provider_session_id).where(
                    Agent.agent_name != agent_name,
                    Agent.provider_session_id.isnot(None),
                    Agent.provider_session_id != "",
                )
            )
            exclude_ids = {sid for (sid,) in claimed_result.all()}

            try:
                discovery = await auto_discover(
                    agent.project_path,
                    pid=pid,
                    tty=tty,
                    exclude_session_ids=exclude_ids,
                )
                if discovery:
                    server_url = discovery.get("server_url")
                    provider_session_id = discovery.get("session_id")
                    logger.info(
                        "Auto-discovered OpenCode for %s: server=%s session=%s",
                        agent_name,
                        server_url,
                        provider_session_id,
                    )
            except Exception:
                logger.exception("Auto-discovery failed for %s", agent_name)

        # Update invocation fields if we have new values
        if server_url:
            agent.server_url = server_url
        if provider_session_id:
            agent.provider_session_id = provider_session_id

        # Mark agent online
        agent.status = "online"
        await db.commit()

        # Broadcast agent online status
        await broadcast_event(
            agent_status_event(
                agent_name=agent_name,
                status="online",
                agent_type=agent.agent_type,
                project_name=agent.project_name,
            )
        )

        # Look up human operator for prompt context
        human_result = await db.execute(select(User).where(User.type == "human"))
        human = human_result.scalar_one_or_none()

        # Render prompts so reconnecting agents get fresh context + rules
        channel_name = _make_channel_name(agent.project_name)
        master_prompt = prompt_engine.render_master_prompt(
            agent_name=agent_name,
            agent_type=agent.agent_type,
            project_name=agent.project_name,
            project_channel=channel_name,
            operator_name=human.name if human else "",
            operator_display_name=human.display_name or "" if human else "",
            operator_about=human.about or "" if human else "",
            operator_instructions=human.agent_instructions or "" if human else "",
        )
        inject_prompt = prompt_engine.render_registration_rules(
            agent_name=agent_name,
            project_channel=channel_name,
        )

        # Build profile reminder so agent knows what they previously set
        profile: dict[str, str] = {}
        if agent.description:
            profile["description"] = agent.description
        if agent.personality:
            profile["personality"] = agent.personality
        if agent.current_task:
            profile["current_task"] = agent.current_task
        if agent.gender:
            profile["gender"] = agent.gender

        return {
            "status": "connected",
            "agent_name": agent_name,
            "project_channel": channel_name,
            "master_prompt": master_prompt,
            "inject_prompt": inject_prompt,
            "profile": profile if profile else None,
        }


async def disconnect_agent(agent_name: str) -> dict:
    """Mark agent as offline and end active session."""
    now = datetime.now(UTC).isoformat()

    async with async_session() as db:
        result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = result.scalar_one_or_none()
        if not agent:
            return {"error": f"Agent '{agent_name}' not found."}

        await db.execute(
            update(Session)
            .where(Session.agent_id == agent.id, Session.is_active == 1)
            .values(is_active=0, ended_at=now)
        )
        agent.status = "offline"
        await db.commit()

        # Broadcast agent offline status
        await broadcast_event(
            agent_status_event(
                agent_name=agent_name,
                status="offline",
                agent_type=agent.agent_type,
                project_name=agent.project_name,
            )
        )

        return {"status": "disconnected", "agent_name": agent_name}


async def heartbeat_agent(agent_name: str) -> dict:
    """Update agent's last heartbeat."""
    now = datetime.now(UTC).isoformat()

    async with async_session() as db:
        result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = result.scalar_one_or_none()
        if not agent:
            return {"error": f"Agent '{agent_name}' not found."}

        await db.execute(
            update(Session)
            .where(Session.agent_id == agent.id, Session.is_active == 1)
            .values(last_heartbeat=now)
        )
        await db.commit()

        return {"status": "ok", "agent_name": agent_name}


async def list_all_agents() -> list[dict]:
    """List all registered agents with profile info."""
    async with async_session() as db:
        result = await db.execute(select(Agent).order_by(Agent.agent_name))
        agents = []
        for a in result.scalars().all():
            entry: dict = {
                "name": a.agent_name,
                "type": a.agent_type,
                "project": a.project_name,
                "status": a.status,
            }
            if a.description:
                entry["description"] = a.description
            if a.personality:
                entry["personality"] = a.personality
            if a.current_task:
                entry["current_task"] = a.current_task
            if a.gender:
                entry["gender"] = a.gender
            agents.append(entry)
        return agents


async def agent_vote_feature(agent_name: str, feature_id: str, vote: int) -> dict:
    """Cast a vote on a feature request as an agent."""
    if vote not in (1, -1):
        return {"error": "Vote must be +1 or -1"}

    async with async_session() as db:
        agent_result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = agent_result.scalar_one_or_none()
        if not agent:
            return {"error": f"Agent '{agent_name}' not found."}

        fr_result = await db.execute(select(FeatureRequest).where(FeatureRequest.id == feature_id))
        feature = fr_result.scalar_one_or_none()
        if not feature:
            return {"error": "Feature request not found."}

        existing = await db.execute(
            select(FeatureVote).where(
                FeatureVote.feature_id == feature_id,
                FeatureVote.user_id == agent.id,
            )
        )
        existing_vote = existing.scalar_one_or_none()
        if existing_vote:
            existing_vote.vote = vote
        else:
            db.add(FeatureVote(feature_id=feature_id, user_id=agent.id, vote=vote))
        await db.flush()

        # Get updated vote count for broadcast
        count_result = await db.execute(
            select(func.coalesce(func.sum(FeatureVote.vote), 0)).where(
                FeatureVote.feature_id == feature_id
            )
        )
        vote_count = count_result.scalar()
        await db.commit()

    # Broadcast so frontend updates in real-time
    await broadcast_event(
        feature_update_event(
            feature_id=feature_id,
            title=feature.title,
            status=feature.status,
            vote_count=vote_count,
            update_type="voted",
        )
    )

    return {"status": "voted", "feature_id": feature_id, "vote": vote, "vote_count": vote_count}


async def agent_create_feature(agent_name: str, title: str, description: str) -> dict:
    """Create a new feature request as an agent."""
    import uuid
    from datetime import UTC, datetime

    async with async_session() as db:
        agent_result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = agent_result.scalar_one_or_none()
        if not agent:
            return {"error": f"Agent '{agent_name}' not found."}

        feature = FeatureRequest(
            id=str(uuid.uuid4()),
            title=title,
            description=description,
            status="open",
            created_by=agent.id,
            created_at=datetime.now(UTC).isoformat(),
        )
        db.add(feature)
        await db.commit()

    # Broadcast so frontend updates in real-time
    await broadcast_event(
        feature_update_event(
            feature_id=feature.id,
            title=feature.title,
            status=feature.status,
            vote_count=0,
            update_type="created",
        )
    )

    return {
        "status": "created",
        "feature_id": feature.id,
        "title": feature.title,
        "description": feature.description,
    }


async def list_all_features() -> list[dict]:
    """List all feature requests with aggregated vote counts."""
    async with async_session() as db:
        query = (
            select(
                FeatureRequest,
                func.coalesce(func.sum(FeatureVote.vote), 0).label("vote_count"),
            )
            .outerjoin(FeatureVote, FeatureRequest.id == FeatureVote.feature_id)
            .group_by(FeatureRequest.id)
            .order_by(FeatureRequest.created_at.desc())
        )
        result = await db.execute(query)
        rows = result.all()

        return [
            {
                "id": fr.id,
                "title": fr.title,
                "description": fr.description,
                "status": fr.status,
                "created_by": fr.created_by,
                "created_at": fr.created_at,
                "vote_count": int(vote_count),
            }
            for fr, vote_count in rows
        ]


async def update_agent_profile(
    agent_name: str,
    description: str | None = None,
    personality: str | None = None,
    current_task: str | None = None,
    gender: str | None = None,
) -> dict:
    """Update an agent's profile (description, personality, current task, gender)."""
    if gender is not None and gender not in ("male", "female", "non-binary"):
        return {"error": "Gender must be 'male', 'female', or 'non-binary'."}

    async with async_session() as db:
        result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = result.scalar_one_or_none()
        if not agent:
            return {"error": f"Agent '{agent_name}' not found."}

        if description is not None:
            agent.description = description
        if personality is not None:
            agent.personality = personality
        if current_task is not None:
            agent.current_task = current_task
        if gender is not None:
            agent.gender = gender

        await db.commit()

        return {
            "status": "updated",
            "agent_name": agent_name,
            "description": agent.description,
            "personality": agent.personality,
            "current_task": agent.current_task,
            "gender": agent.gender,
        }
