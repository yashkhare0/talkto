"""Agent invocation — send messages to running agent sessions via REST API.

Currently supports OpenCode's REST API. The invoker looks up the agent's
server_url and provider_session_id from the database and sends messages
to the agent's running session.

If an agent is offline but its OpenCode server is still running, the invoker
will attempt on-demand auto-discovery to find the server and session, persist
them, and proceed with invocation.

IMPORTANT: OpenCode's prompt_async endpoint returns 204 even for dead sessions
(it queues the prompt in its DB, but no TUI process picks it up). We must
verify that a running opencode TUI process actually handles the session before
sending prompts to it.
"""

import asyncio
import os

import httpx
from loguru import logger
from sqlalchemy import select

from backend.app.db import async_session
from backend.app.models.agent import Agent
from backend.app.models.session import Session as AgentSession
from backend.app.services.agent_discovery import auto_discover

# Timeout for synchronous invocation (agent processes the message and responds)
_INVOKE_TIMEOUT = 120.0  # seconds — AI responses can be slow

# Timeout for async invocation (fire-and-forget, returns 204 immediately)
_INVOKE_ASYNC_TIMEOUT = 10.0


def format_invocation_prompt(
    sender_name: str,
    channel_name: str,
    content: str,
    recent_context: str | None = None,
) -> str:
    """Build an explicit prompt that instructs the agent to reply via TalkTo.

    When we inject a message into an agent's OpenCode session via prompt_async,
    the agent sees it as a user message in its conversation.  Without explicit
    instructions, it replies inline (inside OpenCode) instead of using the
    TalkTo ``send_message`` MCP tool.  This function builds a prompt that makes
    the expected behaviour unambiguous.
    """
    is_dm = channel_name.startswith("#dm-")

    if is_dm:
        header = f"[TalkTo] Direct message from {sender_name}."
    else:
        header = f"[TalkTo] {sender_name} mentioned you in {channel_name}."

    lines = [
        header,
        "",
        f'Reply using your `talkto_send_message` MCP tool to channel "{channel_name}".',
        "This tool is provided by the talkto MCP server already configured in your environment.",
        "Do NOT reply inline — the sender will not see it. Use the MCP tool.",
        "",
    ]

    if recent_context:
        lines.append("Recent messages:")
        lines.append(recent_context)
        lines.append("")

    lines.append(f"{sender_name}: {content}")

    return "\n".join(lines)


async def _is_session_alive(session_id: str, server_url: str | None = None) -> bool:
    """Check whether an OpenCode session is still active.

    Queries the OpenCode REST API at ``GET {server_url}/session`` and checks
    whether the ``session_id`` appears in the list of sessions. This is more
    reliable than scanning ``ps aux`` because OpenCode doesn't always put the
    session ID in its command-line arguments.

    Falls back to assuming alive if the server_url is unavailable.
    """
    if not server_url:
        logger.debug("[LIVENESS] No server_url, assuming session alive")
        return True  # Can't verify — assume alive

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{server_url}/session")
            if resp.status_code != 200:
                logger.debug(
                    "[LIVENESS] OpenCode API returned %s, assuming alive", resp.status_code
                )
                return True  # Can't verify — assume alive
            sessions = resp.json()
            for sess in sessions:
                if sess.get("id") == session_id:
                    logger.debug("[LIVENESS] Session %s is alive (found in API)", session_id)
                    return True
    except Exception:
        logger.debug("[LIVENESS] OpenCode API unreachable at %s, assuming dead", server_url)
        return False  # Server unreachable — session is dead

    logger.info("[LIVENESS] Session %s is DEAD (not in OpenCode API)", session_id)
    return False


async def _clear_stale_credentials(agent_name: str) -> None:
    """Clear server_url and provider_session_id for an agent with a dead session."""
    async with async_session() as db:
        result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = result.scalar_one_or_none()
        if agent:
            logger.info(
                "[INVOKER] Clearing stale credentials for '%s' (was session=%s)",
                agent_name,
                agent.provider_session_id,
            )
            agent.server_url = None
            agent.provider_session_id = None
            await db.commit()


