# Contributing to TalkTo

Thanks for your interest in contributing to TalkTo. This document covers the development setup, conventions, and workflow.

## Setup

```bash
git clone https://github.com/yashkhare0/talkto.git && cd talkto
make install   # Python venv + deps + frontend deps
make dev       # Start dev servers
```

Requirements: Python 3.12+ (via uv), Node.js 20+ (via pnpm), macOS or Linux.

## Project Structure

- `backend/` — FastAPI + FastMCP Python backend
- `frontend/` — React + Vite + Tailwind v4 + shadcn/ui
- `migrations/` — Alembic database migrations
- `prompts/` — Markdown prompt templates (Jinja2)
- `cli/` — Typer CLI
- `tests/` — Python test suite (pytest)
- `frontend/src/**/*.test.*` — Frontend test suite (vitest)

## Development Workflow

### Running Tests

```bash
make test         # All tests (Python + frontend + tsc)
make test-py      # Python only
make test-fe      # Frontend only
make lint         # Ruff + tsc
make lint-fix     # Auto-fix Python lint
```

### Code Style

**Python:**
- Ruff for linting and formatting (rules: E, W, F, I, N, UP, B)
- Line length: 100
- Modern type annotations (`str | None`, not `Optional[str]`)
- All functions fully annotated
- Module docstrings on every `.py` file

**TypeScript/React:**
- ESLint + TypeScript strict mode
- Plain function components (no `React.FC`)
- Named exports (no default exports except lazy-loaded)
- Zustand for UI state, TanStack Query for server state
- shadcn/ui components used out of the box

### Database Migrations

We use Alembic for schema migrations. When changing models:

```bash
# Generate a migration after editing models
uv run alembic revision --autogenerate -m "describe your change"

# Review the generated migration in migrations/versions/
# Apply it
uv run alembic upgrade head
```

Migrations run automatically on server start via `init_db()`.

### Commit Style

We use conventional commit prefixes:
- `feat:` — new features
- `fix:` — bug fixes
- `test:` — test additions/changes
- `ci:` — CI/CD changes
- `docs:` — documentation

Keep commits small and focused. Each commit should leave the test suite passing.

## Architecture Notes

- **Agent interface**: MCP-only via FastMCP, served at `/mcp` (streamable-http). Agents never call REST directly.
- **Human interface**: REST API + WebSocket for the React UI.
- **Database**: SQLite with WAL mode. All IDs are UUID4 strings. Timestamps are ISO 8601 strings (not native datetime columns).
- **Cross-process events**: MCP server POSTs to `/_internal/broadcast` to push events to WebSocket clients.
- **Configuration**: All settings via `TALKTO_*` environment variables (pydantic-settings).

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE).
