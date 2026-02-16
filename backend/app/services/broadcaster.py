"""Broadcast helper for cross-process WebSocket event delivery.

This module provides a unified `broadcast_event` function that:
- In the FastAPI process: directly calls ws_manager.broadcast()
- In the MCP process (separate process): POSTs to FastAPI's /_internal/broadcast endpoint

The service layer (message_router, agent_registry, etc.) calls broadcast_event()
without needing to know which process it's running in.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Flag set by FastAPI app on startup to indicate we're in the API process
_is_api_process = False


def mark_as_api_process() -> None:
    """Called by FastAPI lifespan to mark this as the API process."""
    global _is_api_process
    _is_api_process = True


async def broadcast_event(event: dict[str, Any]) -> None:
    """Broadcast a WebSocket event to all connected clients.

    If we're in the FastAPI process, directly uses ws_manager.
    If we're in the MCP process, sends via HTTP to FastAPI's internal endpoint.
    """
    if _is_api_process:
        await _broadcast_direct(event)
    else:
        await _broadcast_via_http(event)


async def _broadcast_direct(event: dict[str, Any]) -> None:
    """Broadcast directly via the in-process ws_manager."""
    from backend.app.services.ws_manager import ws_manager

    try:
        await ws_manager.broadcast(event)
    except Exception:
        logger.exception("Failed to broadcast event directly")


async def _broadcast_via_http(event: dict[str, Any]) -> None:
    """Broadcast by POSTing to FastAPI's internal endpoint (cross-process)."""
    import httpx

    from backend.app.config import INTERNAL_SECRET, settings

    try:
        url = f"http://127.0.0.1:{settings.port}/_internal/broadcast"
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                json=event,
                headers={"X-Internal-Secret": INTERNAL_SECRET},
                timeout=5.0,
            )
            if resp.status_code != 200:
                logger.warning("Broadcast HTTP failed: %s %s", resp.status_code, resp.text)
    except httpx.ConnectError:
        # FastAPI server might not be running (e.g., MCP-only mode)
        logger.debug("Cannot reach FastAPI for broadcast — server may not be running")
    except Exception:
        logger.exception("Failed to broadcast event via HTTP")


# --- Event factory helpers ---


def new_message_event(
    message_id: str,
    channel_id: str,
    sender_id: str,
    sender_name: str,
    content: str,
    mentions: list[str] | None = None,
    parent_id: str | None = None,
    created_at: str = "",
) -> dict[str, Any]:
    """Create a new_message WebSocket event."""
    return {
        "type": "new_message",
        "data": {
            "id": message_id,
            "channel_id": channel_id,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "content": content,
            "mentions": mentions or [],
            "parent_id": parent_id,
            "created_at": created_at,
        },
    }


def agent_status_event(
    agent_name: str,
    status: str,
    agent_type: str = "",
    project_name: str = "",
) -> dict[str, Any]:
    """Create an agent_status WebSocket event."""
    return {
        "type": "agent_status",
        "data": {
            "agent_name": agent_name,
            "status": status,
            "agent_type": agent_type,
            "project_name": project_name,
        },
    }


def channel_created_event(
    channel_id: str,
    channel_name: str,
    channel_type: str = "project",
    project_path: str | None = None,
) -> dict[str, Any]:
    """Create a channel_created WebSocket event."""
    return {
        "type": "channel_created",
        "data": {
            "id": channel_id,
            "name": channel_name,
            "type": channel_type,
            "project_path": project_path,
        },
    }


def agent_typing_event(
    agent_name: str,
    channel_id: str,
    is_typing: bool = True,
    error: str | None = None,
) -> dict[str, Any]:
    """Create an agent_typing WebSocket event.

    When is_typing=False and error is set, indicates invocation failed.
    """
    data: dict[str, Any] = {
        "agent_name": agent_name,
        "channel_id": channel_id,
        "is_typing": is_typing,
    }
    if error:
        data["error"] = error
    return {"type": "agent_typing", "data": data}


def feature_update_event(
    feature_id: str,
    title: str,
    status: str,
    vote_count: int = 0,
    update_type: str = "created",
) -> dict[str, Any]:
    """Create a feature_update WebSocket event."""
    return {
        "type": "feature_update",
        "data": {
            "id": feature_id,
            "title": title,
            "status": status,
            "vote_count": vote_count,
            "update_type": update_type,  # "created", "voted", "status_changed"
        },
    }
