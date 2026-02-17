"""FastAPI application — the main entrypoint for TalkTo."""

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from backend.app.api.agents import router as agents_router
from backend.app.api.agents import start_liveness_task, stop_liveness_task
from backend.app.api.channels import router as channels_router
from backend.app.api.features import router as features_router
from backend.app.api.internal import router as internal_router
from backend.app.api.messages import router as messages_router
from backend.app.api.users import router as users_router
from backend.app.api.ws import router as ws_router
from backend.app.config import settings
from backend.app.db import engine, init_db
from backend.app.services.broadcaster import mark_as_api_process
from backend.app.services.ws_manager import ws_manager
from backend.mcp_server import mcp as mcp_server

logger = logging.getLogger(__name__)

# Configure logging for our app modules so INFO/DEBUG logs are visible.
# Uvicorn's log_level="info" only affects its own logger, not ours.
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(levelname)s:%(name)s: %(message)s",
)
logging.getLogger("backend").setLevel(logging.DEBUG)

# Create the MCP Starlette app once (needed for lifespan composition)
# path="/" means the MCP endpoint is at the root of this Starlette sub-app,
# which we mount at /mcp — so final URL is http://host:8000/mcp
mcp_starlette = mcp_server.http_app(path="/", transport="streamable-http")

# Frontend build directory (created by `pnpm build` in frontend/)
_FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    await init_db()
    mark_as_api_process()
    # Start background liveness checker for ghost detection
    start_liveness_task()
    # Run the MCP app's lifespan alongside ours
    async with mcp_starlette.router.lifespan_context(app):
        yield
    # Shutdown
    stop_liveness_task()
    await ws_manager.close_all()


app = FastAPI(
    title="TalkTo",
    description="Slack for AI Agents",
    version="0.1.0",
    lifespan=lifespan,
)

# Build CORS origins — always allow localhost, add LAN origins in network mode.
# Note: allow_origins=["*"] + allow_credentials=True is rejected by browsers,
# so we always use an explicit origin list.
_cors_origins: list[str] = [
    "http://localhost:3000",
    f"http://localhost:{settings.port}",
]
if settings.network:
    _cors_origins.append(f"http://{settings.advertise_host}:{settings.frontend_port}")
    _cors_origins.append(f"http://{settings.advertise_host}:{settings.port}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Global exception handler ---


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch unhandled exceptions and return a clean JSON 500 instead of a stack trace."""
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


# Include routers
app.include_router(users_router, prefix="/api")
app.include_router(channels_router, prefix="/api")
app.include_router(messages_router, prefix="/api")
app.include_router(agents_router, prefix="/api")
app.include_router(features_router, prefix="/api")
app.include_router(internal_router)  # /_internal prefix (no /api)
app.include_router(ws_router)  # /ws endpoint (no /api prefix)

# Mount MCP server at /mcp (streamable-http transport for agents)
app.mount("/mcp", mcp_starlette)


# --- Health check ---


@app.get("/api/health")
async def health() -> dict[str, str]:
    """Health check with DB connectivity verification."""
    db_ok = "ok"
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        db_ok = "error"
        logger.exception("Health check: database connectivity failed")

    return {
        "status": "ok" if db_ok == "ok" else "degraded",
        "database": db_ok,
        "ws_clients": str(ws_manager.active_count),
    }


# --- Serve frontend in production ---
# Mount the built frontend (frontend/dist/) as static files.
# This allows single-port deployment: backend serves both API and UI.
# In development, Vite's dev server handles this instead.

if _FRONTEND_DIST.is_dir():
    # Serve static assets (JS, CSS, images) under /assets
    app.mount(
        "/assets",
        StaticFiles(directory=str(_FRONTEND_DIST / "assets")),
        name="frontend-assets",
    )

    @app.get("/{path:path}")
    async def _serve_spa(path: str) -> FileResponse:
        """SPA fallback — serve index.html for any unmatched route."""
        # If the path matches a real file in dist/, serve it
        file_path = _FRONTEND_DIST / path
        if file_path.is_file():
            return FileResponse(str(file_path))
        # Otherwise serve index.html (client-side routing)
        return FileResponse(str(_FRONTEND_DIST / "index.html"))
