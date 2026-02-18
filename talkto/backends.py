"""Agent backends - persistent process management for CLI agents.

TalkTo can communicate with agent CLIs through different backends:

- SubprocessBackend: One-shot subprocess per message (Claude, Codex).
  Spawns `claude -p` or `codex exec` for each prompt, waits for completion.
  Simple but slow (cold boot per message).

- OpenCodeServerBackend: Persistent HTTP API via `opencode serve`.
  Spawns `opencode serve` once, sends prompts via REST API.
  No cold boot, no MCP deadlock, instant message delivery.

BackendManager routes messages to the appropriate backend based on agent config,
handles lifecycle (auto-start, health checks, fallback), and provides status info.

Created by Claude. Yash is the Head of the Table.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

import httpx

from . import db
from .log import logger
from .scanner import build_direct_command, _resolve_cli

# ── Helpers ───────────────────────────────────────────────────────────────────


def _is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """Check if a TCP port is already in use."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        try:
            s.connect((host, port))
            return True
        except (ConnectionRefusedError, OSError):
            return False


# ── Result type ──────────────────────────────────────────────────────────────


@dataclass
class BackendResult:
    """Unified result from any backend invocation."""

    ok: bool
    output: str
    error: str
    session_id: Optional[str] = None
    duration_ms: int = 0
    backend_type: str = "subprocess"
    timed_out: bool = False
    cli_not_found: bool = False


# ── Abstract backend ─────────────────────────────────────────────────────────


class AgentBackend(ABC):
    """Abstract interface for communicating with an agent CLI."""

    @abstractmethod
    async def send_prompt(
        self,
        prompt: str,
        session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        timeout: int = 180,
    ) -> BackendResult:
        """Send a prompt and wait for the complete response."""
        ...

    @abstractmethod
    async def is_available(self) -> bool:
        """Check if this backend is ready to accept prompts."""
        ...

    @abstractmethod
    async def start(self) -> None:
        """Start the backend (spawn process, connect, etc.)."""
        ...

    @abstractmethod
    async def stop(self) -> None:
        """Stop the backend (kill process, disconnect, etc.)."""
        ...

    @property
    @abstractmethod
    def status(self) -> str:
        """Return current status: 'running', 'stopped', 'starting', 'error'."""
        ...

    @property
    @abstractmethod
    def backend_type(self) -> str:
        """Return the backend type identifier."""
        ...


# ── Subprocess backend (Claude, Codex) ───────────────────────────────────────


class SubprocessBackend(AgentBackend):
    """One-shot subprocess per message. Current model for Claude and Codex.

    Spawns a fresh CLI process for each prompt using scanner.build_direct_command().
    Includes MCP deadlock prevention via env overrides and -c flags.
    """

    def __init__(self, cli_type: str):
        self._cli_type = cli_type

    async def send_prompt(
        self,
        prompt: str,
        session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        timeout: int = 180,
    ) -> BackendResult:
        t0 = time.monotonic()

        cmd, cwd, env_overrides = build_direct_command(
            cli_type=self._cli_type,
            prompt=prompt,
            session_id=session_id,
            working_dir=working_dir,
        )

        env = None
        if env_overrides:
            env = {**os.environ, **env_overrides}

        def _run():
            return subprocess.run(
                cmd,
                capture_output=True,
                cwd=cwd,
                timeout=timeout,
                env=env,
                stdin=subprocess.DEVNULL,
            )

        try:
            completed = await asyncio.to_thread(_run)
            elapsed = int((time.monotonic() - t0) * 1000)
            output = completed.stdout.decode("utf-8", errors="replace").strip()
            error = completed.stderr.decode("utf-8", errors="replace").strip()

            result = BackendResult(
                ok=completed.returncode == 0,
                output=output,
                error=error,
                session_id=session_id,
                duration_ms=elapsed,
                backend_type="subprocess",
            )
            logger.info(
                "Subprocess result: cli={} ok={} exit={} output_len={} error_len={} duration={}ms",
                self._cli_type, result.ok, completed.returncode,
                len(output), len(error), elapsed,
            )
            if error:
                logger.warning("Subprocess stderr: {}", error[:200])
            return result

        except subprocess.TimeoutExpired:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.error("Subprocess timed out after {}s for cli={}", timeout, self._cli_type)
            return BackendResult(
                ok=False, output="", error=f"Command timed out after {timeout}s",
                duration_ms=elapsed, backend_type="subprocess", timed_out=True,
            )
        except FileNotFoundError:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.error("CLI '{}' not found on PATH", self._cli_type)
            return BackendResult(
                ok=False, output="",
                error=f"CLI '{self._cli_type}' not found on system PATH. Is it installed?",
                duration_ms=elapsed, backend_type="subprocess", cli_not_found=True,
            )

    async def is_available(self) -> bool:
        return True  # Always available (spawns fresh process each time)

    async def start(self) -> None:
        pass  # No persistent process to start

    async def stop(self) -> None:
        pass  # No persistent process to stop

    @property
    def status(self) -> str:
        return "running"

    @property
    def backend_type(self) -> str:
        return "subprocess"


