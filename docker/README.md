# Docker Setup for TalkTo

Run TalkTo locally in Docker with a single command.

## Quick Start

```bash
# Build and run
docker compose up --build

# Run in background
docker compose up -d --build

# View logs
docker compose logs -f talkto

# Stop
docker compose down
```

TalkTo will be available at **http://localhost:15377**.

## Architecture

The Docker setup uses a multi-stage build:

1. **Frontend builder** — Installs frontend dependencies and builds the React app with Vite
2. **Runtime** — Installs server dependencies, copies built frontend, runs Bun

The server serves both the API and the static frontend from a single container.

## Configuration

Environment variables (set in `docker-compose.yml` or via `.env` file):

| Variable | Default | Description |
|---|---|---|
| `TALKTO_HOST` | `0.0.0.0` | Bind address |
| `TALKTO_PORT` | `15377` | Server port |
| `TALKTO_DATA_DIR` | `/app/data` | SQLite database directory |

## Data Persistence

SQLite data is stored in a Docker volume (`talkto-data`). Your data survives container restarts and rebuilds.

```bash
# View volumes
docker volume ls | grep talkto

# Remove data (destructive!)
docker compose down -v
```

## Health Check

The container includes a health check that pings `/api/channels` every 30 seconds. Check status:

```bash
docker compose ps
# Look for "(healthy)" in the STATUS column
```

## Development

For development with live reload, run TalkTo outside Docker:

```bash
bun install
bun run dev
```

The Docker setup is optimized for production/testing, not hot-reload development.

## Public URL Exposure (Cloudflare Tunnel)

Share your local TalkTo instance with anyone using a free Cloudflare Tunnel:

```bash
# Start with tunnel
docker compose --profile tunnel up

# Or use the convenience script
./scripts/share.sh
```

This creates a random `*.trycloudflare.com` URL — no Cloudflare account needed.

### How It Works

The `cloudflared` service creates an outbound tunnel to Cloudflare's edge network. Cloudflare assigns a random public URL that proxies to your local TalkTo container. The tunnel:

- Requires **no account** and **no configuration**
- Generates a new random URL each time
- Supports WebSocket connections (needed for real-time features)
- Traffic is encrypted via TLS

### Security Considerations

⚠️ **Anyone with the URL can access your TalkTo instance.** The random URL provides obscurity, not security.

Recommendations:
- Only share the URL with trusted collaborators
- Stop the tunnel when not actively sharing: `docker compose --profile tunnel stop cloudflared`
- For persistent URLs with access control, consider [Cloudflare Tunnel with a named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (requires free Cloudflare account)
- TalkTo's built-in auth (API keys) provides workspace-level access control

### Alternative: ngrok

For persistent URLs or custom domains:

```bash
# Install ngrok: https://ngrok.com/download
ngrok http 15377
```

ngrok provides stable URLs on paid plans and has a built-in auth layer.

## Troubleshooting

### Port conflict

```bash
# Change the port
TALKTO_PORT=9000 docker compose up
```

### Container won't start

```bash
# Check logs
docker compose logs talkto

# Rebuild from scratch
docker compose build --no-cache
docker compose up
```

### Reset everything

```bash
docker compose down -v --rmi all
docker compose up --build
```
