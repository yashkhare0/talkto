# Task Plan: TalkTo TS Backend — Feature Completion

## Goal
Complete the TypeScript backend by wiring up agent invocation via native OpenCode SDK integration, switching the frontend to the TS backend, and updating infrastructure — so TalkTo works end-to-end: human sends a message, agent receives it via SDK, TalkTo posts the agent's response back to the channel.

## Current Phase
Phase 1

## Communication Protocol

**All replies (DMs + @mentions) use SDK-native responses.** TalkTo calls `session.prompt()`, gets the `AssistantMessage` back, and posts it to the channel as the agent. Agents never need `send_message` MCP tool for replies — only for proactive messages.

- **DMs**: `session.prompt()` with the message. No context stuffing — OpenCode session has its own history.
- **@mentions**: `session.prompt()` with last 5-10 channel messages as context + the triggering message.
- **Invocation is fire-and-forget** from the HTTP handler's perspective — runs in a background task with typing state broadcasts.
- **Future**: Active TUI sessions use `tui.appendPrompt()` + `tui.submitPrompt()` with `event.subscribe()` for real-time indicators.

## Phases

### Phase 1: Frontend Switch & End-to-End Verification
**Type**: Infrastructure
**Estimated**: 2-3 hours
**Files**: `frontend/vite.config.ts`, `server/src/index.ts`

Switch the frontend proxy from Python `:8000` to the TS backend. Verify the full UI works: channels, DMs, agent list, features, WebSocket events, MCP registration.

- [ ] Update `frontend/vite.config.ts` proxy target to TS backend port
- [ ] Start TS backend and frontend together
- [ ] Verify user onboarding flow
- [ ] Verify channel list loads (including existing channels from shared DB)
- [ ] Verify agent list loads with correct status/ghost detection
- [ ] Verify message sending (human -> channel, appears in real-time via WS)
- [ ] Verify MCP endpoint works (agent register via curl/test)
- [ ] Verify DM creation via `POST /api/agents/:name/dm`
- [ ] Verify feature requests + voting
- [ ] Fix any integration bugs
- **Status:** pending

**Verification Criteria:**
- [ ] Frontend loads without errors, all panels populated
- [ ] Sending a message shows it in the feed in real-time (via WebSocket)
- [ ] Agent list shows online/offline/ghost status correctly
- [ ] MCP `register` tool returns master_prompt and project_channel

