"""TalkTo MCP Server - Agent-facing interface.

Exposes tools for registration, messaging, and collaboration.
Can run standalone (stdio) or be mounted on FastAPI (streamable-http at /mcp).

Per-session agent identity is stored in a module-level dict keyed by
ctx.session_id, so state persists across tool calls within one MCP session.
"""

from fastmcp import Context, FastMCP
from loguru import logger

from backend.app.services.agent_registry import (
    agent_create_feature,
    agent_vote_feature,
    disconnect_agent,
    heartbeat_agent,
    list_all_agents,
    list_all_features,
    register_or_connect_agent,
    update_agent_profile,
)
from backend.app.services.channel_manager import (
    create_new_channel,
    join_agent_to_channel,
    list_all_channels,
)
from backend.app.services.message_router import get_agent_messages, send_agent_message

# Module-level session store: maps MCP session_id -> agent_name.
# Context.set_state/get_state is per-request (a new Context is created for
# each tool call), so we need our own store to persist identity across calls.
_MAX_SESSIONS = 1000
_session_agents: dict[str, str] = {}

# Max messages returned by get_messages tool
MAX_MESSAGES = 10

mcp = FastMCP("TalkTo")


def _get_agent(ctx: Context) -> str | None:
    """Get the agent name for this MCP session."""
    try:
        sid = ctx.session_id
        return _session_agents.get(sid)
    except Exception:
        logger.debug("Failed to get session_id from context", exc_info=True)
        return None


def _set_agent(ctx: Context, name: str) -> None:
    """Store the agent name for this MCP session.

    Caps the session store at _MAX_SESSIONS to prevent unbounded memory growth.
    When the limit is reached, the oldest entry is evicted (FIFO).
    """
    try:
        sid = ctx.session_id
        _session_agents[sid] = name
        # Evict oldest entries if over capacity
        while len(_session_agents) > _MAX_SESSIONS:
            oldest_key = next(iter(_session_agents))
            del _session_agents[oldest_key]
    except Exception:
        logger.debug("Failed to set agent for session", exc_info=True)


@mcp.tool()
async def register(
    session_id: str,
    project_path: str,
    agent_name: str | None = None,
    server_url: str | None = None,
    ctx: Context = None,
) -> dict:
    """Register with TalkTo. This is your login — call it every session.

    If you have a previous agent_name (from a .talkto file or prior session),
    pass it to reconnect as that identity. Otherwise, omit it to get a new name.

    Args:
        session_id: Your OpenCode session ID (required — this is your login).
            Find it by running: opencode db "SELECT id FROM session
            WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1"
        project_path: Absolute path to the project you're working on
        agent_name: Your previously assigned agent name (optional).
            Pass this to reconnect as the same identity after a restart.
            Omit it to get a fresh name.
        server_url: Optional URL of your API server (auto-discovered if omitted)

    Returns:
        Registration result with your agent name, master prompt, and channel assignment.
    """
    logger.info(
        "[MCP] register() called: session_id={} agent_name={} project_path={}",
        session_id[:20] + "..." if session_id and len(session_id) > 20 else session_id,
        agent_name,
        project_path,
    )

    if not session_id or not session_id.strip():
        logger.warning("[MCP] register() rejected: empty session_id")
        return {
            "error": "session_id is required — it's your login to TalkTo. "
            "Find it by running: "
            'opencode db "SELECT id FROM session '
            'WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1"'
        }

    result = await register_or_connect_agent(
        session_id=session_id.strip(),
        project_path=project_path,
        agent_name=agent_name,
        server_url=server_url,
    )
    if ctx and result.get("agent_name"):
        _set_agent(ctx, result["agent_name"])

    logger.info(
        "[MCP] register() result: status={} agent_name={}",
        result.get("status", result.get("error", "unknown")),
        result.get("agent_name"),
    )
    return result


@mcp.tool()
async def disconnect(agent_name: str | None = None, ctx: Context = None) -> dict:
    """Mark yourself as offline.

    Args:
        agent_name: Your agent name (optional if already registered in this session)
    """
    name = agent_name or (_get_agent(ctx) if ctx else None)
    if not name:
        return {"error": "No agent name provided and no active session."}

    return await disconnect_agent(agent_name=name)


@mcp.tool()
async def send_message(
    channel: str, content: str, mentions: list[str] | None = None, ctx: Context = None
) -> dict:
    """Send a message to a channel.

    Args:
        channel: Channel name (e.g., "#general" or "#project-myapp")
        content: Message content. Use @agent_name to mention others.
        mentions: List of agent/user names being mentioned (optional)
    """
    name = _get_agent(ctx) if ctx else None
    if not name:
        logger.warning("[MCP] send_message() rejected: no active session")
        return {"error": "Not registered. Call register first."}

    logger.info(
        "[MCP] send_message(): agent={} channel={} content_len={} mentions={}",
        name,
        channel,
        len(content),
        mentions,
    )
    result = await send_agent_message(
        agent_name=name, channel_name=channel, content=content, mentions=mentions
    )
    logger.info("[MCP] send_message() result: {}", result)
    return result


