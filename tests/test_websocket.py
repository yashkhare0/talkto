"""Integration tests for WebSocket functionality."""

import json
import pytest
from httpx import ASGITransport, AsyncClient
from starlette.testclient import TestClient

from backend.app.config import INTERNAL_SECRET
from backend.app.main import app
from backend.app.services.ws_manager import ws_manager

_INTERNAL_HEADERS = {"X-Internal-Secret": INTERNAL_SECRET}


@pytest.fixture
def client():
    """Synchronous test client with WebSocket support."""
    return TestClient(app)


@pytest.mark.asyncio
async def test_health_endpoint_includes_ws_count():
    """Health endpoint should report active WebSocket client count."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert "ws_clients" in data
        assert data["ws_clients"] == "0"
        assert "database" in data


def test_websocket_connect_disconnect(client):
    """Test basic WebSocket connect/disconnect."""
    with client.websocket_connect("/ws") as ws:
        # Send ping
        ws.send_text(json.dumps({"action": "ping"}))
        resp = json.loads(ws.receive_text())
        assert resp["type"] == "pong"
    # After disconnect, manager should clean up


def test_websocket_subscribe_unsubscribe(client):
    """Test channel subscription management."""
    with client.websocket_connect("/ws") as ws:
        # Subscribe to channels
        ws.send_text(
            json.dumps(
                {
                    "action": "subscribe",
                    "channel_ids": ["chan-1", "chan-2"],
                }
            )
        )
        resp = json.loads(ws.receive_text())
        assert resp["type"] == "subscribed"
        assert set(resp["data"]["channel_ids"]) == {"chan-1", "chan-2"}

        # Unsubscribe from one
        ws.send_text(
            json.dumps(
                {
                    "action": "unsubscribe",
                    "channel_ids": ["chan-1"],
                }
            )
        )
        resp = json.loads(ws.receive_text())
        assert resp["type"] == "unsubscribed"


def test_websocket_invalid_json(client):
    """Test error handling for invalid JSON."""
    with client.websocket_connect("/ws") as ws:
        ws.send_text("not json")
        resp = json.loads(ws.receive_text())
        assert resp["type"] == "error"
        assert "Invalid JSON" in resp["data"]["message"]


def test_websocket_unknown_action(client):
    """Test error handling for unknown actions."""
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"action": "unknown_thing"}))
        resp = json.loads(ws.receive_text())
        assert resp["type"] == "error"
        assert "Unknown action" in resp["data"]["message"]


def test_internal_broadcast_endpoint(client):
    """Test the internal broadcast endpoint for cross-process communication."""
    # Connect a WebSocket client first
    with client.websocket_connect("/ws") as ws:
        # Send an event via internal endpoint
        event = {
            "type": "agent_status",
            "data": {"agent_name": "test_agent_1", "status": "online"},
        }
        resp = client.post(
            "/_internal/broadcast",
            json=event,
            headers=_INTERNAL_HEADERS,
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

        # The WebSocket client should receive the broadcast
        received = json.loads(ws.receive_text())
        assert received["type"] == "agent_status"
        assert received["data"]["agent_name"] == "test_agent_1"
        assert received["data"]["status"] == "online"


def test_internal_broadcast_rejects_bad_secret(client):
    """Test that internal broadcast rejects requests with wrong secret."""
    event = {"type": "agent_status", "data": {"agent_name": "x", "status": "online"}}

    # No header
    resp = client.post("/_internal/broadcast", json=event)
    assert resp.status_code == 403

    # Wrong header
    resp = client.post("/_internal/broadcast", json=event, headers={"X-Internal-Secret": "wrong"})
    assert resp.status_code == 403


def test_message_broadcast_filtered_by_channel(client):
    """Test that new_message broadcasts respect channel subscriptions."""
    with client.websocket_connect("/ws") as ws1:
        # ws1 subscribes to chan-A only
        ws1.send_text(
            json.dumps(
                {
                    "action": "subscribe",
                    "channel_ids": ["chan-A"],
                }
            )
        )
        ws1.receive_text()  # consume subscribed response

        with client.websocket_connect("/ws") as ws2:
            # ws2 subscribes to chan-B only
            ws2.send_text(
                json.dumps(
                    {
                        "action": "subscribe",
                        "channel_ids": ["chan-B"],
                    }
                )
            )
            ws2.receive_text()  # consume subscribed response

            # Broadcast a message to chan-A
            event = {
                "type": "new_message",
                "data": {
                    "id": "msg-1",
                    "channel_id": "chan-A",
                    "sender_id": "user-1",
                    "sender_name": "Alice",
                    "content": "Hello A",
                },
            }
            resp = client.post("/_internal/broadcast", json=event, headers=_INTERNAL_HEADERS)
            assert resp.status_code == 200

            # ws1 should receive it (subscribed to chan-A)
            received = json.loads(ws1.receive_text())
            assert received["data"]["content"] == "Hello A"

            # ws2 should NOT receive it (subscribed to chan-B)
            # Broadcast another event that ws2 should get
            event2 = {
                "type": "agent_status",
                "data": {"agent_name": "test", "status": "online"},
            }
            client.post("/_internal/broadcast", json=event2, headers=_INTERNAL_HEADERS)

            # ws2's next message should be the agent_status, not the chan-A message
            received2 = json.loads(ws2.receive_text())
            assert received2["type"] == "agent_status"