# ── OpenCode Server backend ──────────────────────────────────────────────────


class OpenCodeServerBackend(AgentBackend):
    """Persistent backend using `opencode serve` HTTP API.

    Spawns `opencode serve --port PORT` as a managed child process, then
    sends prompts via POST /session/:id/message. No subprocess per message,
    no MCP deadlock, instant delivery.

    The OpenCode serve API exposes:
      POST /session              - Create a new session
      POST /session/:id/message  - Send prompt and wait for response
      POST /session/:id/abort    - Abort a running session
      GET  /global/health        - Health check
      POST /instance/dispose     - Clean shutdown
    """

    def __init__(self, port: int = 4097, working_dir: Optional[str] = None):
        self._port = port
        self._working_dir = working_dir
        self._base_url = f"http://127.0.0.1:{port}"
        self._process: Optional[subprocess.Popen] = None
        self._client: Optional[httpx.AsyncClient] = None
        self._status = "stopped"

    async def start(self) -> None:
        """Spawn `opencode serve` and wait for it to be healthy."""
        if self._status == "running" and await self.is_available():
            logger.debug("OpenCode serve already running on port {}", self._port)
            return

        self._status = "starting"
        logger.info("Starting OpenCode serve on port {} (cwd={})", self._port, self._working_dir)

        # Check for port conflict before spawning
        if _is_port_in_use(self._port):
            # Port is taken — check if it's already an opencode serve we can reuse
            logger.warning("Port {} is already in use, checking if it's an existing OpenCode serve...", self._port)
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=httpx.Timeout(300.0, connect=10.0),
            )
            try:
                resp = await self._client.get("/global/health", timeout=5.0)
                if resp.status_code == 200 and resp.json().get("healthy"):
                    logger.info(
                        "Reusing existing OpenCode serve on port {} (version={})",
                        self._port, resp.json().get("version", "?"),
                    )
                    self._status = "running"
                    return
            except Exception:
                pass
            # Not a healthy OpenCode serve — can't start
            await self._client.aclose()
            self._client = None
            self._status = "error"
            raise RuntimeError(
                f"Port {self._port} is already in use by another process. "
                f"Set TALKTO_OPENCODE_PORT to a different port or kill the conflicting process."
            )

        try:
            exe = _resolve_cli("opencode")
        except FileNotFoundError:
            self._status = "error"
            logger.error("OpenCode CLI not found, cannot start serve backend")
            raise

        # Build env with TalkTo MCP disabled to prevent deadlock
        env = {
            **os.environ,
            "OPENCODE_CONFIG_CONTENT": json.dumps({
                "mcp": {"talkto": {"enabled": False}}
            }),
        }

        cmd = [exe, "serve", "--port", str(self._port), "--hostname", "127.0.0.1"]
        logger.info("Spawning: {}", cmd)

        # Spawn the process
        # Use subprocess.Popen (not asyncio) for Windows compatibility
        self._process = subprocess.Popen(
            cmd,
            env=env,
            cwd=self._working_dir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # Create httpx client
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(300.0, connect=10.0),
        )

        # Wait for health check to pass
        max_wait = 60  # seconds
        interval = 1.0
        elapsed = 0.0
        healthy = False

        while elapsed < max_wait:
            # Check if process died
            if self._process.poll() is not None:
                stderr = self._process.stderr.read().decode("utf-8", errors="replace") if self._process.stderr else ""
                self._status = "error"
                logger.error("OpenCode serve process died during startup (exit {}): {}", self._process.returncode, stderr[:500])
                raise RuntimeError(f"OpenCode serve died during startup: {stderr[:500]}")

            try:
                resp = await self._client.get("/global/health")
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("healthy"):
                        healthy = True
                        logger.info(
                            "OpenCode serve healthy on port {} (version={}, waited={:.1f}s)",
                            self._port, data.get("version", "?"), elapsed,
                        )
                        break
            except (httpx.ConnectError, httpx.ConnectTimeout):
                pass  # Server not ready yet

            await asyncio.sleep(interval)
            elapsed += interval

        if not healthy:
            self._status = "error"
            logger.error("OpenCode serve failed to become healthy within {}s", max_wait)
            await self.stop()
            raise RuntimeError(f"OpenCode serve did not become healthy within {max_wait}s")

        self._status = "running"

    async def send_prompt(
        self,
        prompt: str,
        session_id: Optional[str] = None,
        working_dir: Optional[str] = None,
        timeout: int = 180,
    ) -> BackendResult:
        if not self._client or self._status != "running":
            return BackendResult(
                ok=False, output="",
                error="OpenCode serve backend is not running",
                backend_type="opencode_server",
            )

        t0 = time.monotonic()

        try:
            # Create a session if we don't have one
            if not session_id:
                logger.info("Creating new OpenCode session...")
                resp = await self._client.post(
                    "/session",
                    json={"title": "TalkTo managed session"},
                    timeout=30.0,
                )
                resp.raise_for_status()
                session_data = resp.json()
                session_id = session_data.get("id")
                logger.info("Created OpenCode session: {}", session_id)

            # Send the prompt and wait for response
            logger.info(
                "Sending prompt to OpenCode session {} (timeout={}s, prompt_len={})",
                session_id, timeout, len(prompt),
            )
            resp = await self._client.post(
                f"/session/{session_id}/message",
                json={
                    "parts": [{"type": "text", "text": prompt}],
                },
                timeout=float(timeout),
            )

            # Handle stale session (404) — create a new one and retry once
            if resp.status_code == 404:
                logger.warning("Session {} not found (stale), creating new session...", session_id)
                new_session_id = await self.create_session(title="TalkTo managed session (recreated)")
                if new_session_id:
                    session_id = new_session_id
                    resp = await self._client.post(
                        f"/session/{session_id}/message",
                        json={"parts": [{"type": "text", "text": prompt}]},
                        timeout=float(timeout),
                    )
                else:
                    return BackendResult(
                        ok=False, output="",
                        error="Failed to create replacement session after 404",
                        session_id=session_id,
                        duration_ms=int((time.monotonic() - t0) * 1000),
                        backend_type="opencode_server",
                    )

            resp.raise_for_status()
            elapsed = int((time.monotonic() - t0) * 1000)

            # Parse response: extract text from parts
            data = resp.json()
            parts = data.get("parts", [])
            text_parts = []
            for part in parts:
                if isinstance(part, dict):
                    if part.get("type") == "text":
                        text_parts.append(part.get("text", ""))
                    elif part.get("type") == "tool-result":
                        # Tool results may contain useful output
                        content = part.get("content", "")
                        if content:
                            text_parts.append(str(content))

            output = "\n".join(text_parts).strip()

            logger.info(
                "OpenCode response: session={} output_len={} parts={} duration={}ms",
                session_id, len(output), len(parts), elapsed,
            )

            return BackendResult(
                ok=True,
                output=output,
                error="",
                session_id=session_id,
                duration_ms=elapsed,
                backend_type="opencode_server",
            )

        except httpx.TimeoutException:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.error("OpenCode prompt timed out after {}s for session {}", timeout, session_id)

            # Try to abort the session
            if session_id:
                try:
                    await self._client.post(
                        f"/session/{session_id}/abort",
                        timeout=10.0,
                    )
                    logger.info("Aborted OpenCode session {}", session_id)
                except Exception:
                    pass

            return BackendResult(
                ok=False, output="",
                error=f"OpenCode prompt timed out after {timeout}s",
                session_id=session_id,
                duration_ms=elapsed,
                backend_type="opencode_server",
                timed_out=True,
            )

        except httpx.HTTPStatusError as e:
            elapsed = int((time.monotonic() - t0) * 1000)
            error_text = e.response.text[:500] if e.response else str(e)
            logger.error("OpenCode HTTP error: {} - {}", e.response.status_code, error_text)
            return BackendResult(
                ok=False, output="",
                error=f"OpenCode API error ({e.response.status_code}): {error_text}",
                session_id=session_id,
                duration_ms=elapsed,
                backend_type="opencode_server",
            )

        except httpx.ConnectError:
            elapsed = int((time.monotonic() - t0) * 1000)
            logger.error("Cannot connect to OpenCode serve at {}", self._base_url)
            self._status = "error"
            return BackendResult(
                ok=False, output="",
                error=f"Cannot connect to OpenCode serve at {self._base_url}",
                session_id=session_id,
                duration_ms=elapsed,
                backend_type="opencode_server",
            )

    async def stop(self) -> None:
        """Gracefully stop the OpenCode serve process."""
        logger.info("Stopping OpenCode serve on port {}", self._port)

        # Try graceful dispose
        if self._client and self._status == "running":
            try:
                await self._client.post("/instance/dispose", timeout=5.0)
                logger.info("OpenCode serve disposed gracefully")
            except Exception:
                pass

        # Close httpx client
        if self._client:
            await self._client.aclose()
            self._client = None

        # Kill process
        if self._process and self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=3)
            logger.info("OpenCode serve process terminated")

        self._process = None
        self._status = "stopped"

    async def is_available(self) -> bool:
        """Check if OpenCode serve is healthy."""
        if not self._client:
            return False
        try:
            resp = await self._client.get("/global/health", timeout=5.0)
            return resp.status_code == 200 and resp.json().get("healthy", False)
        except Exception:
            return False

    @property
    def status(self) -> str:
        # Check if process died unexpectedly
        if self._status == "running" and self._process and self._process.poll() is not None:
            self._status = "error"
        return self._status

    @property
    def backend_type(self) -> str:
        return "opencode_server"

    @property
    def port(self) -> int:
        return self._port

    async def create_session(self, title: str = "TalkTo managed session") -> Optional[str]:
        """Create a new session and return its ID."""
        if not self._client or self._status != "running":
            return None
        try:
            resp = await self._client.post("/session", json={"title": title}, timeout=30.0)
            resp.raise_for_status()
            return resp.json().get("id")
        except Exception as e:
            logger.error("Failed to create OpenCode session: {}", e)
            return None

    async def list_sessions(self) -> list[dict]:
        """List all sessions on the OpenCode serve instance."""
        if not self._client or self._status != "running":
            return []
        try:
            resp = await self._client.get("/session", timeout=10.0)
            resp.raise_for_status()
            return resp.json()
        except Exception:
            return []


