# Findings & Decisions

## Requirements
- Complete TS backend rewrite with native SDK integration (OpenCode first, Codex + Claude later)
- Switch frontend from Python backend to TS backend
- Agent invocation via OpenCode SDK — not raw HTTP calls
- SDK-native replies: TalkTo calls `session.prompt()`, gets response, posts it to channel
- DMs: no context stuffing (OpenCode session has own history)
- @mentions: include last 5-10 channel messages as context
- Active TUI support: `tui.appendPrompt()` + `tui.submitPrompt()` with `event.subscribe()`
- Fire-and-forget invocation with typing state broadcasts
- `session_id` required at registration (reject without it, include instructions in error)
- Discovery simplified: `session.list()` replaces ps/lsof/process-tree hacks

## Research Findings

### OpenCode SDK (`@opencode-ai/sdk` v1.2.6)
- **Architecture**: HTTP client/server. SDK creates a client that talks to a running OpenCode server.
- **Client creation**: `createOpencodeClient({ baseUrl: "http://localhost:4096" })` for existing servers
- **Session management**:
  - `session.list()` — list all sessions (returns `Session[]`)
  - `session.get({ path: { id } })` — get single session
  - `session.create({ body: { title } })` — create new session
  - `session.delete({ path: { id } })` — delete session
  - `session.abort({ path: { id } })` — abort running session
- **Invocation**:
  - `session.prompt({ path: { id }, body: { parts, model, noReply } })` — send prompt
  - Default (`noReply: false`): blocks until AI responds, returns `AssistantMessage`
  - `noReply: true`: injects context only, returns `UserMessage`, no AI response triggered
  - Response: `{ data: { info: Message, parts: Part[] } }` — extract text from parts
- **TUI control**:
  - `tui.appendPrompt({ body: { text } })` — append text to TUI prompt input
  - `tui.submitPrompt()` — submit the current prompt in TUI
  - `tui.clearPrompt()` — clear TUI prompt
  - Returns `boolean` — no response content
- **Events**:
  - `event.subscribe()` — SSE stream, returns async iterable
  - Events have `type` and `properties` fields
  - Stream is server-wide (not per-session) — need to filter by session_id
- **Other useful APIs**:
  - `session.messages({ path: { id } })` — get message history
  - `global.health()` — check server health
  - `project.current()` — get current project info
- **Gotchas**:
  - Requires `opencode` binary on PATH
  - Types auto-generated from OpenAPI spec
  - `session.prompt()` is blocking (waits for full AI response, 30-120s)
  - No native fire-and-forget for prompts that trigger AI response

### Codex SDK (`@openai/codex-sdk` v0.104.0) — NOT YET NEEDED
- Thread-based: `new Codex()` -> `startThread()` / `resumeThread(id)` -> `thread.run(prompt)`
- `run()` blocks, `runStreamed()` returns async event iterator
- Requires `@openai/codex` CLI binary (Rust)
- Requires Git repo by default
- OpenAI models only
- Will integrate when Codex agents are added

### Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.45) — NOT YET NEEDED
- Single `query()` function returns async iterator of messages
- Always streaming (no blocking mode)
- Resume via `options: { resume: sessionId }`
- 80 MB package (bundles Claude Code runtime)
- Requires `ANTHROPIC_API_KEY`
- Commercial ToS (not open source)
- Will integrate when Claude agents are added

### TS Backend Current State (as of commit 735fca2)
- 23 files, ~4,009 lines, 22 tests passing (278 assertions)
- All 14 REST API routes matching frontend contract
- 13 MCP tools via `@modelcontextprotocol/sdk` (streamable HTTP)
- Bun-native WebSocket with channel subscriptions
- Drizzle ORM with bun:sqlite (WAL mode, 8 tables)
- All services ported from Python
- **Missing**: agent invocation, agent discovery, TUI integration, event subscription
- Two TODO comments mark the invocation gaps:
  - `server/src/routes/messages.ts:133` — POST handler
  - `server/src/services/message-router.ts:73` — sendAgentMessage()

### Python Backend Reference
- `agent_invoker.py` (584 lines): raw HTTP calls to OpenCode REST API (`prompt_async`, `/session/{id}/message`)
- `agent_discovery.py` (417 lines): 4 strategies (PID walk, TTY scan, process scan, REST API)
- `message_service.py` (105 lines): message creation triggers `invoke_for_message()` in background task
- `broadcaster.py` (178 lines): cross-process event delivery (direct or via HTTP relay)
- The Python approach is entirely replaced by SDK integration — don't port it, redesign it

### Frontend Expectations
- All HTTP calls use `/api/*` prefix
- WebSocket at `/ws`, events: `new_message`, `agent_status`, `agent_typing`, `channel_created`, `feature_update`
- `agent_typing` events expected: `{ agent_name, channel_id, is_typing, error? }`
- Agent interface includes `is_ghost: boolean`
- Frontend doesn't need changes — the TS backend serves the same API contract

### Database Schema (8 tables)
- `agents` table has `server_url` and `provider_session_id` columns — used for invocation
- `messages` table has `parent_id` (threading support, not yet used)
- No working memory tables — not needed, OpenCode sessions have their own context
- Shared between Python and TS backends (`data/talkto.db`)

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| SDK-native replies for all | Agents don't need to know about TalkTo MCP tools for replies. Simpler protocol. |
| `session.prompt()` as primary invocation | Returns response directly. TUI integration added later in Phase 4. |
| No context stuffing for DMs | OpenCode session maintains conversation history across prompts |
| Last 5-10 messages for @mentions | Agent's OpenCode session doesn't know TalkTo channel history |
| `lsof` kept for server port only | SDK needs baseUrl, can't discover port without OS-level check |
| `session.list()` for discovery | Replaces 4 Python discovery strategies with one SDK call |
| Background tasks for invocation | session.prompt() blocks 30-120s — can't block HTTP response |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Permission denied writing task_plan.md in plan mode | Waited for build mode to write files |

## Resources
- OpenCode SDK docs: https://opencode.ai/docs/sdk/
- OpenCode SDK npm: https://www.npmjs.com/package/@opencode-ai/sdk
- OpenCode SDK types: https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts
- Codex SDK npm: https://www.npmjs.com/package/@openai/codex-sdk
- Claude Agent SDK npm: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- TS backend commit: 735fca2 (26 files, 4,398 lines)
- Python agent_invoker.py: `backend/app/services/agent_invoker.py` (584 lines, reference)
- Python agent_discovery.py: `backend/app/services/agent_discovery.py` (417 lines, reference)

---
*Update this file after every 2 view/browser/search operations*
