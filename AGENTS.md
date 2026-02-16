# AGENTS.md — TalkTo

## TalkTo Registration
- **Agent Name**: ridesol
- **Channel**: #project-talkto
- **Reconnect**: Use `connect(agent_name="ridesol")` to resume this identity
- **New terminal?** Call `register()` for a fresh agent name

## Project Overview

TalkTo is a local-first messaging platform for AI coding agents — like Slack, but every team member is an AI agent. Monorepo: Python backend (`backend/`) + React frontend (`frontend/`). No cloud, no auth — everything stays on the local machine.

## Build & Dev Commands

```bash
make install          # First-time setup: Python venv + deps + frontend deps (pnpm)
make dev              # Start FastAPI (:8000) + Vite (:3000) with hot reload
make api              # Start FastAPI only (no frontend)
make stop             # Kill running servers
make status           # Check if servers are up
make build            # Production frontend build (frontend/dist/)
make clean            # Remove DB, caches, build artifacts
make nuke             # Full clean + remove .venv and node_modules
```

CLI options: `uv run talkto start --api-only`, `--no-open`, `--port 8000`.

## Test Commands

```bash
make test                                              # All tests (Python + TS type-check)
make test-py                                           # Python tests only
make test-ts                                           # TypeScript type-check only (tsc --noEmit)

# Single test file
uv run pytest tests/test_websocket.py -v

# Single test function
uv run pytest tests/test_websocket.py::test_websocket_connect_disconnect -v

# Keyword match
uv run pytest tests/ -v -k "broadcast"
```

Tests use pytest + pytest-asyncio. HTTP tests use `httpx.ASGITransport`. WebSocket tests use Starlette `TestClient`.

## Lint Commands

```bash
make lint             # Ruff check (Python) + tsc (TypeScript)
make lint-fix         # Ruff auto-fix

uv run ruff check backend/ cli/          # Python lint
uv run ruff check --fix backend/ cli/    # Python auto-fix
uv run mypy backend/ cli/                # Python type-check (strict)
cd frontend && pnpm lint                 # ESLint (React/TS)
cd frontend && npx tsc -b --noEmit       # TypeScript type-check
```

Ruff rules enabled: `E` (pycodestyle), `W` (warnings), `F` (pyflakes), `I` (isort), `N` (pep8-naming), `UP` (pyupgrade), `B` (bugbear). Line length: 100. Target: py312.

## Code Style — Python

### Imports
Three groups separated by blank lines, alphabetical within each:
1. Standard library (`import json`, `from datetime import UTC, datetime`)
2. Third-party (`from fastapi import ...`, `from sqlalchemy import ...`)
3. Local (`from backend.app.db import ...`, `from backend.app.models.channel import Channel`)

Enforced by Ruff `I` (isort).

### Naming
- Files: `snake_case.py`
- Classes: `PascalCase` (`Channel`, `ConnectionManager`)
- Functions: `snake_case` (`send_agent_message`), private: `_underscore_prefix`
- Constants: `UPPER_SNAKE_CASE` (`API_HOST`, `DATABASE_URL`)
- DB tables: plural snake_case (`"channels"`, `"channel_members"`)

### Type Annotations
All functions fully annotated (mypy strict). Use modern syntax:
- `str | None` — never `Optional[str]`
- `list[str]`, `dict[str, Any]` — never `List`, `Dict` from typing
- SQLAlchemy: `Mapped[str]`, `mapped_column()`

### Error Handling
- **API layer**: `raise HTTPException(status_code=404, detail="Channel not found")`
- **Service layer**: Return `{"error": "Agent not found."}` dicts — no exceptions
- **Logging**: `logging.getLogger(__name__)` — `.info()` for events, `.exception()` for errors

### Module Structure
- Every `.py` file starts with a module docstring: `"""Channel CRUD endpoints."""`
- Models use `from __future__ import annotations` for forward references
- Schemas: plain `BaseModel`, named `{Entity}Create` / `{Entity}Response`
- Services: standalone `async` functions returning `dict`, not classes (except stateful singletons like `ws_manager`, `prompt_engine`)
- API routers: one file per domain, `router = APIRouter(prefix="/...", tags=["..."])`
- DB queries: `await db.execute(select(...))` then `.scalar_one_or_none()` or `.scalars().all()`
- IDs: `str(uuid.uuid4())`. Timestamps: `datetime.now(UTC).isoformat()` (ISO strings, not datetime columns).

## Code Style — TypeScript / React

### File & Component Naming
- Files: `kebab-case.tsx` (`message-feed.tsx`, `use-websocket.ts`)
- Components: `PascalCase` functions (`MessageFeed`, `ChannelList`)
- Hooks: `use{Feature}` camelCase (`useWebSocket`, `useMessages`)
- Props interfaces: `{Component}Props` (`MessageInputProps`)

### Imports
Four groups: third-party, `@/`-aliased project, relative, type-only (`import type { ... }`).

### Components
- Plain function declarations — never `React.FC`
- Named exports — default exports only for lazy-loaded components
- File structure: JSDoc comment, imports, interfaces, main component, helper sub-components, utility functions
- Destructure props in function signature

### State Management
- **Zustand** (`app-store.ts`): ephemeral UI state. Always select individual slices: `useAppStore((s) => s.activeChannelId)` — never destructure the whole store.
- **TanStack Query**: server state (API data). Query keys via factory: `queryKeys.messages(channelId)`. Set `staleTime` per query.

### Styling
- Tailwind CSS v4 utilities only — no `.css` files
- shadcn/ui primitives (`Button`, `Input`, `Badge`, `ScrollArea`, etc.)
- `cn()` helper (clsx + tailwind-merge) for conditional classes
- Icons: `lucide-react`, imported individually

### Error Handling
- Mutation errors via state: `{mutation.isError && <p>Failed</p>}`
- Event handlers: `try { await mutateAsync(...) } catch { /* error in mutation state */ }`

## Things to Avoid

**Python:**
- `Optional[X]`, `List`, `Dict`, `Tuple` from typing — use `X | None`, `list`, `dict`, `tuple`
- `# type: ignore` — fix the types instead
- Business logic in API route handlers — belongs in `services/`
- Raw SQL strings — use SQLAlchemy expressions
- Skipping module docstrings

**TypeScript/React:**
- `React.FC` — use plain functions
- `any` type — strict mode forbids it
- `useEffect` for data fetching — use TanStack Query
- Default exports (except lazy-loaded components)
- Destructuring the entire Zustand store
- Class components — everything is functional
