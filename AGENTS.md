# AGENTS.md — Coding Agent Guide for TalkTo

## Project Overview

TalkTo is a Python 3.12+ MCP (Model Context Protocol) server for inter-agent messaging
and collaboration. Built with FastMCP, Starlette, Uvicorn, Pydantic, and SQLite.
Package manager is **uv** (lockfile: `uv.lock`). Build backend is Hatchling.

## Architecture

Layered design with clean separation of concerns:

- `talkto/models.py` — Pydantic data models (Agent, Message, FeatureRequest, DirectQueueEntry)
- `talkto/db.py` — SQLite data access layer (sync `sqlite3`, WAL mode, raw SQL, no ORM)
- `talkto/tools.py` — Business logic for MCP tool implementations
- `talkto/server.py` — FastMCP server + Starlette REST routes, wiring layer
- `talkto/backends.py` — Agent communication backends (Strategy pattern: SubprocessBackend, OpenCodeServerBackend)
- `talkto/scanner.py` — CLI session discovery (Claude/OpenCode/Codex), strategy dispatch via dict
- `talkto/log.py` — Loguru logging configuration
- `talkto/static/chat.html` — Web UI chat viewer

## Build / Run / Install Commands

```bash
# Install dependencies
uv sync

# Start the server
uv run python -m talkto

# Start in dev mode (with reload)
uv run python -m talkto --reload

# Clean database and caches
make clean

# Reset (clean + start)
make reset
```

### Makefile targets

| Target    | Command                           | Description              |
|-----------|-----------------------------------|--------------------------|
| `install` | `uv sync`                         | Install dependencies     |
| `start`   | `uv run python -m talkto`         | Start the server         |
| `dev`     | `uv run python -m talkto --reload`| Start with auto-reload   |
| `clean`   | removes `data/talkto.db` + `__pycache__` | Clean artifacts  |
| `reset`   | `clean` then `start`              | Fresh start              |

## Testing

No formal test framework is configured yet. No `tests/` directory, no pytest config,
no test dependencies. When tests are added, they should use `pytest` and follow standard
Python conventions (`tests/test_<module>.py`). To run a single test (once added):

```bash
uv run pytest tests/test_db.py::test_register_agent -v
```

## Linting / Formatting

No linter or formatter is currently configured (no ruff, black, isort, flake8, mypy).
When contributing, follow the existing code style documented below. If a linter is added
later, prefer `ruff` for combined linting and formatting.

## Code Style Guidelines

### Imports

1. Every module starts with `from __future__ import annotations`
2. Import order (separated by blank lines):
   - `__future__`
   - Standard library (`import asyncio`, `from pathlib import Path`, etc.)
   - Third-party (`from mcp.server.fastmcp import FastMCP`, `from pydantic import BaseModel`)
   - Relative intra-package (`from .log import logger`, `from . import db`)
3. Use named imports — never `from module import *`
4. Two import styles coexist:
   - Module import for heavy usage: `from . import db` then `db.function()`
   - Named imports for targeted use: `from .db import register_agent, insert_message`
5. Alias imports to avoid name collisions: `list_feature_requests as db_list_feature_requests`
6. Late/lazy imports inside functions are acceptable for rarely-needed modules

### Formatting

- **Indentation:** 4 spaces
- **Quotes:** Double quotes (`"`) everywhere — no single quotes
- **Line length:** ~100-120 characters soft limit
- **Trailing commas:** Used in multi-line structures
- **Blank lines:** Two between top-level definitions, one between methods
- **Section headers:** Use decorated comments for code sections:
  ```python
  # ── Agents ──────────────────────────────────────────────────────────────────
  # -- Configuration --
  ```

### Naming Conventions

| Element           | Convention          | Example                          |
|-------------------|---------------------|----------------------------------|
| Files             | `snake_case.py`     | `backends.py`, `scanner.py`      |
| Functions/vars    | `snake_case`        | `tool_register`, `get_agent_by_name` |
| Classes           | `PascalCase`        | `Agent`, `BackendManager`        |
| Constants         | `SCREAMING_SNAKE`   | `SMART_PULL_TIMEOUT`, `HOST`     |
| Private/internal  | `_leading_underscore`| `_validate_name`, `_get_conn`    |
| MCP tool funcs    | `tool_` prefix      | `tool_send_message`, `tool_register` |

### Type Annotations

- Use `Optional[T]` from `typing` (not `T | None`) for consistency with existing code
- Pydantic `BaseModel` with `Field(...)` for external-facing data models
- `@dataclass` for internal-only value objects (e.g., `BackendResult`)
- Annotate return types on all public functions: `def func() -> str:`
- No use of `Any` — avoid loose typing
- `from __future__ import annotations` enables deferred evaluation in every module

### Error Handling

- **MCP tool functions** return error strings, never raise exceptions:
  ```python
  if not agent:
      return "Error: You're not registered. Call `register` first."
  ```
- **REST API handlers** return `JSONResponse` with appropriate HTTP status codes:
  ```python
  return JSONResponse({"error": "Agent not found"}, status_code=404)
  ```
- **Narrow try/except** — catch specific exception types, not bare `except:`
- **Scanner functions** must never raise — wrap in try/except, return `None` on failure
- No custom exception classes — errors are strings or None returns

### Async Patterns

- `async/await` for all I/O operations in server and backends
- Sync code in `db.py`, `tools.py`, `scanner.py` — bridged with `asyncio.to_thread()`
- Polling loops use `asyncio.sleep` with deadlines
- Background tasks via `asyncio.create_task` with `CancelledError` handling for cleanup

### Logging

- Use loguru throughout: `from .log import logger`
- Brace-style formatting: `logger.info("Registered agent {}", agent_name)`
- Never use `print()` or stdlib `logging` — always loguru's `logger`

### Documentation

- Module-level docstrings in every `.py` file describing its purpose
- Function docstrings on all public functions (short single-line or multi-line)
- Inline comments explain "why", not "what"
- Section headers with Unicode box-drawing or dashes for visual separation

### Function Style

- Top-level `def` declarations (no lambdas in the codebase)
- Nested helper functions for localized logic (e.g., `_run()` inside `send_prompt`)
- `@property` and `@abstractmethod` decorators follow standard Python conventions

## Key Patterns to Preserve

1. **Smart Pull:** Every MCP tool response is piped through `_inject_pending_directs()` to
   piggyback pending DMs onto existing traffic — do not bypass this
2. **Layered delegation:** Server routes → tool functions → db functions. Keep layers clean.
3. **Backend abstraction:** New backends must implement `AgentBackend` ABC
4. **Scanner dispatch:** New CLI scanners go into `_SCANNERS` dict in `scanner.py`
5. **Module-level init:** DB and logging are initialized at import time in `server.py`

## Dependencies

Core: `mcp[cli]`, `pydantic`, `starlette`, `uvicorn`, `loguru`, `aiosqlite`, `httpx`
Python: `>=3.12` (specified in `.python-version` and `pyproject.toml`)