# ── Backend Manager ──────────────────────────────────────────────────────────


class BackendManager:
    """Routes messages to the appropriate backend per agent.

    - OpenCode agents: Uses the shared OpenCodeServerBackend (persistent HTTP API)
    - Claude/Codex agents: Uses SubprocessBackend (one-shot subprocess per message)

    Auto-starts OpenCode serve on first message to an OpenCode agent.
    Falls back to subprocess if the OpenCode backend fails.
    """

    # Watchdog interval: how often to check backend health (seconds)
    WATCHDOG_INTERVAL = 30

    def __init__(self):
        self._opencode_backend: Optional[OpenCodeServerBackend] = None
        self._opencode_port: int = int(os.environ.get("TALKTO_OPENCODE_PORT", "4097"))
        self._opencode_starting: bool = False  # Guard against concurrent starts
        self._watchdog_task: Optional[asyncio.Task] = None
        self._watchdog_running: bool = False
        self._last_health_check: Optional[float] = None
        self._restart_count: int = 0

    async def send_to_agent(
        self,
        agent: "db.Agent",  # Using string ref to avoid circular import
        prompt: str,
        timeout: int = 180,
    ) -> BackendResult:
        """Send a prompt to an agent via its appropriate backend.

        For OpenCode agents: tries the persistent server backend first,
        falls back to subprocess if it fails.
        For Claude/Codex: uses subprocess directly.
        """
        if agent.cli_type == "opencode":
            return await self._send_via_opencode(agent, prompt, timeout)
        else:
            return await self._send_via_subprocess(agent, prompt, timeout)

    async def _send_via_opencode(
        self,
        agent,
        prompt: str,
        timeout: int,
    ) -> BackendResult:
        """Try OpenCode serve backend, fall back to subprocess on failure."""
        # Auto-start if needed
        if not self._opencode_backend or self._opencode_backend.status != "running":
            try:
                await self._ensure_opencode_started(agent.working_dir)
            except Exception as e:
                logger.warning(
                    "Failed to start OpenCode serve, falling back to subprocess: {}",
                    e,
                )
                return await self._send_via_subprocess(agent, prompt, timeout)

        # Determine session ID
        session_id = agent.backend_session_id
        if not session_id:
            # Create a new session for this agent
            session_id = await self._opencode_backend.create_session(
                title=f"TalkTo: {agent.name}",
            )
            if session_id:
                db.update_agent_backend_session(agent.name, session_id)
                logger.info(
                    "Created and persisted OpenCode session {} for agent {}",
                    session_id, agent.name,
                )
            else:
                logger.warning(
                    "Failed to create OpenCode session for {}, falling back to subprocess",
                    agent.name,
                )
                return await self._send_via_subprocess(agent, prompt, timeout)

        # Send prompt via API
        result = await self._opencode_backend.send_prompt(
            prompt=prompt,
            session_id=session_id,
            working_dir=agent.working_dir,
            timeout=timeout,
        )

        # If session changed (stale session recovery), persist the new one
        if result.session_id and result.session_id != session_id:
            db.update_agent_backend_session(agent.name, result.session_id)
            logger.info(
                "Updated backend_session_id for {} from {} to {} (stale session recovery)",
                agent.name, session_id, result.session_id,
            )

        # If the backend failed (not timeout), fall back to subprocess
        if not result.ok and not result.timed_out:
            logger.warning(
                "OpenCode serve failed for {} ({}), falling back to subprocess",
                agent.name, result.error[:100],
            )
            return await self._send_via_subprocess(agent, prompt, timeout)

        return result

    async def _send_via_subprocess(
        self,
        agent,
        prompt: str,
        timeout: int,
    ) -> BackendResult:
        """Send via one-shot subprocess (fallback for all CLIs)."""
        backend = SubprocessBackend(agent.cli_type)
        return await backend.send_prompt(
            prompt=prompt,
            session_id=agent.session_id,
            working_dir=agent.working_dir,
            timeout=timeout,
        )

    async def _ensure_opencode_started(self, working_dir: Optional[str] = None) -> None:
        """Start OpenCode serve if not already running."""
        if self._opencode_starting:
            # Another coroutine is already starting it, wait
            for _ in range(60):
                await asyncio.sleep(1)
                if self._opencode_backend and self._opencode_backend.status == "running":
                    return
            raise RuntimeError("Timed out waiting for OpenCode serve to start")

        if self._opencode_backend and self._opencode_backend.status == "running":
            return

        self._opencode_starting = True
        try:
            self._opencode_backend = OpenCodeServerBackend(
                port=self._opencode_port,
                working_dir=working_dir,
            )
            await self._opencode_backend.start()
            # Auto-start the watchdog when OpenCode backend comes up
            await self.start_watchdog()
        except Exception:
            self._opencode_backend = None
            raise
        finally:
            self._opencode_starting = False

    async def get_status(self) -> dict:
        """Return status of all backends (for REST API)."""
        opencode_status = None
        if self._opencode_backend:
            opencode_status = {
                "status": self._opencode_backend.status,
                "port": self._opencode_backend.port,
                "base_url": self._opencode_backend._base_url,
                "type": "opencode_server",
            }

        return {
            "opencode_server": opencode_status,
            "subprocess": {
                "status": "always_available",
                "type": "subprocess",
                "description": "One-shot subprocess per message (Claude, Codex, fallback)",
            },
            "watchdog": {
                "running": self._watchdog_running and self._watchdog_task is not None and not self._watchdog_task.done(),
                "interval_seconds": self.WATCHDOG_INTERVAL,
                "restart_count": self._restart_count,
                "last_health_check": self._last_health_check,
            },
        }

    async def start_opencode(self, working_dir: Optional[str] = None) -> dict:
        """Manually start OpenCode serve backend. Returns status dict."""
        await self._ensure_opencode_started(working_dir)
        return await self.get_status()

    async def stop_opencode(self) -> dict:
        """Manually stop OpenCode serve backend. Returns status dict."""
        if self._opencode_backend:
            await self._opencode_backend.stop()
            self._opencode_backend = None
        return await self.get_status()

    # ── Watchdog ────────────────────────────────────────────────────────────

    async def start_watchdog(self) -> None:
        """Start the background health watchdog task.

        The watchdog periodically checks if OpenCode serve is healthy.
        If the process died, it attempts to restart it automatically.
        Only monitors when there's an active OpenCode backend.
        """
        if self._watchdog_task and not self._watchdog_task.done():
            logger.debug("Watchdog already running")
            return

        self._watchdog_running = True
        self._watchdog_task = asyncio.create_task(self._watchdog_loop())
        logger.info("Backend health watchdog started (interval={}s)", self.WATCHDOG_INTERVAL)

    async def stop_watchdog(self) -> None:
        """Stop the background health watchdog."""
        self._watchdog_running = False
        if self._watchdog_task and not self._watchdog_task.done():
            self._watchdog_task.cancel()
            try:
                await self._watchdog_task
            except asyncio.CancelledError:
                pass
        self._watchdog_task = None
        logger.info("Backend health watchdog stopped")

    async def _watchdog_loop(self) -> None:
        """Background loop: check OpenCode serve health, restart if dead."""
        while self._watchdog_running:
            try:
                await asyncio.sleep(self.WATCHDOG_INTERVAL)
            except asyncio.CancelledError:
                break

            if not self._opencode_backend:
                # No backend to watch — skip this cycle
                continue

            try:
                healthy = await self._opencode_backend.is_available()
                self._last_health_check = time.monotonic()

                if healthy:
                    logger.debug("Watchdog: OpenCode serve healthy")
                else:
                    # Backend exists but is unhealthy — attempt restart
                    logger.warning(
                        "Watchdog: OpenCode serve unhealthy (status={}), attempting restart...",
                        self._opencode_backend.status,
                    )
                    await self._watchdog_restart()

            except Exception as e:
                logger.error("Watchdog error: {}", e)

    async def _watchdog_restart(self) -> None:
        """Attempt to restart the OpenCode serve backend."""
        if self._opencode_starting:
            logger.debug("Watchdog: skipping restart, already starting")
            return

        # Remember the working dir from the old backend
        working_dir = self._opencode_backend._working_dir if self._opencode_backend else None

        # Stop the dead backend
        try:
            if self._opencode_backend:
                await self._opencode_backend.stop()
        except Exception as e:
            logger.warning("Watchdog: error stopping dead backend: {}", e)

        self._opencode_backend = None

        # Try to start a fresh one
        try:
            await self._ensure_opencode_started(working_dir)
            self._restart_count += 1
            logger.info(
                "Watchdog: OpenCode serve restarted successfully (total restarts: {})",
                self._restart_count,
            )
        except Exception as e:
            logger.error("Watchdog: failed to restart OpenCode serve: {}", e)

    async def shutdown(self) -> None:
        """Clean shutdown of all managed backends and watchdog."""
        logger.info("Shutting down all backends...")
        # Stop watchdog first
        await self.stop_watchdog()
        if self._opencode_backend:
            try:
                await self._opencode_backend.stop()
            except Exception as e:
                logger.error("Error stopping OpenCode backend: {}", e)
            self._opencode_backend = None
        logger.info("All backends shut down")
