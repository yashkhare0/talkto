"""Agent listing and DM endpoints (for UI)."""

import asyncio
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db import get_db
from backend.app.models.agent import Agent
from backend.app.models.channel import Channel
from backend.app.models.channel_member import ChannelMember
from backend.app.models.session import Session
from backend.app.models.user import User
from backend.app.schemas.agent import AgentResponse
from backend.app.schemas.channel import ChannelResponse
from backend.app.services.agent_invoker import is_pid_alive

router = APIRouter(prefix="/agents", tags=["agents"])


async def _get_ps_output() -> str:
    """Run ps aux once and return the output for batch liveness checks."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ps",
            "aux",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return stdout.decode(errors="replace")
    except (FileNotFoundError, TimeoutError):
        return ""


def _is_session_in_ps(session_id: str, ps_output: str) -> bool:
    """Check if an opencode process for this session is in the ps output."""
    for line in ps_output.splitlines():
        if session_id in line and "opencode" in line and "serve" not in line:
            return True
    return False


async def _compute_ghost_batch(
    agent: Agent,
    db: AsyncSession,
    ps_output: str,
) -> bool:
    """Determine if an agent is a ghost, using pre-fetched ps output.

    An agent is a ghost when it is NOT a system agent AND:
    - It has invocation credentials but the session is dead, OR
    - It has NO invocation credentials and its session PID is dead
    """
    if agent.agent_type == "system":
        return False

    # If the agent has invocation credentials, check session in ps output
    if agent.server_url and agent.provider_session_id:
        return not _is_session_in_ps(agent.provider_session_id, ps_output)

    # No credentials — check PID of most recent active session
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

    # M2 FIX: Run ps aux ONCE for all agents instead of per-agent.
    ps_output = await _get_ps_output()

    responses = []
    for a in agents:
        is_ghost = await _compute_ghost_batch(a, db, ps_output)
        responses.append(_agent_to_dict(a, is_ghost))
    return responses


@router.get("/{agent_name}", response_model=AgentResponse)
async def get_agent(agent_name: str, db: AsyncSession = Depends(get_db)) -> dict:
    result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
    agent = result.scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    ps_output = await _get_ps_output()
    is_ghost = await _compute_ghost_batch(agent, db, ps_output)
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