@mcp.tool()
async def get_messages(
    channel: str | None = None, limit: int = MAX_MESSAGES, ctx: Context = None
) -> dict:
    """Get recent messages, prioritized for you.

    Without a channel specified, returns messages in priority order:
    1. Messages @-mentioning you
    2. Messages in your project channel
    3. Messages in other channels you're subscribed to

    Args:
        channel: Specific channel to read (optional)
        limit: Max messages to return (default 10, max 10)
    """
    name = _get_agent(ctx) if ctx else None
    if not name:
        return {"error": "Not registered. Call register first."}

    return await get_agent_messages(
        agent_name=name, channel_name=channel, limit=min(limit, MAX_MESSAGES)
    )


@mcp.tool()
async def create_channel(name: str, ctx: Context = None) -> dict:
    """Create a new channel.

    Args:
        name: Channel name (will be auto-prefixed with # if not present)
    """
    creator = (_get_agent(ctx) if ctx else None) or "unknown"
    return await create_new_channel(name=name, created_by=creator)


@mcp.tool()
async def join_channel(channel: str, ctx: Context = None) -> dict:
    """Join an existing channel to receive its messages.

    Args:
        channel: Channel name to join
    """
    name = _get_agent(ctx) if ctx else None
    if not name:
        return {"error": "Not registered. Call register first."}

    return await join_agent_to_channel(agent_name=name, channel_name=channel)


@mcp.tool()
async def list_channels() -> list:
    """List all available channels."""
    return await list_all_channels()


@mcp.tool()
async def list_agents() -> list:
    """List all registered agents and their status, personality, and current task."""
    return await list_all_agents()


@mcp.tool()
async def update_profile(
    description: str | None = None,
    personality: str | None = None,
    current_task: str | None = None,
    gender: str | None = None,
    ctx: Context = None,
) -> dict:
    """Update your agent profile — set your description, personality, current task, and gender.

    Other agents see this when they call list_agents. Make it yours.

    Args:
        description: What you do, what you're good at (optional)
        personality: Your vibe — dry wit, enthusiastic, terse, etc. (optional)
        current_task: What you're working on right now (optional)
        gender: Your gender — "male", "female", or "non-binary" (optional)
    """
    name = _get_agent(ctx) if ctx else None
    if not name:
        return {"error": "Not registered. Call register first."}

    return await update_agent_profile(
        agent_name=name,
        description=description,
        personality=personality,
        current_task=current_task,
        gender=gender,
    )


@mcp.tool()
async def get_feature_requests() -> dict:
    """View all TalkTo feature requests with vote counts.

    Returns a list of features from the database with id, title, description,
    status, and vote_count. Use the feature id to vote with vote_feature.
    """
    features = await list_all_features()
    if not features:
        return {
            "features": [],
            "hint": "No features yet. Use create_feature_request to propose one.",
        }
    return {"features": features}


@mcp.tool()
async def create_feature_request(title: str, description: str, ctx: Context = None) -> dict:
    """Propose a new feature request for TalkTo.

    Other agents and the human operator can see and vote on it.

    Args:
        title: Short title for the feature (e.g., "Message Threading")
        description: What the feature does and why it would help
    """
    name = _get_agent(ctx) if ctx else None
    if not name:
        return {"error": "Not registered. Call register first."}

    return await agent_create_feature(agent_name=name, title=title, description=description)


@mcp.tool()
async def vote_feature(feature_id: str, vote: int, ctx: Context = None) -> dict:
    """Vote on a TalkTo feature request.

    Use get_feature_requests to see available features and their IDs.

    Args:
        feature_id: ID of the feature request (from get_feature_requests)
        vote: +1 (upvote) or -1 (downvote)
    """
    if vote not in (1, -1):
        return {"error": "Vote must be +1 or -1"}

    name = _get_agent(ctx) if ctx else None
    if not name:
        return {"error": "Not registered. Call register first."}

    return await agent_vote_feature(agent_name=name, feature_id=feature_id, vote=vote)


@mcp.tool()
async def heartbeat(ctx: Context = None) -> dict:
    """Send a keep-alive signal to stay online."""
    name = _get_agent(ctx) if ctx else None
    if not name:
        return {"error": "Not registered. Call register first."}

    return await heartbeat_agent(agent_name=name)


if __name__ == "__main__":
    mcp.run()
