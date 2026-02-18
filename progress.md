# Progress Log

## Session: 2026-02-18

### Phase 0: Planning
- **Status:** complete
- **Started:** 2026-02-18
- Actions taken:
  - Explored full codebase state (TS backend, Python backend, frontend, DB schema)
  - Researched OpenCode SDK, Codex SDK, Claude Agent SDK APIs and types
  - Designed TalkTo communication protocol (SDK-native replies for all invocations)
  - Discussed and resolved key architectural decisions with user
  - Committed TS backend foundation (735fca2 — 26 files, 4,398 lines)
  - Created planning files: task_plan.md, findings.md, progress.md
- Files created/modified:
  - task_plan.md (created)
  - findings.md (created)
  - progress.md (created)
- Key decisions:
  - All replies via `session.prompt()` — TalkTo posts response, agents don't need MCP send_message
  - OpenCode SDK first, Codex + Claude later
  - `session.list()` replaces ps/lsof/process-tree discovery
  - DMs: no context stuffing. @mentions: last 5-10 channel messages
  - TUI integration (`tui.appendPrompt` + `event.subscribe`) planned as Phase 4

### Phase 1: Frontend Switch & E2E Verification
- **Status:** complete
- **Started:** 2026-02-18
- Actions taken:
  - Stopped Python backend on :8000, started TS backend on :8000
  - Verified all 14 API routes return correct data from shared SQLite DB
  - Verified WebSocket: connect, ping/pong, subscribe, message broadcast
  - Found and fixed MCP bug: singleton McpServer -> factory pattern (createMcpServer())
  - Verified MCP: init, tools/list (13 tools), multi-session support
  - Started frontend on :3000, verified proxy works
  - All 22 tests still pass after MCP refactor
  - Committed as 67083ef
- Files created/modified:
  - server/src/mcp/server.ts (refactored: export singleton -> export factory)
  - server/src/index.ts (use createMcpServer() per session)

### Phase 2: OpenCode SDK — Client & Discovery
- **Status:** complete
- **Committed:** 9fec25c
- Actions taken:
  - Installed `@opencode-ai/sdk@1.2.6`
  - Created `server/src/sdk/opencode.ts` — cached client manager with getClient(), listSessions(), getSession(), isSessionAlive(), isServerHealthy(), promptSession(), extractTextFromParts(), matchSessionByProject(), discoverSession(), tuiPrompt()
  - Created `server/src/services/agent-discovery.ts` — simplified discovery: discoverOpenCodeServer() (lsof), getAgentInvocationInfo() (DB → liveness → auto-discover), clearStaleCredentials(), isAgentGhost()
  - 15 new tests for matchSessionByProject and extractTextFromParts
  - 37 total tests passing (298 assertions)
- Files created/modified:
  - server/src/sdk/opencode.ts (created)
  - server/src/services/agent-discovery.ts (created)
  - server/tests/opencode.test.ts (created)
  - server/package.json (added @opencode-ai/sdk)

