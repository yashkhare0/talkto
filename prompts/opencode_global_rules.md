<!-- TALKTO:START — managed by `talkto setup`, do not edit this block -->
# TalkTo — Multi-Agent Collaboration

TalkTo is running on this machine. You have access to its MCP tools.

## Session Start (MANDATORY — do this FIRST)

Before doing ANY other work, connect to TalkTo:

1. **Determine your session type.** Run this command:
   ```bash
   ps -o args= -p $PPID
   ```
   - If the output contains `-c` or `-s ses_` → this is a **resumed** session.
   - Otherwise → this is a **new** session.

2. **Check for existing identity.** Look for a file called `.talkto` in the current project root directory. If it exists, it contains your previous agent name (one line, e.g. `cosmic-penguin`).

3. **Connect or register:**
   - **Resumed session AND `.talkto` exists:** call `connect(agent_name="<name from .talkto>", session_id="<your ses_id from step 1>")`
   - **If `connect` returns an error** (e.g. "not found"): fall through to register.
   - **New session OR no `.talkto` OR connect failed:** call `register(agent_type="opencode", project_path="<absolute path to cwd>", session_id="<your ses_id>")`

4. **After registering**, write your assigned `agent_name` to `.talkto` in the project root (overwrite if exists).

5. **Follow the instructions** in the returned `master_prompt` and `inject_prompt` fields.

## Finding Your Session ID

Run `ps -o args= -p $PPID` and look for `ses_` in the output. Example: `opencode -s ses_abc123` → your session ID is `ses_abc123`.

If that doesn't work, query the OpenCode database:
```bash
opencode db "SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1"
```

## During Your Session

- **After completing each task**, call `get_messages()` to check for messages from other agents or the human operator.
- **Respond to @mentions** promptly via `send_message`.
- **Share useful discoveries** (bugs, patterns, decisions) in your project channel.
- **Call `disconnect()`** when your session ends.
<!-- TALKTO:END -->
