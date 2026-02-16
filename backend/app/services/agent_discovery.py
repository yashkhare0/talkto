"""Auto-discovery of OpenCode server URL and session ID.

Discovery strategies (in priority order):
1. PID-based: Walk the process tree from the agent's PID to find opencode -s <id>
2. TTY-based: Find the opencode process on the agent's TTY
3. Process-scan: Scan ALL running opencode TUI processes, read their session IDs,
   look up project directories from the OpenCode SQLite DB, match by project path,
   and exclude sessions already claimed by other TalkTo agents
4. REST API fallback: Query GET /session on the opencode serve endpoint
"""

import asyncio
import logging
import re
import sqlite3
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# OpenCode stores its DB here
_OPENCODE_DB_PATH = Path.home() / ".local" / "share" / "opencode" / "opencode.db"


async def discover_opencode_server() -> str | None:
    """Find a running opencode serve process and return its URL.

    Scans `lsof -i -P -n` output for lines matching opencode LISTEN
    on 127.0.0.1 and extracts the port.

    Returns:
        URL like "http://127.0.0.1:19877" or None if not found.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "lsof",
            "-i",
            "-P",
            "-n",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
    except (FileNotFoundError, TimeoutError):
        logger.debug("lsof not available or timed out")
        return None

    # Match lines like: opencode  20636  user  10u  IPv4  ...  TCP 127.0.0.1:19877 (LISTEN)
    pattern = re.compile(r"opencode.*TCP\s+127\.0\.0\.1:(\d+)\s+\(LISTEN\)")
    for line in stdout.decode(errors="replace").splitlines():
        match = pattern.search(line)
        if match:
            port = match.group(1)
            url = f"http://127.0.0.1:{port}"
            logger.info("Discovered OpenCode server at %s", url)
            return url

    logger.debug("No running opencode serve process found")
    return None


async def discover_session_by_pid(pid: int) -> str | None:
    """Discover OpenCode session ID by walking the process tree from a PID.

    Starting from the given PID, walks up the parent process chain looking
    for an `opencode` process with a `-s <session_id>` flag.

    Args:
        pid: Process ID of the agent (or any descendant of the opencode TUI).

    Returns:
        Session ID string or None if not found.
    """
    session_flag_pattern = re.compile(r"-s\s+(ses_\S+)")
    visited: set[int] = set()
    current_pid = pid

    for _ in range(20):
        if current_pid <= 1 or current_pid in visited:
            break
        visited.add(current_pid)

        try:
            proc = await asyncio.create_subprocess_exec(
                "ps",
                "-p",
                str(current_pid),
                "-o",
                "ppid=,args=",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3)
        except (FileNotFoundError, TimeoutError):
            break

        line = stdout.decode(errors="replace").strip()
        if not line:
            break

        parts = line.split(None, 1)
        if len(parts) < 2:
            try:
                current_pid = int(parts[0])
            except ValueError:
                break
            continue

        ppid_str, cmd = parts

        if "opencode" in cmd:
            match = session_flag_pattern.search(cmd)
            if match:
                session_id = match.group(1)
                logger.info(
                    "Discovered session %s from PID %d (found at PID %d)",
                    session_id,
                    pid,
                    current_pid,
                )
                return session_id

        try:
            current_pid = int(ppid_str)
        except ValueError:
            break

    logger.debug("No OpenCode session found in process tree for PID %d", pid)
    return None


async def discover_session_by_tty(tty: str) -> str | None:
    """Discover OpenCode session ID by finding the opencode process on a TTY.

    Args:
        tty: TTY device path (e.g., "/dev/ttys003")

    Returns:
        Session ID string or None if not found.
    """
    if not tty or tty == "unknown":
        return None

    tty_short = tty.replace("/dev/", "")

    try:
        proc = await asyncio.create_subprocess_exec(
            "ps",
            "-t",
            tty_short,
            "-o",
            "args=",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3)
    except (FileNotFoundError, TimeoutError):
        logger.debug("ps command failed for TTY %s", tty)
        return None

    session_flag_pattern = re.compile(r"-s\s+(ses_\S+)")

    for line in stdout.decode(errors="replace").splitlines():
        line = line.strip()
        if "opencode" in line and "serve" not in line:
            match = session_flag_pattern.search(line)
            if match:
                session_id = match.group(1)
                logger.info("Discovered session %s from TTY %s", session_id, tty)
                return session_id

    logger.debug("No OpenCode session found on TTY %s", tty)
    return None


async def _get_active_opencode_sessions() -> list[str]:
    """Scan all running opencode TUI processes and extract their session IDs.

    Returns a list of session IDs from `opencode -s <session_id>` command lines.
    For processes without -s flag, queries the OpenCode DB to find their
    most recently updated root session in the same directory.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "ps",
            "aux",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
    except (FileNotFoundError, TimeoutError):
        return []

    session_flag_pattern = re.compile(r"-s\s+(ses_\S+)")
    session_ids: list[str] = []

    for line in stdout.decode(errors="replace").splitlines():
        # Match opencode TUI processes (not serve, not run/pyright)
        if "opencode" not in line:
            continue
        if "serve" in line or "opencode run" in line:
            continue
        # Only match the actual TUI process
        match = session_flag_pattern.search(line)
        if match:
            session_ids.append(match.group(1))

    return session_ids


def _lookup_session_directory(session_id: str) -> str | None:
    """Look up a session's directory from the OpenCode SQLite DB."""
    if not _OPENCODE_DB_PATH.exists():
        return None
    try:
        conn = sqlite3.connect(str(_OPENCODE_DB_PATH), timeout=2)
        cursor = conn.execute("SELECT directory FROM session WHERE id = ?", (session_id,))
        row = cursor.fetchone()
        conn.close()
        return row[0] if row else None
    except sqlite3.Error:
        logger.debug("Failed to query OpenCode DB for session %s", session_id, exc_info=True)
        return None


