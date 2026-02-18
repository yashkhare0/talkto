"""WebSocket endpoint for real-time updates.

Clients connect at /ws and can subscribe to channels.
They receive: new_message, agent_status, feature_update events.

Protocol:
  Client -> Server (JSON):
    {"action": "subscribe", "channel_ids": ["chan-uuid-1", "chan-uuid-2"]}
    {"action": "unsubscribe", "channel_ids": ["chan-uuid-1"]}
    {"action": "ping"}

  Server -> Client (JSON):
    {"type": "new_message", "data": {...message fields...}}
    {"type": "agent_status", "data": {"agent_name": "x", "status": "online"}}
    {"type": "feature_update", "data": {...feature fields...}}
    {"type": "channel_created", "data": {...channel fields...}}
    {"type": "pong"}
    {"type": "error", "data": {"message": "..."}}
"""

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger

from backend.app.services.ws_manager import ws_manager

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """Main WebSocket endpoint for the frontend UI."""
    conn_id = await ws_manager.accept(ws)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "error",
                            "data": {"message": "Invalid JSON"},
                        }
                    )
                )
                continue

            action = msg.get("action", "")

            if action == "subscribe":
                channel_ids = msg.get("channel_ids", [])
                if isinstance(channel_ids, list):
                    ws_manager.subscribe(ws, channel_ids)
                    await ws.send_text(
                        json.dumps(
                            {
                                "type": "subscribed",
                                "data": {"channel_ids": channel_ids},
                            }
                        )
                    )

            elif action == "unsubscribe":
                channel_ids = msg.get("channel_ids", [])
                if isinstance(channel_ids, list):
                    ws_manager.unsubscribe(ws, channel_ids)
                    await ws.send_text(
                        json.dumps(
                            {
                                "type": "unsubscribed",
                                "data": {"channel_ids": channel_ids},
                            }
                        )
                    )

            elif action == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))

            else:
                await ws.send_text(
                    json.dumps(
                        {
                            "type": "error",
                            "data": {"message": f"Unknown action: {action}"},
                        }
                    )
                )

    except WebSocketDisconnect:
        logger.info("WS client %s disconnected normally", conn_id)
    except Exception:
        logger.exception("WS error for client %s", conn_id)
    finally:
        ws_manager.disconnect(ws)
