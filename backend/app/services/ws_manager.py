"""WebSocket connection manager for real-time broadcasts.

Tracks connected WebSocket clients and broadcasts events to them.
Clients can subscribe to specific channels to only receive relevant messages.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from starlette.websockets import WebSocket, WebSocketState

logger = logging.getLogger(__name__)


@dataclass
class WSClient:
    """A connected WebSocket client with its channel subscriptions."""

    ws: WebSocket
    user_id: str | None = None
    subscribed_channels: set[str] = field(default_factory=set)


class ConnectionManager:
    """Manages WebSocket connections and broadcasts events.

    Thread-safe for async usage within a single event loop (FastAPI).
    """

    def __init__(self) -> None:
        # Map of connection_id -> WSClient
        self._clients: dict[int, WSClient] = {}

    @property
    def active_count(self) -> int:
        return len(self._clients)

    async def accept(self, ws: WebSocket, user_id: str | None = None) -> int:
        """Accept a new WebSocket connection and return its connection ID."""
        await ws.accept()
        conn_id = id(ws)
        self._clients[conn_id] = WSClient(ws=ws, user_id=user_id)
        logger.info("WS client connected: %s (user=%s)", conn_id, user_id)
        return conn_id

    def disconnect(self, ws: WebSocket) -> None:
        """Remove a WebSocket connection."""
        conn_id = id(ws)
        if conn_id in self._clients:
            del self._clients[conn_id]
            logger.info("WS client disconnected: %s", conn_id)

    def subscribe(self, ws: WebSocket, channel_ids: list[str]) -> None:
        """Subscribe a client to specific channel IDs for targeted message delivery."""
        conn_id = id(ws)
        client = self._clients.get(conn_id)
        if client:
            client.subscribed_channels.update(channel_ids)
            logger.debug("WS %s subscribed to channels: %s", conn_id, channel_ids)

    def unsubscribe(self, ws: WebSocket, channel_ids: list[str]) -> None:
        """Unsubscribe a client from specific channels."""
        conn_id = id(ws)
        client = self._clients.get(conn_id)
        if client:
            client.subscribed_channels -= set(channel_ids)

    async def broadcast(self, event: dict) -> None:
        """Broadcast an event to all connected clients.

        For 'new_message' events, only sends to clients subscribed to that channel.
        For all other events (agent_status, feature_update, etc.), sends to everyone.
        """
        event_type = event.get("type", "")
        payload = json.dumps(event)
        dead: list[int] = []

        for conn_id, client in self._clients.items():
            # For new_message events, filter by channel subscription
            if event_type == "new_message":
                channel_id = event.get("data", {}).get("channel_id", "")
                if client.subscribed_channels and channel_id not in client.subscribed_channels:
                    continue

            try:
                if client.ws.client_state == WebSocketState.CONNECTED:
                    await client.ws.send_text(payload)
                else:
                    dead.append(conn_id)
            except Exception:
                logger.warning("Failed to send to WS %s, removing", conn_id)
                dead.append(conn_id)

        # Clean up dead connections
        for conn_id in dead:
            self._clients.pop(conn_id, None)

    async def close_all(self) -> None:
        """Close all connections gracefully (for shutdown)."""
        for client in self._clients.values():
            try:
                if client.ws.client_state == WebSocketState.CONNECTED:
                    await client.ws.close(code=1001, reason="Server shutting down")
            except Exception:
                pass
        self._clients.clear()


# Singleton instance used by the FastAPI process
ws_manager = ConnectionManager()
