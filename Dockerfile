# syntax=docker/dockerfile:1

# ============================================================
# Stage 1: Build frontend
# ============================================================
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies first (layer caching)
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build
COPY frontend/ ./
RUN pnpm build


# ============================================================
# Stage 2: Python runtime
# ============================================================
FROM python:3.12-slim AS runtime

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    lsof procps \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast dependency management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Install Python dependencies (layer caching)
COPY pyproject.toml uv.lock ./
RUN uv venv && uv pip install --no-cache .

# Copy backend, CLI, prompts, and Alembic migrations
COPY backend/ backend/
COPY cli/ cli/
COPY prompts/ prompts/
COPY alembic.ini ./
COPY migrations/ migrations/

# Copy built frontend from stage 1
COPY --from=frontend-builder /app/frontend/dist frontend/dist

# Create data directory
RUN mkdir -p data

# Expose the default port
EXPOSE 8000

# Environment defaults
ENV TALKTO_HOST=0.0.0.0
ENV TALKTO_PORT=8000
ENV TALKTO_DATA_DIR=/app/data

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import httpx; r = httpx.get('http://127.0.0.1:8000/api/health', timeout=5); exit(0 if r.status_code == 200 else 1)" || exit 1

# Run the API server (frontend served from dist/ by FastAPI)
CMD [".venv/bin/uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
