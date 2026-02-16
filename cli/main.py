"""TalkTo CLI — start/stop the platform, generate MCP configs."""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import typer
import uvicorn

app = typer.Typer(
    help="TalkTo - Slack for AI Agents",
    no_args_is_help=True,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
PIDFILE = PROJECT_ROOT / "data" / "talkto.pid"


def _find_vite_bin() -> list[str]:
    """Find the fastest way to invoke vite."""
    local_bin = FRONTEND_DIR / "node_modules" / ".bin" / "vite"
    if local_bin.exists():
        return [str(local_bin)]
    return ["npx", "vite"]


@app.command()
def start(
    api_only: bool = typer.Option(False, "--api-only", help="Only start the API server"),
    no_open: bool = typer.Option(False, "--no-open", help="Don't auto-open browser"),
    port: int = typer.Option(8000, "--port", "-p", help="API server port"),
) -> None:
    """Start TalkTo — boots FastAPI + Vite dev server.

    Both servers run with hot reload enabled:
      - Backend: uvicorn --reload watches backend/ and prompts/
      - Frontend: Vite HMR on port 3000

    The Vite dev server proxies /api and /ws to the FastAPI backend.
    """
    # Ensure data dir exists
    PIDFILE.parent.mkdir(parents=True, exist_ok=True)

    pids: list[int] = []
    vite_proc = None

    # Start Vite dev server (unless api-only)
    if not api_only and FRONTEND_DIR.exists():
        vite_cmd = _find_vite_bin() + ["--port", "3000", "--host"]
        typer.secho("Starting Vite dev server...", fg=typer.colors.CYAN)
        vite_proc = subprocess.Popen(
            vite_cmd,
            cwd=str(FRONTEND_DIR),
            # Let Vite output flow to terminal so you see HMR updates and errors
        )
        pids.append(vite_proc.pid)
        typer.echo(f"  Vite PID: {vite_proc.pid}")
    elif not api_only:
        typer.secho(
            f"Warning: frontend/ not found at {FRONTEND_DIR}, skipping Vite",
            fg=typer.colors.YELLOW,
        )

    # Save PIDs for stop command
    PIDFILE.write_text(json.dumps(pids))

    # Auto-open browser after a short delay
    if not no_open and not api_only:
        def _open_browser() -> None:
            time.sleep(3)
            import webbrowser
            webbrowser.open("http://localhost:3000")

        import threading
        threading.Thread(target=_open_browser, daemon=True).start()

    typer.echo("")
    typer.secho("TalkTo is starting up", fg=typer.colors.GREEN, bold=True)
    typer.echo(f"  UI:      http://localhost:3000")
    typer.echo(f"  API:     http://localhost:{port}")
    typer.echo(f"  API docs: http://localhost:{port}/docs")
    typer.echo(f"  Health:  http://localhost:{port}/api/health")
    typer.echo("")
    typer.echo("  Ctrl+C to stop both servers")
    typer.echo("")

    try:
        uvicorn.run(
            "backend.app.main:app",
            host="0.0.0.0",
            port=port,
            reload=True,
            reload_dirs=[
                str(PROJECT_ROOT / "backend"),
                str(PROJECT_ROOT / "prompts"),
            ],
            log_level="info",
        )
    except KeyboardInterrupt:
        pass
    finally:
        # Clean up Vite process
        if vite_proc and vite_proc.poll() is None:
            typer.secho("\nStopping Vite dev server...", fg=typer.colors.CYAN)
            vite_proc.terminate()
            try:
                vite_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                vite_proc.kill()
        if PIDFILE.exists():
            PIDFILE.unlink()
        typer.secho("TalkTo stopped.", fg=typer.colors.GREEN)


@app.command()
def stop() -> None:
    """Stop running TalkTo processes."""
    if not PIDFILE.exists():
        typer.secho("No running TalkTo instance found.", fg=typer.colors.YELLOW)
        raise typer.Exit(1)

    pids = json.loads(PIDFILE.read_text())
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            typer.echo(f"  Stopped process {pid}")
        except ProcessLookupError:
            typer.echo(f"  Process {pid} already stopped")

    PIDFILE.unlink()
    typer.secho("TalkTo stopped.", fg=typer.colors.GREEN)


@app.command(name="mcp-config")
def mcp_config(
    project_path: str = typer.Argument(
        ..., help="Absolute path to the project the agent is working on"
    ),
    port: int = typer.Option(8000, "--port", "-p", help="API server port"),
) -> None:
    """Generate MCP server config JSON for connecting an agent.

    Outputs the JSON block to add to your agent's MCP config file.
    The MCP server runs over HTTP on the same port as the API (streamable-http).

    Works with: Claude Code (.mcp.json), OpenCode (opencode.json), etc.
    """
    url = f"http://localhost:{port}/mcp"

    # Claude Code / generic format
    claude_config = {
        "mcpServers": {
            "talkto": {
                "type": "streamable-http",
                "url": url,
            }
        }
    }

    # OpenCode format (type: "remote" with url)
    opencode_config = {
        "mcp": {
            "talkto": {
                "type": "remote",
                "url": url,
            }
        }
    }

    typer.secho("TalkTo MCP — HTTP Transport", fg=typer.colors.GREEN, bold=True)
    typer.echo(f"  Endpoint: {url}")
    typer.echo("")

    typer.secho("Claude Code (.mcp.json):", fg=typer.colors.CYAN, bold=True)
    typer.echo(json.dumps(claude_config, indent=2))
    typer.echo("")

    typer.secho("OpenCode (opencode.json):", fg=typer.colors.CYAN, bold=True)
    typer.echo(json.dumps(opencode_config, indent=2))
    typer.echo("")

    typer.echo(f"Project path for agent registration: {project_path}")
    typer.echo("")
    typer.echo("After adding the config, the agent should call:")
    typer.echo(f'  register(agent_type="opencode", project_path="{project_path}")')


@app.command()
def status() -> None:
    """Check if TalkTo servers are running."""
    import httpx

    # Check API
    try:
        resp = httpx.get("http://localhost:8000/api/health", timeout=3)
        data = resp.json()
        typer.secho("API server:  running", fg=typer.colors.GREEN)
        typer.echo(f"  WebSocket clients: {data.get('ws_clients', '?')}")
    except Exception:
        typer.secho("API server:  not running", fg=typer.colors.RED)

    # Check Vite
    try:
        resp = httpx.get("http://localhost:3000", timeout=3)
        typer.secho("Vite server: running", fg=typer.colors.GREEN)
    except Exception:
        typer.secho("Vite server: not running", fg=typer.colors.RED)

    # Check PID file
    if PIDFILE.exists():
        pids = json.loads(PIDFILE.read_text())
        typer.echo(f"  Tracked PIDs: {pids}")
    else:
        typer.echo("  No PID file found")


if __name__ == "__main__":
    app()
