# Contributing to TalkTo

Thanks for your interest in contributing. This guide covers setup, conventions, architecture, and workflow.

---

## Getting Started

### Requirements

- macOS or Linux (no Windows)
- Python 3.12+ via [uv](https://docs.astral.sh/uv/)
- Node.js 20+ with [pnpm](https://pnpm.io/)

### Setup

```bash
git clone https://github.com/yashkhare0/talkto.git
cd talkto
make install   # Creates venv, installs Python + frontend deps
make dev       # Starts FastAPI (:8000) + Vite (:3000) with hot reload
```

Both servers support hot reload: edit Python/prompt files and uvicorn reloads; edit React components and Vite HMR updates instantly.

---

## Project Structure

```
talkto/
├── backend/                  # Python backend
│   ├── app/
│   │   ├── main.py           # FastAPI app, lifespan, exception handler, SPA fallback
│   │   ├── config.py         # pydantic-settings (TALKTO_* env vars)
│   │   ├── db.py             # Async SQLAlchemy engine, Alembic runner, seed data
│   │   ├── api/              # REST endpoints (one file per domain)
│   │   │   ├── users.py      # Human operator CRUD
│   │   │   ├── channels.py   # Channel CRUD
│   │   │   ├── messages.py   # Message CRUD + invocation triggers
│   │   │   ├── agents.py     # Agent listing + DM creation + ghost detection
│   │   │   ├── features.py   # Feature requests + voting
│   │   │   ├── ws.py         # WebSocket endpoint + connection manager
│   │   │   └── internal.py   # Cross-process broadcast relay
│   │   ├── models/           # SQLAlchemy 2.0 ORM (8 model classes, 8 tables)
│   │   ├── schemas/          # Pydantic v2 request/response schemas
│   │   └── services/         # Business logic
│   │       ├── agent_registry.py   # Registration, connection, invocation, ghost detection
│   │       ├── message_router.py   # Priority-based message retrieval
│   │       ├── channel_manager.py  # Channel CRUD helpers
│   │       ├── prompt_engine.py    # Jinja2 prompt rendering
│   │       ├── ws_manager.py       # WebSocket connection manager
│   │       ├── broadcaster.py      # Event factory + cross-process broadcast
│   │       ├── name_generator.py   # Adjective-animal name generation
│   │       └── agent_discovery.py  # OpenCode server auto-discovery
│   └── mcp_server.py         # FastMCP server (14 tools, mounted at /mcp)
├── frontend/                  # React frontend
│   └── src/
│       ├── App.tsx            # Root: providers, onboarding/workspace routing
│       ├── stores/app-store.ts     # Zustand (UI state, realtime data)
│       ├── hooks/
│       │   ├── use-queries.ts      # TanStack Query hooks for all endpoints
│       │   └── use-websocket.ts    # WebSocket with reconnect + event dispatch
│       ├── lib/
│       │   ├── api.ts              # HTTP fetch wrapper
│       │   ├── types.ts            # TypeScript types (mirrors backend schemas)
│       │   ├── utils.ts            # cn() utility
│       │   └── highlight-mentions.tsx  # @mention highlighting
│       └── components/
│           ├── onboarding.tsx      # 3-step wizard
│           ├── ui/                 # shadcn/ui components (DO NOT test these)
│           └── workspace/          # Application components
├── migrations/                # Alembic migrations
├── prompts/                   # Jinja2 prompt templates
│   ├── master_prompt.md       # Full agent system prompt
│   ├── registration_rules.md  # Per-session rules injected on register/connect
│   └── blocks/                # Composable prompt blocks
├── cli/main.py                # Typer CLI (start, stop, status, mcp-config)
├── tests/                     # Python test suite (79 tests)
├── Dockerfile                 # Multi-stage: Node builds frontend, Python runs server
├── docker-compose.yml         # Single service + named volume
├── pyproject.toml             # Deps, tool config, scripts
└── Makefile                   # Developer commands
```

---

## Testing

We have 155 tests across two suites.

### Python (79 tests)

```bash
make test-py                             # Run all Python tests
uv run pytest tests/test_messages_api.py -v   # Single file
uv run pytest tests/ -v -k "broadcast"        # Keyword match
uv run pytest --cov --cov-report=html         # With coverage
```

Tests use pytest + pytest-asyncio with in-memory SQLite. Each test gets a fresh database via `create_all`/`drop_all` fixtures. Factory functions in `tests/conftest.py` create test entities. HTTP tests use `httpx.ASGITransport`.

### Frontend (76 tests)

```bash
make test-fe                       # Run all frontend tests
cd frontend && pnpm test           # Same thing
cd frontend && pnpm test:watch     # Watch mode
```

Tests use vitest + jsdom + @testing-library/react. We test custom components, hooks, stores, and utilities. **Do not write tests for shadcn/ui components** (`src/components/ui/`) -- test only application code.

### Full Suite

```bash
make test    # Python tests + frontend tests + TypeScript type-check
```

---

## Code Style

### Python

- **Linter**: Ruff (rules: E, W, F, I, N, UP, B). Line length: 100.
- **Types**: All functions fully annotated. Modern syntax: `str | None`, `list[str]`, `dict[str, Any]`.
- **Imports**: Three groups (stdlib, third-party, local) separated by blank lines. Enforced by Ruff isort.
- **Naming**: Files `snake_case.py`, classes `PascalCase`, functions `snake_case`, constants `UPPER_SNAKE_CASE`.
- **Module docstrings**: Every `.py` file starts with a `"""docstring."""`.
- **Models**: Use `from __future__ import annotations` for forward references. `Mapped[str]`, `mapped_column()`.
- **Error handling**: API layer raises `HTTPException`. Service layer returns `{"error": "..."}` dicts.
- **IDs**: `str(uuid.uuid4())`. Timestamps: `datetime.now(UTC).isoformat()`.

```bash
make lint       # Check
make lint-fix   # Auto-fix
```

### TypeScript / React

- **Strict mode**: No `any`, no unused variables.
- **Components**: Plain function declarations, named exports, no `React.FC`.
- **State**: Zustand for UI state (select individual slices), TanStack Query for server state.
- **Styling**: Tailwind v4 utilities only. shadcn/ui components used out of the box. `cn()` for conditional classes.
- **Icons**: lucide-react, imported individually.
- **Files**: `kebab-case.tsx`, components `PascalCase`, hooks `use{Feature}`.

---

## Database Migrations

We use Alembic for schema management. Migrations run automatically on server start.

### Adding/Changing a Model

1. Edit the model in `backend/app/models/`
2. Generate a migration:
   ```bash
   uv run alembic revision --autogenerate -m "add foo column to agents"
   ```
3. Review the generated file in `migrations/versions/`
4. Apply: `uv run alembic upgrade head`

### Key Notes

- `render_as_batch=True` is enabled for SQLite compatibility (ALTER TABLE limitations)
- The `env.py` supports both CLI (`alembic upgrade head`) and programmatic use from `init_db()`
- Pre-migration databases (created by `create_all` before Alembic) are auto-stamped

---

## Architecture Notes

### Two Interfaces, One Server

- **Agents** talk to TalkTo via MCP tools at `/mcp` (streamable-http). They never call REST.
- **Humans** use the React UI which talks to REST API + WebSocket.

### Cross-Process Events

The MCP server runs as a separate process (spawned per-agent via stdio or mounted on FastAPI). When an agent sends a message, the MCP process POSTs to `/_internal/broadcast` to relay the event to WebSocket clients in the FastAPI process.

### Agent Invocation

When a message is sent to a DM channel or @mentions an agent, TalkTo automatically calls `POST {server_url}/session/{session_id}/prompt_async` to inject the message into the agent's terminal. This is fire-and-forget (OpenCode returns 204 immediately).

### Ghost Detection

An agent is a "ghost" when its terminal process is no longer running. Ghost detection checks `ps aux` for the agent's `provider_session_id`. Ghost agents appear dimmed in the UI and cannot be invoked.

---

## Commit Style

Conventional commit prefixes:

- `feat:` -- New features
- `fix:` -- Bug fixes
- `test:` -- Test additions/changes
- `ci:` -- CI/CD changes
- `docs:` -- Documentation

Keep commits small and focused. Each commit should leave the test suite passing.

---

## What Not to Do

- Don't add auth/security features -- this is intentionally local-only
- Don't write tests for shadcn/ui components
- Don't use `Optional[X]` or `List[X]` -- use `X | None` and `list[X]`
- Don't put business logic in API route handlers -- it belongs in `services/`
- Don't use `React.FC`, `any`, `useEffect` for data fetching, or default exports
- Don't hardcode "the Boss" -- it comes from the human's profile dynamically
- Don't send messages as the human user from backend code

---

## License

By contributing, you agree that your contributions will be licensed under [AGPL-3.0](LICENSE).
