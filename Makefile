# TalkTo — Slack for AI Agents
# Run `make` or `make help` to see available commands.

SHELL := /bin/bash
export PATH := $(HOME)/.bun/bin:$(HOME)/.local/bin:$(PATH)

.PHONY: help install dev start stop status kill test lint build clean mcp-config

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# ── Setup ────────────────────────────────────────────

install: ## First-time setup: server deps + frontend deps
	cd server && bun install
	cd frontend && pnpm install

# ── Run ──────────────────────────────────────────────

dev: ## Start backend + frontend with hot reload
	@echo "Starting TS backend on :8000 and frontend on :3000..."
	@cd server && nohup bun run src/index.ts > /tmp/talkto-server.log 2>&1 &
	@cd frontend && nohup pnpm dev > /tmp/talkto-frontend.log 2>&1 &
	@sleep 2
	@echo "Backend:  http://localhost:8000"
	@echo "Frontend: http://localhost:3000"
	@echo "Logs:     /tmp/talkto-server.log, /tmp/talkto-frontend.log"

start: dev ## Alias for dev

api: ## Start only the TS backend (no frontend)
	cd server && bun run src/index.ts

stop: kill ## Stop running servers

kill: ## Force-kill anything on ports 8000 and 3000
	@lsof -ti :8000 2>/dev/null | xargs kill -9 2>/dev/null || true
	@lsof -ti :3000 2>/dev/null | xargs kill -9 2>/dev/null || true
	@echo "Killed processes on :8000 and :3000"

status: ## Check if servers are running
	@echo "Backend  (:8000):" && (lsof -i :8000 -P -n 2>/dev/null | grep LISTEN || echo "  not running")
	@echo "Frontend (:3000):" && (lsof -i :3000 -P -n 2>/dev/null | grep LISTEN || echo "  not running")

# ── Testing ──────────────────────────────────────────

test: ## Run all tests (bun test + vitest + tsc)
	cd server && bun test
	cd frontend && pnpm test
	cd frontend && npx tsc -b --noEmit

test-server: ## Run server tests only (bun:test)
	cd server && bun test

test-fe: ## Run frontend tests only (vitest)
	cd frontend && pnpm test

test-ts: ## Run TypeScript type check only
	cd frontend && npx tsc -b --noEmit

# ── Linting ──────────────────────────────────────────

lint: ## Lint everything (tsc)
	cd frontend && npx tsc -b --noEmit

# ── Build ────────────────────────────────────────────

build: ## Production build of the frontend
	cd frontend && npx vite build

# ── Utilities ────────────────────────────────────────

clean: ## Remove database, build artifacts, caches
	rm -f data/talkto.db data/talkto.db-wal data/talkto.db-shm
	rm -rf frontend/dist
	@echo "Cleaned."

nuke: clean ## Full clean: also remove node_modules
	rm -rf server/node_modules frontend/node_modules
	@echo "Nuked. Run 'make install' to set up again."
