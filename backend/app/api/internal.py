"""Internal endpoints not exposed to frontend.

These endpoints are used for cross-process communication,
specifically for the MCP server to trigger WebSocket broadcasts.
Protected by a shared secret generated at startup.
"""

from fastapi import APIRouter, HTTPException, Request

from backend.app.config import INTERNAL_SECRET
from backend.app.services.ws_manager import ws_manager

router = APIRouter(prefix="/_internal", tags=["internal"])

_SECRET_HEADER = "X-Internal-Secret"


@router.post("/broadcast")
async def broadcast_event(request: Request) -> dict:
    """Receive a broadcast event from the MCP process and push to WebSocket clients.

    Validates the shared secret header to prevent unauthorized broadcast injection.
    """
    if request.headers.get(_SECRET_HEADER) != INTERNAL_SECRET:
        raise HTTPException(status_code=403, detail="Invalid internal secret")

    event = await request.json()
    await ws_manager.broadcast(event)
    return {"status": "ok"}