### Phase 3: OpenCode SDK — Invocation Pipeline
- **Status:** complete
- Actions taken:
  - Created `server/src/services/agent-invoker.ts` — invocation engine: invokeForMessage(), invokeAgent(), postAgentResponse(), fetchRecentContext(), formatChannelPrompt(), spawnBackgroundTask()
  - Wired invokeForMessage() into routes/messages.ts POST handler and message-router.ts sendAgentMessage()
  - **Key discovery:** session.prompt() hangs on busy sessions (e.g., agent's active TUI session). Fixed by creating dedicated invocation sessions per agent via session.create()
  - Added to SDK: createSession(), getOrCreateInvocationSession(), clearInvocationSession(), prompt timeout (2 min)
  - Fixed isServerHealthy() — client.global.health doesn't exist, use session.list() instead
  - Live-tested DM invocation: Bossu→plucky-sparrow, response in ~2.5s
  - Live-tested conversation history: session reuse works, agent recalls prior messages
  - Live-tested @mention in #general: "what is 2+2?" → "4"
  - 37 tests pass (298 assertions)
- Files created/modified:
  - server/src/services/agent-invoker.ts (created)
  - server/src/sdk/opencode.ts (updated: createSession, getOrCreateInvocationSession, prompt timeout, health fix)
  - server/src/routes/messages.ts (modified: wired invokeForMessage)
  - server/src/services/message-router.ts (modified: wired invokeForMessage)
- Key discovery:
  - session.prompt() hangs indefinitely on busy sessions (no status field exposed by OpenCode API)
  - Fix: always create dedicated invocation sessions per agent, cache and reuse them
  - session.create() works, new sessions are idle and respond to prompt() in 2-3s
  - Invocation sessions maintain conversation history across prompts

### Phase 4: TUI Integration & Event Subscription
- **Status:** complete
- **Committed:** 923e3b1, ebaab42 (TUI removal from invoker: 030adaf)
- Actions taken:
  - Researched OpenCode SDK internals: discovered `event.subscribe()` returns `AsyncGenerator<Event>`, `session.status()` returns `{sessionID: SessionStatus}` map, 30+ event types with typed payloads
  - Added `getSessionStatuses()`, `getSessionStatus()`, `isSessionBusy()` — wraps `session.status()` for busy/idle detection
  - Added `subscribeToEvents()` — wraps `event.subscribe()`, returns typed async generator
  - Added `filterEventsBySession()` — filters SSE stream for events matching a specific sessionID
  - Added `promptSessionWithEvents()` — prompts session while consuming SSE events for real-time callbacks (onTypingStart, onTextDelta, onComplete, onError)
  - Added `isTuiActive()` — heuristic TUI detection via `tui.clearPrompt()` success
  - Enhanced `tuiPrompt()` — clears prompt before appending to prevent text concatenation
  - Added `tuiToast()` — show toast notifications in agent's TUI
  - Updated `agent-invoker.ts` — now checks session busy status, detects TUI, uses event-driven prompting with real-time typing broadcasts
  - Added 11 new tests: filterEventsBySession (8 tests), SessionStatus types (3 tests)
  - Live tested: DM to spicy-bat with TUI active, response "PHASE4_LIVE_TEST_OK" received correctly
- Files created/modified:
  - server/src/sdk/opencode.ts (major update: +8 new functions, type imports expanded)
  - server/src/services/agent-invoker.ts (updated: TUI detection, busy check, event-driven prompting)
  - server/tests/opencode.test.ts (updated: +11 tests for filterEventsBySession and SessionStatus)
- Key discoveries:
  - `session.status()` only returns entries for busy/retry sessions — absent means idle
  - `event.subscribe()` returns `{ stream: AsyncGenerator }` at top level (not nested in `data`)
  - First SSE event is always `server.connected` (like a handshake)
  - `tui.clearPrompt()` succeeds when TUI is connected, fails when not — works as detection heuristic
  - SSE events include `message.part.updated` with `delta` field for streaming text

### Phase 5: Infrastructure & Documentation
- **Status:** complete
- Actions taken:
  - Removed entire Python backend: `backend/`, `cli/`, `tests/` (Python), `bin/talkto.mjs`
  - Removed Python config: `pyproject.toml`, `uv.lock`, `alembic.ini`, `migrations/`, root `package.json`
  - Updated CI: replaced Python/pytest job with Bun/bun:test job
  - Rewrote Dockerfile for `oven/bun:1` multi-stage build (Node builds frontend, Bun runs server)
  - Updated docker-compose.yml healthcheck for Bun
  - Cleaned `.gitignore` of Python-specific entries
  - Rewrote `AGENTS.md` for TS-only architecture
  - Updated `docs/AGENT_USER_GUIDE.md` — removed `connect()`, `agent_type`, clarified auto-reply flow
  - Updated `README.md` — new quickstart, architecture diagram, tech stack, commands
  - Updated `prompts/master_prompt.md` — removed Python/FastAPI example references
  - Updated `prompts/blocks/tools.md` — clarified `send_message` is proactive only, added `create_feature_request`
  - Updated `prompts/blocks/messaging.md` — documented DM channels, automatic reply flow
  - Updated `prompts/registration_rules.md` — fixed incorrect `send_message` for replies instructions
  - Updated MCP tool descriptions in `server/src/mcp/server.ts`
  - Removed TUI invocation path from `agent-invoker.ts` (TUI SDK kept for future use)
  - Rewrote `CONTRIBUTING.md` for TS-only architecture
  - All 48 tests passing (336 assertions) after all changes
- Files created/modified:
  - AGENTS.md (rewritten)
  - README.md (updated)
  - CONTRIBUTING.md (rewritten)
  - docs/AGENT_USER_GUIDE.md (updated)
  - prompts/master_prompt.md (updated)
  - prompts/blocks/tools.md (updated)
  - prompts/blocks/messaging.md (updated)
  - prompts/registration_rules.md (updated)
  - server/src/mcp/server.ts (updated descriptions)
  - server/src/services/agent-invoker.ts (removed TUI path)
  - Dockerfile (rewritten)
  - docker-compose.yml (updated)
  - .github/workflows/ci.yml (updated)
  - .gitignore (cleaned)
- Commits:
  - eca1168 Remove Python backend, CLI, and test suite
  - b85a69a Remove Python config files, Alembic migrations, and npm wrapper
  - b129d5d Update CI: replace Python backend job with Bun server tests
  - 0916f59 Rewrite Dockerfile and docker-compose for Bun runtime
  - 458ca91 Clean up .gitignore: remove Python-specific entries
  - 030adaf Update MCP tool descriptions and onboarding prompts for clarity
  - ebaab42 Remove TUI invocation path from agent-invoker
  - 3f7dd77 Rewrite AGENTS.md for TS-only architecture
  - d5c0a69 Update AGENT_USER_GUIDE for TS backend conventions
  - ed9367d Update master prompt examples to remove Python/FastAPI references
  - 3cae24c Update README for TS-only architecture
  - 95a8dea Rewrite CONTRIBUTING.md for TS-only architecture

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| TS backend tests | `bun test` in server/ | 48 pass | 48 pass (336 assertions, 124ms) | PASS |
| Live DM invocation | DM "Reply with exactly: LIVE_TEST_OK" to plucky-sparrow | Agent response in channel | "LIVE_TEST_OK" posted in 2.5s | PASS |
| Live conversation memory | DM "What was the last thing I asked you?" | Recalls prior message | Correctly recalled LIVE_TEST_OK request | PASS |
| Live @mention | @plucky-sparrow in #general "what is 2+2?" | Agent responds in channel | "4" posted | PASS |
| Phase 4 DM + TUI | DM "Reply with exactly: PHASE4_LIVE_TEST_OK" to spicy-bat | Agent responds via TUI path | "PHASE4_LIVE_TEST_OK" posted, TUI detected, event-driven prompt | PASS |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-02-18 | Permission denied writing task_plan.md | 1 | Waited for build mode (was in plan/read-only mode) |
| 2026-02-18 | MCP: "Already connected to a transport" on 2nd session | 1 | Refactored mcpServer singleton to createMcpServer() factory |
| 2026-02-18 | session.prompt() hangs on busy session (plucky-sparrow's TUI) | 2 | Create dedicated invocation sessions per agent via session.create() |
| 2026-02-18 | client.global.health is not a function | 1 | Use session.list() as health check instead |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | All 5 phases complete. Python backend fully removed. TS-only architecture. |
| Where am I going? | All planned work is done. Ready for new features or bug fixes. |
| What's the goal? | Complete TS backend with OpenCode SDK agent invocation — ACHIEVED |
| What have I learned? | session.status() is separate API, SSE stream is AsyncGenerator, TUI detection via clearPrompt heuristic, session.list() is project-scoped |
| What have I done? | Phases 0-5 complete. Full invocation pipeline, event-driven typing, Python removal, docs rewrite, 48 tests passing |

---
*Update after completing each phase or encountering errors*
