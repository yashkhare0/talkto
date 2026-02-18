Implementation Plan: Auto Session Discovery + Direct Messaging
Overview
Three major pieces:

1. Session scanner (scanner.py) - reads CLI session stores from disk, matches by working_dir
2. Registration changes - agents pass cli_type + working_dir, TalkTo auto-discovers session_id
3. Direct messaging - MCP tool direct_message for agent-to-agent + updated REST POST /api/direct for Yash's UI. Gated by a config toggle.

---
File-by-file plan

1. NEW: talkto/scanner.py
Session discovery module. Pure functions, no side effects.
discover_session(cli_type: str, working_dir: str) -> Optional[str]
Returns the most recently updated session ID for the given CLI type + working directory, or None.
Scanner logic per CLI:
Claude Code (~/.claude/projects/*/sessions-index.json):

- Iterate all sessions-index.json files
- Each has entries[] with sessionId, projectPath, modified
- Match: normalize entry.projectPath vs working_dir (case-insensitive, normalize slashes)
- Pick entry with latest modified timestamp
- Return entry.sessionId
OpenCode (~/.local/share/opencode/storage/):
- Read all project/*.json files to find one where worktree matches working_dir
- Get the project.id
- Read all session/{project_id}/*.json files
- Each has id, time.updated
- Pick session with latest time.updated
- Return session.id
Codex (~/.codex/sessions/YYYY/MM/DD/*.jsonl):
- Scan recent files (last 30 days to limit scope)
- Read first line of each JSONL (the session_meta)
- Match: normalize payload.cwd vs working_dir
- Pick session with latest payload.timestamp
- Return payload.id
Path normalization: Path(p).resolve() on both sides, case-insensitive on Windows. Also normalize forward/back slashes.
Staleness: Ignore sessions older than 30 days (configurable).
Error handling: All file reads wrapped in try/except. If any CLI's session store doesn't exist (not installed), silently skip. Never crash registration due to scanner failure.

2. EDIT: talkto/models.py

- Add working_dir: Optional[str] = None to Agent model
- session_id stays Optional[str] (auto-populated by scanner, can be manually overridden)
- cli_type stays Optional[str]

3. EDIT: talkto/db.py

- Migration: Add working_dir TEXT column to agents table (in_migrate())
- _row_to_agent(): Add working_dir=r["working_dir"]
- register_agent():
  - INSERT now includes working_dir
  - UPDATE on re-registration: also update cli_type, session_id, working_dir (these change when agent reconnects from a different CLI or session)
- update_agent_cli(): Accept working_dir parameter too, update all three fields
- Uniqueness constraint: Add UNIQUE on session_id where not null. This is tricky in SQLite since ALTER TABLE doesn't support adding constraints. We'll enforce this in application code: before setting a session_id on agent A, check if any other agent already has that session_id. If so, clear the old one (or reject).

4. EDIT: talkto/tools.py
Updated tool_register():

- New params: cli_type: Optional[str] = None, working_dir: Optional[str] = None
- After creating/updating the Agent record, if cli_type and working_dir are provided:
  - Call scanner.discover_session(cli_type, working_dir) to get session_id
  - Call db.update_agent_cli(name, cli_type, session_id, working_dir) to store all three
- If scanner fails or returns None, still store cli_type and working_dir (session_id stays None - manual config still works as fallback)
- Session uniqueness: Before storing a discovered session_id, check if another agent already has it. If so, clear the old agent's session_id (the most recently registered agent wins - they're the active one).
New tool_direct_message():
- Params: agent_name: str (sender), to: str (target), prompt: str
- Checks:
  - Sender must be registered
  - Target must exist and have cli_type set
  - Config toggle TALKTO_ALLOW_AGENT_DIRECT must be True (or sender is "yash")
- Builds CLI command (same logic as current api_direct)
- Runs subprocess with timeout
- Posts the original prompt as a message in chat: "{agent_name} /direct @{to}: {prompt}"
- Posts the response as a message: "**[Direct response from {to}]**\n\n{output}"
- Returns the output to the calling agent
- Note: This is synchronous from the tool's perspective but uses asyncio subprocess internally. Since MCP tools in FastMCP can be sync or async, we'll make this async.
Wait - actually there's a problem. MCP tool handlers in FastMCP are synchronous by default when using @mcp.tool(). Let me check if async tools are supported...
Actually, looking at the codebase, the current tools are all sync functions called from sync @mcp.tool() decorated functions in server.py. For the direct_message tool, we need subprocess execution which is async. Two options:
- Make the tool handler async (FastMCP supports this)
- Use subprocess.run() (sync, blocks the event loop - bad for a server)
We'll use asyncio.run() or asyncio.get_event_loop().run_until_complete() inside the sync tool, OR make the server-level tool handler async. Looking at FastMCP, async tool handlers are supported. So we'll define direct_message as async in server.py and keep the subprocess logic there (not in tools.py).
Actually, cleaner approach: Keep the command-building logic in tools.py (returns the command list + cwd), and the actual subprocess execution in server.py (which is async-friendly). This separates concerns.

5. EDIT: talkto/server.py
Updated register MCP tool:
@mcp.tool()
def register(name, project, bio, personality, gender, cli_type=None, working_dir=None):

- Pass cli_type and working_dir through to tool_register()
New direct_message MCP tool:
@mcp.tool()
async def direct_message(agent_name: str, to: str, prompt: str) -> str:
- Checks config toggle
- Calls tools module to build command
- Runs async subprocess
- Posts messages to chat
- Returns response
Config toggle:
- TALKTO_ALLOW_AGENT_DIRECT env var (default: "false")
- Also: GET /api/config and PATCH /api/config REST endpoints so the web UI can read/toggle it
- Store in a simple JSON config file or just keep in memory (resets on restart unless saved to a small config in data/)
Actually, simplest: store in DB. Add a config table with key-value pairs. Or even simpler: just use a global variable in server.py + env var, and add a POST /api/config/agent-direct toggle endpoint that flips it. It doesn't need to persist across restarts - env var handles that. The UI toggle is just a convenience for the current session.
Updated api_direct REST endpoint:
- Add working_dir as the subprocess cwd
- Update command building:
  - Claude: claude -p -r {session_id} "{prompt}" if session_id, else claude -p --continue "{prompt}" with cwd=working_dir
  - OpenCode: opencode run -s {session_id} "{prompt}" if session_id, else opencode run --continue "{prompt}" with cwd=working_dir
  - Codex: codex resume {session_id} "{prompt}" if session_id, else codex exec "{prompt}" with cwd=working_dir
- Fallback chain: session_id first, then --continue with working_dir, then fail
Updated api_update_agent PATCH endpoint:
- Also accept working_dir in the body
- Can trigger a rescan: if working_dir changes and cli_type is set, call scanner
New GET /api/config endpoint:
- Returns { "allow_agent_direct": true/false }
New PATCH /api/config endpoint:
- Accepts { "allow_agent_direct": true/false }
- Updates the in-memory toggle
Updated api_agents endpoint:
- Also return working_dir

6. EDIT: talkto/static/chat.html
Header area: Add a settings/toggle somewhere for "Allow Agent Direct Messaging" - a small toggle switch, maybe in a dropdown or settings popover. When toggled, calls PATCH /api/config.
Sidebar agent cards:

- Show working_dir in agent tooltip or small text below bio
- Keep existing Config and Direct buttons
- Direct button: now shows for any agent with cli_type set (already the case)
- Config modal: Add working_dir field (read-only, shows what the agent reported), plus a "Rescan Session" button that calls PATCH /api/agents/{name} with the current values to trigger a rescan
Direct modal:
- Already functional from prior implementation
- No major changes needed, the backend handles the improved command building
Agent card display: Show a small working_dir breadcrumb or just the last folder name, e.g. transcript_master_back

7. EDIT: README.md

- Update register tool docs to mention cli_type and working_dir params
- Add direct_message tool to the tools table
- Add note about TALKTO_ALLOW_AGENT_DIRECT env var
- Add section on "Direct Messaging" explaining the feature
- Update architecture section to mention scanner.py

8. EDIT: Onboarding instructions in tools.py

- Update ONBOARDING_INSTRUCTIONS to tell agents to pass cli_type and working_dir when registering
- Add a note about direct_message tool availability

---
Edge cases and robustness

1. Multiple agents, same project, same CLI: Scanner picks the most recently updated session. When agent B registers and gets the same session_id as agent A, we clear agent A's session_id (most recent registration wins). This is correct because the active agent is the one that just registered.
2. Agent re-registers from different CLI: cli_type and working_dir update on re-registration. Scanner runs again and finds the new session.
3. Scanner finds nothing: session_id stays None. Direct invoke still works if working_dir is set (uses --continue mode). If neither is set, Direct button won't appear.
4. Session store doesn't exist (CLI not installed): Scanner silently skips that CLI's scan. No errors.
5. Stale sessions: Scanner ignores sessions older than 30 days.
6. Path normalization: Windows paths (B:\foo), forward slash paths (B:/foo), and casing differences all normalized before comparison.
7. Config toggle: Defaults to false (only Yash can direct). Agents will see an appropriate error message if they try direct_message when it's disabled.

---
Execution order

1. scanner.py (new file, no dependencies)
2. models.py (add working_dir field)
3. db.py (migration + update functions)
4. tools.py (update tool_register, add command builder for direct)
5. server.py (update register tool, add direct_message tool, update REST endpoints, add config toggle)
6. chat.html (UI updates: config toggle, working_dir display, config modal updates)
7. README.md (documentation updates)
8. Test: uv run python -c "from talkto.server import app" + DB function tests

---
That's the complete plan. Questions before I proceed:

1. The agent-direct config toggle - do you want it to persist across server restarts (save to DB/file) or is env var + in-memory UI toggle enough?
2. For the onboarding instructions, should I explicitly tell agents "pass your working directory as os.getcwd()" or keep it more natural like "pass the directory you're working in"?
3. The "Rescan Session" button in the Config modal - worth it, or overkill given re-registration already rescans?
