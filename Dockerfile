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
# Stage 2: Bun runtime
# ============================================================
FROM oven/bun:1 AS runtime

WORKDIR /app

# System deps (lsof for OpenCode server discovery)
RUN apt-get update && apt-get install -y --no-install-recommends \
    lsof \
    && rm -rf /var/lib/apt/lists/*

# Install server dependencies (layer caching)
COPY server/package.json server/bun.lock* ./server/
RUN cd server && bun install --frozen-lockfile

# Copy server source and prompts
COPY server/ server/
COPY prompts/ prompts/

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
    CMD bun -e "const r = await fetch('http://127.0.0.1:8000/api/channels'); process.exit(r.ok ? 0 : 1)" || exit 1

# Run the TS backend (serves API, WebSocket, MCP, and static frontend)
CMD ["bun", "run", "server/src/index.ts"]