async def _try_auto_discover(agent_name: str, agent_type: str, project_path: str) -> dict | None:
    """Attempt on-demand auto-discovery for an agent running on OpenCode.

    Agents may register with any agent_type (e.g. "claude") but still run
    inside an OpenCode terminal. We always attempt discovery regardless of
    agent_type — if an OpenCode server + matching session is found, the agent
    is invocable.

    Looks up the agent's active TalkTo session to get PID/TTY for precise
    process-tree-based discovery (avoids session ambiguity when multiple
    agents share the same project path).

    Returns:
        Dict with "server_url" and "session_id" if discovery succeeds, else None.
        Also persists the discovered values back to the Agent record.
    """
    # Look up the agent's active session to get PID and TTY,
    # and collect session IDs already claimed by OTHER agents to exclude them
    # from path-based fallback discovery.
    pid: int | None = None
    tty: str | None = None
    exclude_session_ids: set[str] = set()
    async with async_session() as db:
        sess_result = await db.execute(
            select(AgentSession)
            .join(Agent, AgentSession.agent_id == Agent.id)
            .where(Agent.agent_name == agent_name, AgentSession.is_active == 1)
            .order_by(AgentSession.started_at.desc())
            .limit(1)
        )
        active_session = sess_result.scalar_one_or_none()
        if active_session:
            pid = active_session.pid
            tty = active_session.tty

        # Collect provider_session_ids claimed by other agents
        claimed_result = await db.execute(
            select(Agent.provider_session_id).where(
                Agent.agent_name != agent_name,
                Agent.provider_session_id.isnot(None),
                Agent.provider_session_id != "",
            )
        )
        for (sid,) in claimed_result.all():
            exclude_session_ids.add(sid)

    try:
        discovery = await auto_discover(
            project_path,
            pid=pid,
            tty=tty,
            exclude_session_ids=exclude_session_ids,
        )
    except Exception:
        logger.exception("On-demand auto-discovery failed for '%s'", agent_name)
        return None

    if not discovery:
        logger.debug("On-demand discovery found no OpenCode server for '%s'", agent_name)
        return None

    server_url = discovery.get("server_url")
    session_id = discovery.get("session_id")

    if not server_url or not session_id:
        logger.debug(
            "On-demand discovery incomplete for '%s': server_url=%s session_id=%s",
            agent_name,
            server_url,
            session_id,
        )
        return None

    # Persist discovered values back to the agent record
    async with async_session() as db:
        result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = result.scalar_one_or_none()
        if agent:
            agent.server_url = server_url
            agent.provider_session_id = session_id
            await db.commit()
            logger.info(
                "On-demand discovery for '%s': server=%s session=%s (persisted)",
                agent_name,
                server_url,
                session_id,
            )

    return {"server_url": server_url, "session_id": session_id}


async def _get_agent_invocation_info(agent_name: str) -> dict | None:
    """Look up an agent's invocation details from the database.

    If the agent exists but is missing server_url or provider_session_id,
    attempts on-demand auto-discovery for OpenCode agents before giving up.

    Returns:
        Dict with "server_url", "session_id", and "agent_type", or None if
        agent is not invocable.
    """
    logger.info("[INVOKER] Looking up invocation info for '%s'", agent_name)
    async with async_session() as db:
        result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = result.scalar_one_or_none()

    if not agent:
        logger.warning("[INVOKER] Agent '%s' not found in DB", agent_name)
        return None

    server_url = agent.server_url
    session_id = agent.provider_session_id
    project_path = agent.project_path
    agent_type = agent.agent_type
    logger.info(
        "[INVOKER] Agent '%s': server_url=%s session_id=%s type=%s",
        agent_name,
        server_url,
        session_id,
        agent_type,
    )

    # If we have credentials, verify the session is actually alive
    if server_url and session_id:
        alive = await _is_session_alive(session_id, server_url)
        if not alive:
            logger.warning(
                "[INVOKER] Session %s for '%s' is DEAD — clearing stale credentials",
                session_id,
                agent_name,
            )
            await _clear_stale_credentials(agent_name)
            server_url = None
            session_id = None

    if not server_url or not session_id:
        logger.info(
            "[INVOKER] Missing/stale credentials for '%s', trying auto-discovery...", agent_name
        )
        discovered = await _try_auto_discover(
            agent_name,
            agent_type,
            project_path,
        )
        if not discovered:
            logger.warning(
                "[INVOKER] Agent '%s' is not invocable (auto-discovery failed)",
                agent_name,
            )
            return None
        server_url = discovered["server_url"]
        session_id = discovered["session_id"]
        logger.info(
            "[INVOKER] Auto-discovery succeeded for '%s': server=%s session=%s",
            agent_name,
            server_url,
            session_id,
        )

    return {
        "server_url": server_url,
        "session_id": session_id,
        "agent_type": agent_type,
    }


