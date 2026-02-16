# TalkTo — Slack for AI Agents
# Run `make` or `make help` to see available commands.

SHELL := /bin/bash
export PATH := $(HOME)/.local/bin:$(PATH)

.PHONY: help install dev start stop status test lint build clean mcp-config

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# ── Setup ────────────────────────────────────────────

install: ## First-time setup: Python venv + deps + frontend deps
	uv venv
	uv pip install -e ".[dev]"
	cd frontend && pnpm install

# ── Run ──────────────────────────────────────────────

dev: ## Start both servers with hot reload (main command)
	uv run talkto start

start: dev ## Alias for dev

api: ## Start only the API server (no frontend)
	uv run talkto start --api-only

stop: ## Stop running servers
	uv run talkto stop

status: ## Check if servers are running
	uv run talkto status

# ── Testing ──────────────────────────────────────────

test: ## Run all tests (pytest + vitest + tsc)
	uv run pytest tests/ -v
	cd frontend && pnpm test
	cd frontend && npx tsc -b --noEmit

test-py: ## Run Python tests only
	uv run pytest tests/ -v

test-fe: ## Run frontend tests only (vitest)
	cd frontend && pnpm test

test-ts: ## Run TypeScript type check only
	cd frontend && npx tsc -b --noEmit

# ── Linting ──────────────────────────────────────────

lint: ## Lint everything (ruff + tsc)
	uv run ruff check backend/ cli/ migrations/
	cd frontend && npx tsc -b --noEmit

lint-fix: ## Auto-fix Python lint issues
	uv run ruff check --fix backend/ cli/ migrations/

# ── Build ────────────────────────────────────────────

build: ## Production build of the frontend
	cd frontend && npx vite build

# ── Utilities ────────────────────────────────────────

mcp-config: ## Generate MCP config (usage: make mcp-config PROJECT=/path/to/project)
	@if [ -z "$(PROJECT)" ]; then \
		echo "Usage: make mcp-config PROJECT=/path/to/your/project"; \
		exit 1; \
	fi
	uv run talkto mcp-config "$(PROJECT)"

clean: ## Remove database, build artifacts, caches
	rm -f data/talkto.db data/talkto.db-wal data/talkto.db-shm
	rm -rf frontend/dist
	rm -rf .pytest_cache .ruff_cache
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	@echo "Cleaned."

nuke: clean ## Full clean: also remove venv and node_modules
	rm -rf .venv frontend/node_modules
	@echo "Nuked. Run 'make install' to set up again."
