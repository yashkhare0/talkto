"""Session discovery - scans CLI session stores to auto-discover session IDs.

Supports Claude Code, OpenCode, and Codex.
Each CLI stores session data on disk in a known location. This module reads
those files and matches sessions by working directory to find the most
recently active session for a given agent.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from .log import logger

# How old a session can be and still be considered valid (days)
SESSION_MAX_AGE_DAYS = 30


def _normalize_path(p: str) -> str:
    """Normalize a path for comparison: resolve, lowercase on Windows, forward slashes."""
    try:
        return str(Path(p).resolve()).lower().replace("\\", "/")
    except (OSError, ValueError):
        return p.lower().replace("\\", "/")


def _home() -> Path:
    """Get user home directory."""
    return Path(os.path.expanduser("~"))


# ── Claude Code ──────────────────────────────────────────────────────────────


def _encode_path_to_dirname(p: str) -> str:
    """Encode a filesystem path to a Claude projects directory name.

    Claude encodes project paths as directory names by replacing : \\ / with -.
    e.g. B:\\projects\\sides\\noll-mcp -> B--projects-sides-noll-mcp

    Note: This is ambiguous with hyphens in folder names, so we always ENCODE
    the working_dir and match against directory names, never decode.
    """
    return str(Path(p).resolve()).replace(":", "-").replace("\\", "-").replace("/", "-")


def _scan_claude_sessions(working_dir: str) -> Optional[tuple[str, datetime]]:
    """Scan Claude Code session stores for a matching working directory.

    Returns (session_id, modified_dt) or None.

    Claude stores sessions in:
      ~/.claude/projects/<encoded-path>/sessions-index.json

    Each sessions-index.json has:
      { "entries": [{ "sessionId": "...", "projectPath": "...", "modified": "ISO" }] }

    FALLBACK: Many active sessions don't have a sessions-index.json (it's only
    written when sessions close cleanly). For those, we find the matching project
    directory by encoding the working_dir, then scan .jsonl files directly.
    The filename (sans .jsonl) IS the session ID; we pick the most recently
    modified file.
    """
    projects_dir = _home() / ".claude" / "projects"
    if not projects_dir.is_dir():
        logger.debug("Claude projects dir not found: {}", projects_dir)
        return None

    wd = _normalize_path(working_dir)
    cutoff = datetime.now(timezone.utc) - timedelta(days=SESSION_MAX_AGE_DAYS)
    best: Optional[tuple[str, datetime]] = None

    logger.debug("Scanning Claude sessions for working_dir={}", working_dir)

    # --- Strategy 1: sessions-index.json (closed/indexed sessions) ---
    try:
        for index_file in projects_dir.glob("*/sessions-index.json"):
            try:
                data = json.loads(index_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            for entry in data.get("entries", []):
                project_path = entry.get("projectPath", "")
                if not project_path:
                    continue

                if _normalize_path(project_path) != wd:
                    continue

                modified_str = entry.get("modified")
                if not modified_str:
                    continue

                try:
                    modified_dt = datetime.fromisoformat(modified_str.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    continue

                if modified_dt < cutoff:
                    continue

                session_id = entry.get("sessionId")
                if not session_id:
                    continue

                if best is None or modified_dt > best[1]:
                    best = (session_id, modified_dt)
                    logger.debug("Strategy 1 (index) candidate: session={} modified={}", session_id, modified_dt)
    except OSError:
        pass

    # --- Strategy 2: Direct .jsonl scan (active/unindexed sessions) ---
    # Encode working_dir to find the matching project directory
    try:
        expected_dirname = _encode_path_to_dirname(working_dir)
        project_dir = projects_dir / expected_dirname

        if project_dir.is_dir():
            jsonl_count = 0
            for jsonl_file in project_dir.glob("*.jsonl"):
                jsonl_count += 1
                try:
                    mtime = jsonl_file.stat().st_mtime
                    modified_dt = datetime.fromtimestamp(mtime, tz=timezone.utc)
                except OSError:
                    continue

                if modified_dt < cutoff:
                    continue

                # The filename without extension is the session ID
                session_id = jsonl_file.stem
                if not session_id:
                    continue

                if best is None or modified_dt > best[1]:
                    best = (session_id, modified_dt)
                    logger.debug("Strategy 2 (jsonl) candidate: session={} modified={}", session_id, modified_dt)

            logger.debug("Strategy 2: scanned {} .jsonl files in {}", jsonl_count, project_dir.name)
        else:
            logger.debug("Strategy 2: project dir not found: {}", expected_dirname)
    except OSError:
        pass

    if best:
        logger.info("Claude session found: session={} modified={} for dir={}", best[0][:12] + "...", best[1], working_dir)
    else:
        logger.debug("No Claude session found for dir={}", working_dir)

    return best


# ── OpenCode ─────────────────────────────────────────────────────────────────

def _scan_opencode_sessions(working_dir: str) -> Optional[tuple[str, datetime]]:
    """Scan OpenCode session stores for a matching working directory.

    Returns (session_id, modified_dt) or None.

    OpenCode stores data in:
      ~/.local/share/opencode/storage/project/<hash>.json  (worktree mapping)
      ~/.local/share/opencode/storage/session/<hash>/*.json  (session files)

    Project JSON: { "id": "hash", "worktree": "B:\\\\path" }
    Session JSON: { "id": "ses_xxx", "time": { "updated": epoch_ms } }
    """
    logger.debug("Scanning OpenCode sessions for working_dir={}", working_dir)
    storage_dir = _home() / ".local" / "share" / "opencode" / "storage"
    if not storage_dir.is_dir():
        logger.debug("OpenCode storage dir not found: {}", storage_dir)
        return None

    wd = _normalize_path(working_dir)
    cutoff = datetime.now(timezone.utc) - timedelta(days=SESSION_MAX_AGE_DAYS)
    best: Optional[tuple[str, datetime]] = None

    # Step 1: Find the project ID that matches this working directory
    project_dir = storage_dir / "project"
    if not project_dir.is_dir():
        return None

    matching_project_id: Optional[str] = None
    try:
        for pf in project_dir.glob("*.json"):
            try:
                pdata = json.loads(pf.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            worktree = pdata.get("worktree", "")
            if worktree and _normalize_path(worktree) == wd:
                matching_project_id = pdata.get("id")
                break
    except OSError:
        pass

    if not matching_project_id:
        logger.debug("OpenCode: no project match for dir={}", working_dir)
        return None

    logger.debug("OpenCode: matched project_id={} for dir={}", matching_project_id, working_dir)

    # Step 2: Find the most recent session for this project
    session_dir = storage_dir / "session" / matching_project_id
    if not session_dir.is_dir():
        logger.debug("OpenCode: session dir not found: {}", session_dir)
        return None

    try:
        for sf in session_dir.glob("*.json"):
            try:
                sdata = json.loads(sf.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue

            session_id = sdata.get("id")
            if not session_id:
                continue

            updated_ms = sdata.get("time", {}).get("updated")
            if not updated_ms:
                continue

            try:
                updated_dt = datetime.fromtimestamp(updated_ms / 1000, tz=timezone.utc)
            except (ValueError, TypeError, OSError):
                continue

            if updated_dt < cutoff:
                continue

            if best is None or updated_dt > best[1]:
                best = (session_id, updated_dt)
                logger.debug("OpenCode session candidate: session={} updated={}", session_id, updated_dt)
    except OSError:
        pass

    if best:
        logger.info("OpenCode session found: session={} for dir={}", best[0], working_dir)
    else:
        logger.debug("No OpenCode session found for dir={}", working_dir)

    return best


# ── Codex ────────────────────────────────────────────────────────────────────

def _scan_codex_sessions(working_dir: str) -> Optional[tuple[str, datetime]]:
    """Scan Codex session stores for a matching working directory.

    Returns (session_id, modified_dt) or None.

    Codex stores sessions in:
      ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

    First line of each JSONL is session_meta:
      { "type": "session_meta", "payload": { "id": "uuid", "cwd": "path", "timestamp": "ISO" } }
    """
    logger.debug("Scanning Codex sessions for working_dir={}", working_dir)
    sessions_dir = _home() / ".codex" / "sessions"
    if not sessions_dir.is_dir():
        logger.debug("Codex sessions dir not found: {}", sessions_dir)
        return None

    wd = _normalize_path(working_dir)
    cutoff = datetime.now(timezone.utc) - timedelta(days=SESSION_MAX_AGE_DAYS)
    best: Optional[tuple[str, datetime]] = None

    # Only scan recent date folders to limit scope
    cutoff_date = (datetime.now(timezone.utc) - timedelta(days=SESSION_MAX_AGE_DAYS)).date()

    try:
        for year_dir in sessions_dir.iterdir():
            if not year_dir.is_dir():
                continue
            try:
                year = int(year_dir.name)
            except ValueError:
                continue

            for month_dir in year_dir.iterdir():
                if not month_dir.is_dir():
                    continue
                try:
                    month = int(month_dir.name)
                except ValueError:
                    continue

                for day_dir in month_dir.iterdir():
                    if not day_dir.is_dir():
                        continue
                    try:
                        day = int(day_dir.name)
                        from datetime import date
                        if date(year, month, day) < cutoff_date:
                            continue
                    except (ValueError, TypeError):
                        continue

                    for jsonl_file in day_dir.glob("*.jsonl"):
                        try:
                            with open(jsonl_file, encoding="utf-8") as f:
                                first_line = f.readline().strip()
                            if not first_line:
                                continue

                            data = json.loads(first_line)
                            if data.get("type") != "session_meta":
                                continue

                            payload = data.get("payload", {})
                            cwd = payload.get("cwd", "")
                            if not cwd or _normalize_path(cwd) != wd:
                                continue

                            session_id = payload.get("id")
                            if not session_id:
                                continue

                            ts_str = payload.get("timestamp")
                            if not ts_str:
                                continue

                            try:
                                ts_dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                            except (ValueError, TypeError):
                                continue

                            if ts_dt < cutoff:
                                continue

                            if best is None or ts_dt > best[1]:
                                best = (session_id, ts_dt)
                                logger.debug("Codex session candidate: session={} ts={}", session_id, ts_dt)

                        except (json.JSONDecodeError, OSError):
                            continue
    except OSError:
        pass

    if best:
        logger.info("Codex session found: session={} for dir={}", best[0], working_dir)
    else:
        logger.debug("No Codex session found for dir={}", working_dir)

    return best


# ── Public API ───────────────────────────────────────────────────────────────

_SCANNERS = {
    "claude": _scan_claude_sessions,
    "opencode": _scan_opencode_sessions,
    "codex": _scan_codex_sessions,
}


def discover_session(cli_type: str, working_dir: str) -> Optional[str]:
    """Discover the most recent session ID for a given CLI type and working directory.

    Returns the session ID string, or None if no matching session was found.
    Never raises - all errors are caught and result in None.
    """
    logger.debug("discover_session called: cli_type={} working_dir={}", cli_type, working_dir)
    scanner = _SCANNERS.get(cli_type)
    if not scanner:
        logger.warning("No scanner for cli_type={}", cli_type)
        return None

    try:
        result = scanner(working_dir)
        if result:
            logger.info("Session discovered: cli={} session={}", cli_type, result[0][:12] + "...")
            return result[0]  # session_id
    except Exception as e:
        # Never let scanner failures break registration
        logger.error("Scanner failed for cli={}: {}", cli_type, e)

    logger.debug("No session discovered for cli={} dir={}", cli_type, working_dir)
    return None


# Known fallback paths for CLI executables on Windows.
# subprocess.run may not inherit the user's full PATH (e.g. npm global bin).
_CLI_FALLBACK_PATHS: dict[str, list[str]] = {
    "claude": [],  # Usually on PATH via npm global or standalone installer
    "opencode": [
        str(_home() / ".bun" / "bin" / "opencode.exe"),
        str(_home() / ".bun" / "bin" / "opencode"),
    ],
    "codex": [
        str(_home() / "AppData" / "Roaming" / "npm" / "codex.cmd"),
        str(_home() / "AppData" / "Roaming" / "npm" / "codex"),
        str(_home() / ".npm-global" / "bin" / "codex"),
    ],
}


def _resolve_cli(cli_type: str) -> str:
    """Resolve a CLI type to its full executable path.

    Tries shutil.which first (uses system PATH), then falls back to
    known installation paths for Windows. Returns the bare name if
    nothing is found (will fail at subprocess.run with FileNotFoundError).
    """
    # Try system PATH first
    found = shutil.which(cli_type)
    if found:
        logger.debug("CLI '{}' resolved via PATH: {}", cli_type, found)
        return found

    # Try known fallback paths
    for fallback in _CLI_FALLBACK_PATHS.get(cli_type, []):
        if Path(fallback).is_file():
            logger.info("CLI '{}' resolved via fallback: {}", cli_type, fallback)
            return fallback

    # Return bare name - will fail at subprocess.run with FileNotFoundError
    logger.warning("CLI '{}' not found on PATH or fallbacks, using bare name", cli_type)
    return cli_type


def build_direct_command(
    cli_type: str,
    prompt: str,
    session_id: Optional[str] = None,
    working_dir: Optional[str] = None,
) -> tuple[list[str], Optional[str], Optional[dict[str, str]]]:
    """Build the CLI command to directly invoke an agent.

    Returns (command_list, cwd, env_overrides).
    Uses session_id if available, otherwise falls back to --continue with working_dir as cwd.
    env_overrides is a dict of extra environment variables for the subprocess (or None).

    Command patterns:
      Claude:   claude -p -r SESSION "prompt"  |  claude -p --continue "prompt" (cwd)
      OpenCode: opencode run --session ID "prompt"  |  opencode run --continue "prompt" (cwd)
      Codex:    codex exec resume --full-auto SESSION "prompt"  |  codex exec --full-auto -C DIR "prompt"

    MCP deadlock prevention:
      When TalkTo spawns a CLI subprocess, that subprocess may try to connect back to
      TalkTo as an MCP client during initialization, creating a deadlock. To prevent this:
      - OpenCode: OPENCODE_CONFIG_CONTENT env var disables the talkto MCP server
      - Codex: -c flag disables the talkto MCP server
      - Claude: -p (print mode) skips MCP initialization entirely
    """
    # Validate cwd exists on disk; fall back to None if it doesn't
    # (prevents WinError 267 / "The directory name is invalid")
    cwd: Optional[str] = None
    if working_dir:
        try:
            if Path(working_dir).is_dir():
                cwd = working_dir
        except OSError:
            pass

    # Resolve CLI executable to full path. subprocess.run with bare names can fail
    # if the server process's PATH doesn't include npm/bun bin directories.
    exe = _resolve_cli(cli_type)

    # Environment overrides for the subprocess (used to prevent MCP deadlocks)
    env_overrides: Optional[dict[str, str]] = None

    if cli_type == "claude":
        # claude -p: non-interactive print mode (skips MCP init, no deadlock risk)
        # -r SESSION: resume specific session
        # --continue: continue most recent session in cwd
        cmd = [exe, "-p"]
        if session_id:
            cmd.extend(["-r", session_id])
        elif cwd:
            cmd.append("--continue")
        cmd.append(prompt)

    elif cli_type == "opencode":
        # opencode run: non-interactive mode
        # --session ID: resume specific session
        # --continue: continue most recent session in cwd
        #
        # MCP deadlock prevention: OpenCode initializes all configured MCP servers
        # on startup, including TalkTo. When spawned FROM TalkTo's server process,
        # this creates a deadlock (subprocess connects back to parent server).
        # OPENCODE_CONFIG_CONTENT has highest config precedence and disables talkto.
        cmd = [exe, "run"]
        if session_id:
            cmd.extend(["--session", session_id])
        elif cwd:
            cmd.append("--continue")
        cmd.append(prompt)

        env_overrides = {
            "OPENCODE_CONFIG_CONTENT": json.dumps({
                "mcp": {"talkto": {"enabled": False}}
            }),
        }
        logger.debug("OpenCode env override: OPENCODE_CONFIG_CONTENT set to disable talkto MCP")

    elif cli_type == "codex":
        # codex exec: non-interactive mode (NOT codex resume which opens TUI)
        # exec resume SESSION_ID PROMPT: resume specific session
        # exec -C DIR PROMPT: run in specific directory
        # --full-auto: avoid hanging on approval prompts
        #
        # MCP deadlock prevention: Codex also initializes MCP servers on startup.
        # The -c flag overrides config values at runtime to disable the talkto server.
        mcp_disable = ["-c", "mcp_servers.talkto.enabled=false"]

        if session_id:
            cmd = [exe, "exec", "resume", "--full-auto"] + mcp_disable + [session_id, prompt]
        elif cwd:
            cmd = [exe, "exec", "--full-auto"] + mcp_disable + ["-C", cwd, prompt]
        else:
            cmd = [exe, "exec", "--full-auto"] + mcp_disable + [prompt]

    else:
        raise ValueError(f"Unsupported cli_type: {cli_type}")

    logger.info("Built direct command: cli={} session={} cwd={} cmd_len={} env_overrides={}",
                cli_type, session_id and (session_id[:12] + "..."), cwd, len(cmd), bool(env_overrides))
    logger.debug("Full command: {}", cmd)
    return cmd, cwd, env_overrides