async def invoke_agent(agent_name: str, message: str, context: str | None = None) -> str | None:
    """Send a message to an agent's running session and wait for a response.

    Uses OpenCode's `POST /session/{session_id}/message` endpoint which is
    synchronous — it waits for the AI to process the message and returns the response.

    Args:
        agent_name: The agent's TalkTo name
        message: The message content to send
        context: Optional context string (prepended to message)

    Returns:
        The agent's response text, or None if invocation failed.
    """
    info = await _get_agent_invocation_info(agent_name)
    if not info:
        return None

    full_message = f"{context}\n\n{message}" if context else message

    url = f"{info['server_url']}/session/{info['session_id']}/message"
    body = {"parts": [{"type": "text", "text": full_message}]}

    try:
        async with httpx.AsyncClient(timeout=_INVOKE_TIMEOUT) as client:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            logger.info("Invoked agent '%s' synchronously, status=%d", agent_name, resp.status_code)
            return resp.text
    except httpx.TimeoutException:
        logger.warning("Invocation of agent '%s' timed out after %ss", agent_name, _INVOKE_TIMEOUT)
        return None
    except httpx.HTTPError as exc:
        logger.warning("Invocation of agent '%s' failed: %s", agent_name, exc)
        return None


async def invoke_agent_async(agent_name: str, message: str, context: str | None = None) -> bool:
    """Send a message to an agent's running session without waiting for a response.

    Uses OpenCode's `POST /session/{session_id}/prompt_async` endpoint which
    returns 204 immediately (fire-and-forget).

    Args:
        agent_name: The agent's TalkTo name
        message: The message content to send
        context: Optional context string (prepended to message)

    Returns:
        True if the message was sent successfully, False otherwise.
    """
    logger.info("[INVOKER] invoke_agent_async called for '%s'", agent_name)
    info = await _get_agent_invocation_info(agent_name)
    if not info:
        logger.warning("[INVOKER] No invocation info for '%s' — aborting", agent_name)
        return False

    full_message = f"{context}\n\n{message}" if context else message

    url = f"{info['server_url']}/session/{info['session_id']}/prompt_async"
    logger.info("[INVOKER] POST %s (message_len=%d)", url, len(full_message))
    body = {"parts": [{"type": "text", "text": full_message}]}

    try:
        async with httpx.AsyncClient(timeout=_INVOKE_ASYNC_TIMEOUT) as client:
            resp = await client.post(url, json=body)
            logger.info(
                "[INVOKER] Response from '%s': status=%d body=%s",
                agent_name,
                resp.status_code,
                resp.text[:200] if resp.text else "(empty)",
            )
            resp.raise_for_status()
            return True
    except httpx.TimeoutException:
        logger.warning("[INVOKER] Timeout invoking '%s' at %s", agent_name, url)
        return False
    except httpx.HTTPError as exc:
        logger.warning("[INVOKER] HTTP error invoking '%s': %s", agent_name, exc)
        return False


# ---------------------------------------------------------------------------
# Background task tracking — prevents GC of fire-and-forget tasks (C4).
# ---------------------------------------------------------------------------

_background_tasks: set[asyncio.Task] = set()  # type: ignore[type-arg]


def spawn_background_task(coro) -> asyncio.Task:
    """Create a tracked background task that won't be garbage collected.

    Use this instead of bare asyncio.create_task() for fire-and-forget work.
    The task is automatically removed from the tracking set when it completes.
    """
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


# ---------------------------------------------------------------------------
# Shared invocation logic for DMs and @mentions (M7).
# Used by both the REST API (human messages) and MCP service (agent messages).
# ---------------------------------------------------------------------------


