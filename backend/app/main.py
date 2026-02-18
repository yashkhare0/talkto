"""FastAPI application — the main entrypoint for TalkTo."""

import logging
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from loguru import logger

from backend.app.config import settings

# ---------------------------------------------------------------------------
# Loguru setup — single source of truth for all logging.
# ---------------------------------------------------------------------------


class _InterceptHandler(logging.Handler):
    """Bridge stdlib logging → loguru so uvicorn/alembic/sqlalchemy logs flow through."""

    def emit(self, record: logging.LogRecord) -> None:
        # Map stdlib level to loguru level name
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno  # type: ignore[assignment]

        # Find the caller frame that originated the log call
        frame, depth = logging.currentframe(), 2
        while frame and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1

        logger.opt(depth=depth, exception=record.exc_info).log(level, record.getMessage())


def _setup_logging() -> None:
    """Configure loguru as the single logging backend."""
    # Remove default stderr handler
    logger.remove()

    # Console handler — colorized, concise
    log_level = settings.log_level.upper()
    logger.add(
        sys.stderr,
        level=log_level,
        format=(
            "<green>{time:HH:mm:ss}</green> | "
            "<level>{level:<7}</level> | "
            "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> | "
            "<level>{message}</level>"
        ),
        colorize=True,
    )

    # File handler — for post-mortem debugging
    log_dir = settings.data_dir
    log_dir.mkdir(parents=True, exist_ok=True)
    logger.add(
        str(log_dir / "talkto.log"),
        level="DEBUG",
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level:<7} | {name}:{function}:{line} | {message}",
        rotation="10 MB",
        retention=3,
        encoding="utf-8",
    )

    # Intercept all stdlib logging → loguru
    logging.basicConfig(handlers=[_InterceptHandler()], level=0, force=True)

    # Quieten noisy third-party loggers
    for noisy in ("httpcore", "httpx", "websockets", "aiosqlite"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


_setup_logging()

# ---------------------------------------------------------------------------
# Now import everything else (after logging is configured)
# ---------------------------------------------------------------------------

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from sqlalchemy import text  # noqa: E402
from starlette.routing import Route  # noqa: E402
from starlette.types import Receive, Scope, Send  # noqa: E402

from backend.app.api.agents import router as agents_router  # noqa: E402
from backend.app.api.agents import start_liveness_task, stop_liveness_task  # noqa: E402
from backend.app.api.channels import router as channels_router  # noqa: E402
from backend.app.api.features import router as features_router  # noqa: E402
from backend.app.api.internal import router as internal_router  # noqa: E402
from backend.app.api.messages import router as messages_router  # noqa: E402
from backend.app.api.users import router as users_router  # noqa: E402
from backend.app.api.ws import router as ws_router  # noqa: E402
from backend.app.db import engine, init_db  # noqa: E402
from backend.app.services.broadcaster import mark_as_api_process  # noqa: E402
from backend.app.services.ws_manager import ws_manager  # noqa: E402
from backend.mcp_server import mcp as mcp_server  # noqa: E402

# Create the MCP Starlette app once (needed for lifespan composition)
# path="/" means the MCP endpoint is at the root of this Starlette sub-app,
# which we mount at /mcp — so final URL is http://host:8000/mcp/
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

# Register the MCP endpoint as a Starlette Route at /mcp.
# We add the route directly (instead of using app.mount("/mcp", ...)) to
# avoid Starlette's trailing-slash issue where /mcp wouldn't match a mount
# at "/mcp" — only /mcp/ would. A direct Route matches /mcp exactly.
_mcp_handler = mcp_starlette.routes[0].app  # StreamableHTTPASGIApp
app.routes.append(Route("/mcp", endpoint=_mcp_handler))


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
#
# IMPORTANT: We use app.mount() — NOT @app.get("/{path:path}") — because
# FastAPI routes take precedence over mounts and a catch-all route would
# shadow the MCP sub-app mounted at /mcp (causing 405 errors).
# Mounts are matched by path prefix in registration order, so /mcp wins
# over / when the path starts with /mcp.

if _FRONTEND_DIST.is_dir():

    class _SPAStaticFiles(StaticFiles):
        """StaticFiles subclass that falls back to index.html for SPA routing."""

        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            # Try to serve the file normally; on 404, serve index.html
            try:
                await super().__call__(scope, receive, send)
            except Exception:
                # File not found — serve index.html for client-side routing
                scope["path"] = "/index.html"
                await super().__call__(scope, receive, send)

    app.mount(
        "/",
        _SPAStaticFiles(directory=str(_FRONTEND_DIST), html=True),
        name="frontend-spa",
    )