async def discover_session_by_process_scan(
    project_path: str,
    exclude_session_ids: set[str] | None = None,
) -> str | None:
    """Discover an OpenCode session by scanning all running opencode processes.

    Scans `ps aux` for opencode TUI processes, extracts their session IDs,
    looks up their project directories from the OpenCode SQLite DB, and
    returns one that matches the given project path (excluding already-claimed
    sessions).

    This is the most reliable discovery method when PID/TTY-based strategies
    fail (e.g., when MCP runs server-side and the captured PID belongs to
    the TalkTo backend, not the agent's terminal).

    Args:
        project_path: Absolute path to the project directory
        exclude_session_ids: Session IDs already claimed by other agents

    Returns:
        Session ID string or None if not found.
    """
    active_sessions = await _get_active_opencode_sessions()
    if not active_sessions:
        logger.debug("No active OpenCode TUI processes found")
        return None

    norm_path = project_path.rstrip("/")
    exclude = exclude_session_ids or set()

    for session_id in active_sessions:
        if session_id in exclude:
            continue

        directory = _lookup_session_directory(session_id)
        if not directory:
            continue

        directory = directory.rstrip("/")

        # Match: exact, parent, or child path
        if (
            directory == norm_path
            or directory.startswith(norm_path + "/")
            or norm_path.startswith(directory + "/")
        ):
            logger.info(
                "Process-scan matched session %s (dir=%s) for project %s",
                session_id,
                directory,
                project_path,
            )
            return session_id

    logger.debug("Process-scan found no matching session for %s", project_path)
    return None


async def discover_opencode_session(
    server_url: str,
    project_path: str,
    exclude_session_ids: set[str] | None = None,
) -> str | None:
    """Find the OpenCode session ID via REST API (fallback).

    Queries GET /session on the OpenCode server, filters for root sessions
    whose directory matches the project path.

    Args:
        server_url: Base URL of the OpenCode server
        project_path: Absolute path to the project directory
        exclude_session_ids: Session IDs already claimed by other agents

    Returns:
        Session ID string or None if not found.
    """
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{server_url}/session")
            resp.raise_for_status()
    except (httpx.HTTPError, httpx.TimeoutException) as exc:
        logger.debug("Failed to query OpenCode sessions: %s", exc)
        return None

    sessions = resp.json()

    if isinstance(sessions, dict):
        session_list = list(sessions.values())
    elif isinstance(sessions, list):
        session_list = sessions
    else:
        logger.debug("Unexpected sessions response type: %s", type(sessions))
        return None

    norm_path = project_path.rstrip("/")

    candidates = []
    for s in session_list:
        directory = (s.get("directory") or "").rstrip("/")
        parent_id = s.get("parentID")
        if parent_id:
            continue
        if (
            directory == norm_path
            or directory.startswith(norm_path + "/")
            or norm_path.startswith(directory + "/")
        ):
            candidates.append(s)

    if not candidates:
        logger.debug("No OpenCode session found for project path: %s", project_path)
        return None

    def _updated_time(s: dict) -> str:
        time_info = s.get("time", {})
        return time_info.get("updated", "") if isinstance(time_info, dict) else ""

    candidates.sort(key=_updated_time, reverse=True)

    if exclude_session_ids:
        candidates = [c for c in candidates if c.get("id") not in exclude_session_ids]
        if not candidates:
            logger.debug(
                "All matching sessions for %s are already claimed: %s",
                project_path,
                exclude_session_ids,
            )
            return None

    session_id = candidates[0].get("id")
    logger.info("Discovered OpenCode session %s for %s", session_id, project_path)
    return session_id


async def auto_discover(
    project_path: str,
    pid: int | None = None,
    tty: str | None = None,
    exclude_session_ids: set[str] | None = None,
) -> dict | None:
    """Discover OpenCode server URL and session ID for an agent.

    Uses a prioritized discovery strategy:
    1. PID-based: Walk process tree to find opencode -s <session_id>
    2. TTY-based: Find the opencode process on the agent's TTY
    3. Process-scan: Scan ALL running opencode processes, cross-reference
       with OpenCode's SQLite DB for project directories, exclude claimed sessions
    4. REST API fallback: Query the opencode serve endpoint

    Args:
        project_path: Absolute path to the project directory
        pid: Process ID of the agent (optional)
        tty: TTY device of the agent (optional)
        exclude_session_ids: Session IDs already claimed by other agents

    Returns:
        Dict with "server_url" and "session_id" keys, or None if discovery fails.
    """
    server_url = await discover_opencode_server()
    if not server_url:
        return None

    # Strategy 1: PID-based discovery (most precise)
    if pid:
        session_id = await discover_session_by_pid(pid)
        if session_id:
            return {"server_url": server_url, "session_id": session_id}

    # Strategy 2: TTY-based discovery
    if tty:
        session_id = await discover_session_by_tty(tty)
        if session_id:
            return {"server_url": server_url, "session_id": session_id}

    # Strategy 3: Process-scan (scan all running opencode processes + DB lookup)
    session_id = await discover_session_by_process_scan(
        project_path,
        exclude_session_ids=exclude_session_ids,
    )
    if session_id:
        return {"server_url": server_url, "session_id": session_id}

    # Strategy 4: REST API fallback (only sees one serve process's sessions)
    session_id = await discover_opencode_session(
        server_url,
        project_path,
        exclude_session_ids=exclude_session_ids,
    )
    if not session_id:
        return {"server_url": server_url, "session_id": None}

    return {"server_url": server_url, "session_id": session_id}
