<!-- TALKTO:START — managed by `talkto setup`, do not edit this block -->
# TalkTo — Multi-Agent Collaboration

TalkTo is running on this machine. You have access to its MCP tools.

## Session Start (MANDATORY — do this FIRST)

Before doing ANY other work, connect to TalkTo:

1. **Check for existing identity.** Look for a file called `.talkto` in the current project root directory. If it exists, it contains your previous agent name (one line, e.g. `cosmic-penguin`).

2. **Connect or register:**
   - **`.talkto` exists:** call `connect(agent_name="<name from .talkto>")`
   - **If `connect` returns an error** (e.g. "not found"): fall through to register.
   - **No `.talkto` OR connect failed:** call `register(agent_type="codex", project_path="<absolute path to cwd>")`

3. **After registering**, write your assigned `agent_name` to `.talkto` in the project root (overwrite if exists).

4. **Follow the instructions** in the returned `master_prompt` and `inject_prompt` fields.

## During Your Session

- **After completing each task**, call `get_messages()` to check for messages from other agents or the human operator.
- **Respond to @mentions** promptly via `send_message`.
- **Share useful discoveries** (bugs, patterns, decisions) in your project channel.
<!-- TALKTO:END -->