**Exit Criteria:** Frontend works identically against the TS backend as it does against Python, minus agent invocation (messages go in, agents just don't respond yet).

---

### Phase 2: OpenCode SDK — Client & Discovery
**Type**: Integration
**Estimated**: 3-4 hours
**Files**: `server/package.json`, `server/src/sdk/opencode.ts` (new), `server/src/services/agent-discovery.ts` (new), `server/src/services/agent-registry.ts`

Install the OpenCode SDK and build the client management + discovery layer using SDK-native calls.

- [ ] Install `@opencode-ai/sdk` in `server/`
- [ ] Create `server/src/sdk/opencode.ts` — OpenCode client manager
  - [ ] `getClient(serverUrl)` — create or reuse `createOpencodeClient({ baseUrl })` per server URL
  - [ ] `listSessions(serverUrl)` — wraps `client.session.list()`, returns typed sessions
  - [ ] `getSession(serverUrl, sessionId)` — wraps `client.session.get()` for liveness check
  - [ ] `isSessionAlive(serverUrl, sessionId)` — boolean: does session exist in `session.list()`?
  - [ ] `promptSession(serverUrl, sessionId, text)` — wraps `session.prompt()`, returns response text
- [ ] Create `server/src/services/agent-discovery.ts` — simplified discovery
  - [ ] `discoverOpenCodeServer()` — `lsof` to find server port (only when agent didn't provide `server_url`)
  - [ ] `discoverSession(serverUrl, projectPath)` — `session.list()` + match by project path
  - [ ] `getAgentInvocationInfo(agentName)` — DB lookup -> verify liveness via SDK -> auto-discover if stale
  - [ ] `clearStaleCredentials(agentName)` — clear dead session info from DB
- [ ] Update `agent-registry.ts` — use SDK for liveness checks during ghost detection
- [ ] Write tests for client manager and discovery (mock SDK calls)
- **Status:** pending

**Verification Criteria:**
- [ ] `listSessions()` returns sessions from a running OpenCode instance
- [ ] `isSessionAlive()` correctly identifies live vs dead sessions
- [ ] `getAgentInvocationInfo()` returns server_url + session_id for registered agents
- [ ] Stale credentials are cleared when session is dead

**Exit Criteria:** TS backend can discover OpenCode servers, list sessions, verify liveness, and look up invocation info — all via SDK, not raw HTTP.

**Gotchas:**
- `createOpencodeClient` needs a `baseUrl` — still need `lsof` for port discovery when agent doesn't provide `server_url`
- `session.list()` returns ALL sessions — need to filter by project path
- Cache/reuse clients per `serverUrl` to avoid creating new connections per call

---

### Phase 3: OpenCode SDK — Invocation Pipeline
**Type**: Integration
**Estimated**: 4-6 hours
**Files**: `server/src/services/agent-invoker.ts` (new), `server/src/routes/messages.ts`, `server/src/services/message-router.ts`, `server/src/sdk/opencode.ts`

The core feature — when a message is sent, invoke the target agent via SDK and post the response back.

- [ ] Create `server/src/services/agent-invoker.ts`
  - [ ] `invokeForMessage(senderName, channelId, channelName, content, mentions)` — the orchestrator:
    - DM channel (`#dm-{agent_name}`) -> invoke target agent directly
    - @mentions -> invoke each mentioned agent
    - Never invoke the sender (prevent self-invocation loops)
    - Broadcast `agent_typing` events (start/stop/error)
    - Run in background (fire-and-forget from HTTP handler)
  - [ ] `invokeAgent(agentName, channelId, channelName, prompt)` — single agent invocation:
    - Look up invocation info via `getAgentInvocationInfo()`
    - Call `promptSession(serverUrl, sessionId, prompt)` from `sdk/opencode.ts`
    - Extract text from `AssistantMessage` response parts
    - Create message in the channel as the agent (via `message-router`)
    - Broadcast `new_message` + `agent_typing` (stop)
  - [ ] `formatChannelPrompt(senderName, channelName, content, recentMessages)` — for @mentions only:
    - Include last 5-10 channel messages as context
    - Include the triggering message
    - Instruct about channel context (not needed for DMs)
  - [ ] `fetchRecentContext(channelId, limit)` — get last N messages as formatted text
- [ ] Wire into `routes/messages.ts` POST handler:
    ```typescript
    // Fire-and-forget — don't await
    invokeForMessage(senderName, channelId, channel.name, content, mentions)
      .catch(err => console.error("[INVOKE] Failed:", err))
    ```
- [ ] Wire into `message-router.ts` `sendAgentMessage()` — same pattern for agent-to-agent @mentions
- [ ] Handle errors:
  - Agent not reachable -> broadcast `agent_typing` with error message
  - Session dead -> clear stale creds, attempt discovery, retry once
  - Timeout -> log and broadcast error
- [ ] Write tests (mock SDK calls, test DM vs @mention flows)
- **Status:** pending

**DM Flow (SDK-native reply):**
```
Human sends "fix the bug" to #dm-plucky-sparrow
  -> TalkTo spawns background task
  -> Broadcasts agent_typing (start)
  -> session.prompt({ path: { id: sessionId }, body: { parts: [{ text: "fix the bug" }] } })
  -> SDK blocks until agent responds (30-120s)
  -> Extracts text from AssistantMessage
  -> Creates message in #dm-plucky-sparrow as "plucky-sparrow"
  -> Broadcasts new_message + agent_typing (stop)
```

**@mention Flow (SDK-native reply with context):**
```
Human sends "@plucky-sparrow fix the auth bug" in #project-talkto
  -> TalkTo spawns background task
  -> Broadcasts agent_typing (start)
  -> Fetches last 5-10 messages from #project-talkto
  -> Builds prompt with channel context + triggering message
  -> session.prompt({ path: { id: sessionId }, body: { parts: [{ text: contextPrompt }] } })
  -> Extracts response
  -> Creates message in #project-talkto as "plucky-sparrow"
  -> Broadcasts new_message + agent_typing (stop)
```

**Verification Criteria:**
- [ ] DM to an agent -> agent receives prompt, TalkTo posts response in DM channel
- [ ] @mention in channel -> agent receives prompt with context, TalkTo posts response in channel
- [ ] `agent_typing` events fire correctly (start -> stop, or start -> error)
- [ ] Self-invocation is prevented
- [ ] Invocation doesn't block the HTTP response
- [ ] Dead sessions detected and handled gracefully

**Exit Criteria:** Human sends a message (DM or @mention) via frontend -> OpenCode agent processes it -> TalkTo posts the agent's response -> response appears in frontend. Full conversation loop.

**Gotchas:**
- `session.prompt()` blocks until the AI finishes (30-120s) — must run in background task
- Response is `AssistantMessage` with `parts: Part[]` — need to extract text content from parts
- Agent might produce tool calls, code execution, etc. in the response — we only want the text parts
- For @mentions with multiple agents, invoke in parallel (each in its own background task)
- Need a tracked background task pattern for Bun (prevent GC of promises)

---

### Phase 4: TUI Integration & Event Subscription
**Type**: Integration
**Estimated**: 3-4 hours
**Files**: `server/src/sdk/opencode.ts`, `server/src/services/agent-invoker.ts`, `server/src/services/broadcaster.ts`

Enhance invocation for active TUI sessions with real-time event-driven indicators.

- [ ] Add TUI detection to `sdk/opencode.ts`:
  - Determine if a session has an active TUI (investigate SDK — session status? TUI-specific endpoint?)
  - `isTuiActive(serverUrl, sessionId)` — boolean check
- [ ] Add TUI invocation to `agent-invoker.ts`:
  - For active TUI: `tui.appendPrompt({ body: { text } })` + `tui.submitPrompt()`
  - Fall back to `session.prompt()` if TUI is not active
  - TUI calls return `boolean` (no response) — need `event.subscribe()` to get the response
- [ ] Add `event.subscribe()` integration to `sdk/opencode.ts`:
  - `subscribeToEvents(serverUrl)` — returns async iterable of events
  - Filter events by session_id to scope to specific agents
  - Map OpenCode events to TalkTo events:
    - Agent starts processing -> `agent_typing` (is_typing: true)
    - Agent produces text -> capture for response extraction
    - Agent finishes -> `agent_typing` (is_typing: false)
    - Agent error -> `agent_typing` (is_typing: false, error: message)
  - Handle SSE reconnection if stream drops
  - Clean up subscriptions when agents disconnect
- [ ] Update `agent-invoker.ts` to use event-driven typing indicators for TUI sessions
- [ ] Write tests for TUI integration and event handling
- **Status:** pending

**Verification Criteria:**
- [ ] Active TUI agents see the prompt appear in their terminal
- [ ] Typing indicators reflect actual processing state (not just invocation start/stop)
- [ ] SSE reconnection works
- [ ] Events correctly scoped to the right agent/channel

**Exit Criteria:** Active TUI agents receive prompts naturally in their terminal, and the frontend shows accurate real-time indicators driven by OpenCode events.

**Gotchas:**
- `tui.appendPrompt` + `tui.submitPrompt` are two calls — race condition if user types between them
- SSE stream is server-wide — need to filter by session_id
- Memory leak risk if event subscriptions aren't closed on agent disconnect
- Need to investigate: what events does `event.subscribe()` actually emit? (types, payload structure)

---

### Phase 5: Infrastructure & Documentation
**Type**: Infrastructure
**Estimated**: 2-3 hours
**Files**: `AGENTS.md`, `Makefile`, `server/tests/*.test.ts`, `frontend/vite.config.ts`

- [ ] Update `AGENTS.md`:
  - Document TS backend architecture and SDK integration
  - New project structure (server/ directory)
  - How to start/test TS backend
  - Communication protocol (SDK-native replies)
- [ ] Update `Makefile`:
  - `make dev-ts` — start TS backend + frontend
  - `make test-ts` — run TS backend tests
  - Consider switching `make dev` default to TS backend
- [ ] Add comprehensive tests:
  - MCP tool integration tests (register -> send_message -> get_messages flow)
  - Agent discovery tests (mock SDK)
  - Agent invoker tests (mock SDK, test DM vs @mention, error handling)
  - WebSocket event tests
- [ ] Finalize `frontend/vite.config.ts` proxy (permanent switch to TS backend)
- **Status:** pending

**Verification Criteria:**
- [ ] `make dev-ts` starts TS backend + frontend
- [ ] `make test-ts` passes all tests
- [ ] AGENTS.md accurately describes current architecture
- [ ] Test coverage: registration, messaging, invocation, discovery

**Exit Criteria:** New developer can clone the repo, read AGENTS.md, run `make dev-ts`, and have a working TalkTo with agent invocation via OpenCode SDK.

---

## Key Questions
1. **TUI detection**: How does the SDK expose whether a session has an active TUI? Session status field? Separate endpoint?
2. **Event types**: What events does `event.subscribe()` emit? Need to inspect the stream from a live server.
3. **Multiple OpenCode servers**: Can there be multiple instances? If so, need multi-client management.
4. **Background task pattern in Bun**: Best approach — plain Promise, tracked `Set<Promise>`, or `queueMicrotask`?
5. **Response extraction**: How to extract clean text from `AssistantMessage.parts`? Parts can include text, tool calls, code blocks — we only want the text.
6. **Agent-to-agent @mentions**: When an agent's response (posted by TalkTo) mentions another agent, should that trigger invocation? (Could cause chains)

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| OpenCode SDK first, Codex + Claude later | All current agents are OpenCode. Ship working system first. |
| SDK-native replies for all invocations | Simpler, more reliable. Agents don't need MCP send_message for replies. |
| `session.prompt()` for initial implementation | Returns response directly. TUI integration added in Phase 4. |
| `session.list()` replaces ps/lsof discovery | SDK-native, reliable, cross-platform. |
| `session_id` required at registration | Eliminates most discovery complexity. Rejection message tells how to get it. |
| Keep `lsof` for server port discovery only | SDK needs `baseUrl` — still need to find the port if agent didn't provide `server_url`. |
| Fire-and-forget invocation | Don't block the HTTP response. Background task with typing state broadcasts. |
| Last 5-10 messages for @mention context | Channel context for agents. DMs don't need it (OpenCode session has history). |
| No context stuffing for DMs | OpenCode session maintains its own conversation history. |
| Single TS backend process | REST + MCP + WS in one process. No cross-process HTTP relay needed. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
|       | 1       |            |

## Notes
- Update phase status as you progress: pending -> in_progress -> complete
- Re-read this plan before major decisions
- Log ALL errors
- Python backend remains as reference (don't delete it)
- TS backend shares SQLite database (`data/talkto.db`)
- All agents currently are `agent_type: "opencode"` — multi-SDK support comes later
- Total estimated: 14-20 hours across 5 phases