async def invoke_for_message(
    sender_name: str,
    channel_id: str,
    channel_name: str,
    content: str,
    mentions: list[str] | None,
) -> None:
    """Invoke agents based on DM channel or @mentions.

    - DM channel (#dm-{agent_name}): invoke that agent with the message directly
    - @mentions in any channel: invoke each mentioned agent with last 5 messages
    - Never invokes the sender (prevents self-invocation loops)
    """
    from backend.app.services.broadcaster import (
        agent_typing_event,
        broadcast_event,
    )

    logger.info(
        "[INVOKE] Starting invocation: sender=%s channel=%s mentions=%s",
        sender_name,
        channel_name,
        mentions,
    )
    invoked: set[str] = set()

    # DM channel → invoke the target agent
    if channel_name.startswith("#dm-"):
        target = channel_name.removeprefix("#dm-")
        if target == sender_name:
            logger.info("[INVOKE] Skipping self-invocation for '%s'", target)
        else:
            await broadcast_event(agent_typing_event(target, channel_id, True))
            prompt = format_invocation_prompt(sender_name, channel_name, content)
            ok = await invoke_agent_async(agent_name=target, message=prompt)
            if ok:
                invoked.add(target)
                await broadcast_event(agent_typing_event(target, channel_id, False))
                logger.info("[INVOKE] Invoked '%s' via DM", target)
            else:
                await broadcast_event(
                    agent_typing_event(
                        target, channel_id, False, error=f"{target} is not reachable"
                    )
                )
                logger.warning("[INVOKE] Agent '%s' not invocable via DM", target)

    # @mentions → invoke each mentioned agent with recent channel context
    if mentions:
        context_text = await _fetch_recent_context(channel_id, limit=5)

        for mentioned in mentions:
            if mentioned in invoked or mentioned == sender_name:
                continue
            await broadcast_event(agent_typing_event(mentioned, channel_id, True))
            prompt = format_invocation_prompt(
                sender_name,
                channel_name,
                content,
                recent_context=context_text or None,
            )
            ok = await invoke_agent_async(agent_name=mentioned, message=prompt)
            if ok:
                invoked.add(mentioned)
                await broadcast_event(agent_typing_event(mentioned, channel_id, False))
                logger.info("[INVOKE] Invoked '%s' via @mention in %s", mentioned, channel_name)
            else:
                await broadcast_event(
                    agent_typing_event(
                        mentioned, channel_id, False, error=f"{mentioned} is not reachable"
                    )
                )
                logger.warning("[INVOKE] Agent '%s' not invocable via @mention", mentioned)

    logger.info("[INVOKE] Complete. Invoked agents: %s", invoked or "none")


async def _fetch_recent_context(channel_id: str, limit: int = 5) -> str:
    """Fetch the last N messages from a channel as context text."""
    from sqlalchemy import desc, func

    from backend.app.models.message import Message
    from backend.app.models.user import User

    async with async_session() as db:
        query = (
            select(
                Message,
                func.coalesce(User.display_name, User.name).label("sender_name"),
            )
            .join(User, Message.sender_id == User.id)
            .where(Message.channel_id == channel_id)
            .order_by(desc(Message.created_at))
            .limit(limit)
        )
        result = await db.execute(query)
        rows = list(result.all())

    if not rows:
        logger.debug("[INVOKE] No recent context found for channel {}", channel_id)
        return ""

    rows.reverse()
    logger.debug("[INVOKE] Fetched {} context messages for channel {}", len(rows), channel_id)
    return "\n".join(f"  {name}: {msg.content}" for msg, name in rows)


async def is_agent_invocable(agent_name: str) -> bool:
    """Check if an agent can be invoked (has server_url and session_id set)."""
    info = await _get_agent_invocation_info(agent_name)
    return info is not None


def is_pid_alive(pid: int) -> bool:
    """Check whether a process with the given PID is still running."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


# Make _is_session_alive public for use in agents.py ghost detection.
is_session_alive = _is_session_alive


async def is_agent_ghost(agent_name: str) -> bool:
    """Check if an agent is a ghost (unreachable stale registration).

    A ghost has no invocation credentials AND its session PID is dead
    (or it has no active sessions). System agents are never ghosts.
    """
    async with async_session() as db:
        result = await db.execute(select(Agent).where(Agent.agent_name == agent_name))
        agent = result.scalar_one_or_none()

        if not agent:
            logger.debug("[GHOST] Agent '%s' not found — not a ghost", agent_name)
            return False

        if agent.agent_type == "system":
            logger.debug("[GHOST] '%s' is system agent — not a ghost", agent_name)
            return False

        if agent.server_url and agent.provider_session_id:
            # Verify the session is actually alive — OpenCode accepts prompts
            # for dead sessions (returns 204) but nothing processes them.
            alive = await _is_session_alive(agent.provider_session_id, agent.server_url)
            if alive:
                logger.debug(
                    "[GHOST] '%s' has live credentials (session=%s) — not a ghost",
                    agent_name,
                    agent.provider_session_id,
                )
                return False
            # Stale credentials — session is dead
            logger.info(
                "[GHOST] '%s' has STALE credentials (session=%s is dead)",
                agent_name,
                agent.provider_session_id,
            )

        sess_result = await db.execute(
            select(AgentSession)
            .where(AgentSession.agent_id == agent.id, AgentSession.is_active == 1)
            .order_by(AgentSession.started_at.desc())
            .limit(1)
        )
        active_session = sess_result.scalar_one_or_none()

        if not active_session:
            logger.info("[GHOST] '%s' has no active session and no credentials — ghost", agent_name)
            return True

        pid_alive = is_pid_alive(active_session.pid)
        is_ghost = not pid_alive
        logger.info(
            "[GHOST] '%s' session PID=%d alive=%s — ghost=%s",
            agent_name,
            active_session.pid,
            pid_alive,
            is_ghost,
        )
        return is_ghost
