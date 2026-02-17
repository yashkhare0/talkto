"""Agent listing and DM endpoints (for UI)."""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import async_session, get_db
from backend.app.models.agent import Agent
from backend.app.models.channel import Channel
from backend.app.models.channel_member import ChannelMember
from backend.app.models.session import Session
from backend.app.models.user import User
from backend.app.schemas.agent import AgentResponse
from backend.app.schemas.channel import ChannelResponse
from backend.app.services.agent_invoker import is_pid_alive

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents", tags=["agents"])

# ---------------------------------------------------------------------------
# Background liveness cache — updated every 30s instead of per-request ps aux
# ---------------------------------------------------------------------------

# Maps agent_id -> is_ghost (bool). Updated by the background task.
_ghost_cache: dict[str, bool] = {}
_liveness_task: asyncio.Task | None = None


async def _get_ps_output() -> str:
    """Run ps aux once and return the output for batch liveness checks."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ps", "aux",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return stdout.decode(errors="replace")
    except (FileNotFoundError, TimeoutError):
        return ""


def _is_session_in_ps(session_id: str, ps_output: str) -> bool:
    for line in ps_output.splitlines():
        if session_id in line and "opencode" in line and "serve" not in line:
            return True
    return False


async def _compute_ghost(agent: Agent, db: AsyncSession, ps_output: str) -> bool:
    if agent.agent_type == "system":
        return False
    if agent.server_url and agent.provider_session_id:
        return not _is_session_in_ps(agent.provider_session_id, ps_output)
    sess_result = await db.execute(
        select(Session)
        .where(Session.agent_id == agent.id, Session.is_active == 1)
        .order_by(Session.started_at.desc())
        .limit(1)
    )
    active_session = sess_result.scalar_one_or_none()
    if not active_session:
        return True
    return not is_pid_alive(active_session.pid)


async def _refresh_ghost_cache() -> None:
    """Refresh the ghost cache for all agents."""
    try:
        ps_output = await _get_ps_output()
        async with async_session() as db:
            result = await db.execute(select(Agent))
            agents = list(result.scalars().all())
            new_cache: dict[str, bool] = {}
            for agent in agents:
                new_cache[agent.id] = await _compute_ghost(agent, db, ps_output)
            _ghost_cache.clear()
            _ghost_cache.update(new_cache)
    except Exception:
        logger.exception("Failed to refresh ghost cache")


async def _liveness_loop() -> None:
    """Background loop that refreshes ghost cache every 30 seconds."""
    while True:
        await _refresh_ghost_cache()
        await asyncio.sleep(30)


def start_liveness_task() -> None:
    """Start the background liveness checker. Call once at app startup."""
    global _liveness_task
    if _liveness_task is None or _liveness_task.done():
        _liveness_task = asyncio.create_task(_liveness_loop())


def stop_liveness_task() -> None:
    """Stop the background liveness checker."""
    global _liveness_task
    if _liveness_task and not _liveness_task.done():
        _liveness_task.cancel()
        _liveness_task = None


def _agent_to_dict(agent: Agent, is_ghost: bool) -> dict:
    """Convert an Agent ORM object to a response dict."""
    return {
        "id": agent.id,
        "agent_name": agent.agent_name,
        "agent_type": agent.agent_type,
        "project_path": agent.project_path,
        "project_name": agent.project_name,
        "status": agent.status,
        "description": agent.description,
        "personality": agent.personality,
        "current_task": agent.current_task,
        "gender": agent.gender,
        "server_url": agent.server_url,
        "provider_session_id": agent.provider_session_id,
        "is_ghost": is_ghost,
    }


@router.get("", response_model=list[AgentResponse])
async def list_agents(db: AsyncSession = Depends(get_db)) -> list[dict]:
    result = await db.execute(select(Agent).order_by(Agent.agent_name))
    agents = list(result.scalars().all())

    # Use cached ghost status instead of running ps aux per request
    responses = []
    for a in agents:
        is_ghost = _ghost_cache.get(a.id, False)
        responses.append(_agent_to_dict(a, is_ghost))
    return responses


@router.get("/{agent_name}", response_model=AgentResponse)
async def get_agent(agent_name: str, db: AsyncSession = Depends(get_db)) -> dict:
    result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    is_ghost = _ghost_cache.get(agent.id, False)
    return _agent_to_dict(agent, is_ghost)


@router.post("/{agent_name}/dm", response_model=ChannelResponse, status_code=200)
async def get_or_create_dm(agent_name: str, db: AsyncSession = Depends(get_db)) -> Channel:
    """Get or create a DM channel with an agent."""
    # Find the agent
    result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    dm_name = f"#dm-{agent_name}"
    now = datetime.now(UTC).isoformat()

    # Check if DM channel already exists
    ch_result = await db.execute(select(Channel).where(Channel.name == dm_name))
    channel = ch_result.scalar_one_or_none()

    if channel:
        return channel

    # Create DM channel
    channel = Channel(
        id=str(uuid.uuid4()),
        name=dm_name,
        type="dm",
        created_by="human",
        created_at=now,
    )
    db.add(channel)
    await db.flush()

    # Auto-join the agent
    db.add(ChannelMember(channel_id=channel.id, user_id=agent.id, joined_at=now))

    # Auto-join the human user
    human_result = await db.execute(select(User).where(User.type == "human"))
    human = human_result.scalar_one_or_none()
    if human:
        db.add(ChannelMember(channel_id=channel.id, user_id=human.id, joined_at=now))

    await db.flush()
    return channel
