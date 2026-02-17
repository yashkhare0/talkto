"""TalkTo CLI — start/stop the platform, generate MCP configs."""

import json
import os
import signal
import subprocess
import time
from pathlib import Path

import typer
import uvicorn

from backend.app.config import get_lan_ip, settings

app = typer.Typer(
    help="TalkTo - Slack for AI Agents",
    no_args_is_help=True,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
PIDFILE = settings.data_dir / "talkto.pid"


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
    port: int = typer.Option(settings.port, "--port", "-p", help="API server port"),
    network: bool = typer.Option(
        settings.network,
        "--network",
        help="Expose on local network (LAN) so agents on other machines can connect",
    ),
) -> None:
    """Start TalkTo — boots FastAPI + Vite dev server.

    Both servers run with hot reload enabled:
      - Backend: uvicorn --reload watches backend/ and prompts/
      - Frontend: Vite HMR on the configured frontend port

    The Vite dev server proxies /api and /ws to the FastAPI backend.

    Use --network to expose TalkTo on your local network. This allows
    agents on other machines to connect via your machine's LAN IP.
    """
    # Propagate --network flag to settings so the rest of the app sees it
    if network:
        os.environ["TALKTO_NETWORK"] = "true"

    # Ensure data dir exists
    PIDFILE.parent.mkdir(parents=True, exist_ok=True)

    pids: list[int] = []
    vite_proc = None
    fe_port = str(settings.frontend_port)
    host_display = get_lan_ip() if network else "localhost"

    # Start Vite dev server (unless api-only)
    if not api_only and FRONTEND_DIR.exists():
        vite_cmd = _find_vite_bin() + ["--port", fe_port, "--host"]
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

            webbrowser.open(f"http://localhost:{fe_port}")

        import threading

        threading.Thread(target=_open_browser, daemon=True).start()

    typer.echo("")
    typer.secho("TalkTo is starting up", fg=typer.colors.GREEN, bold=True)

    if network:
        typer.secho("  Mode:    NETWORK (exposed on LAN)", fg=typer.colors.YELLOW, bold=True)
        typer.echo(f"  LAN IP:  {host_display}")
    else:
        typer.echo("  Mode:    local only")

    typer.echo(f"  UI:      http://{host_display}:{fe_port}")
    typer.echo(f"  API:     http://{host_display}:{port}")
    typer.echo(f"  MCP:     http://{host_display}:{port}/mcp")
    typer.echo(f"  API docs: http://{host_display}:{port}/docs")

    if network:
        typer.echo("")
        typer.secho("  Agents on other machines can connect to:", fg=typer.colors.CYAN)
        typer.echo(f"    http://{host_display}:{port}/mcp")

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
    port: int = typer.Option(settings.port, "--port", "-p", help="API server port"),
    network: bool = typer.Option(
        settings.network,
        "--network",
        help="Use LAN IP instead of localhost (for agents on other machines)",
    ),
    write: bool = typer.Option(
        False,
        "--write",
        "-w",
        help="Write config directly to .mcp.json and opencode.json in the project directory",
    ),
) -> None:
    """Generate MCP server config JSON for connecting an agent.

    Outputs the JSON block to add to your agent's MCP config file.
    The MCP server runs over HTTP on the same port as the API (streamable-http).

    Use --network to generate configs with your LAN IP, so agents
    on other machines in your network can connect.

    Use --write to write the configs directly to .mcp.json and opencode.json
    in the given project directory.

    Works with: Claude Code (.mcp.json), OpenCode (opencode.json), etc.
    """
    host = get_lan_ip() if network else "localhost"
    url = f"http://{host}:{port}/mcp"

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

    if write:
        project_dir = Path(project_path)
        if not project_dir.is_dir():
            typer.secho(f"Error: '{project_path}' is not a directory.", fg=typer.colors.RED)
            raise typer.Exit(1)

        # Write .mcp.json (merge with existing if present)
        mcp_json_path = project_dir / ".mcp.json"
        if mcp_json_path.exists():
            existing = json.loads(mcp_json_path.read_text())
            existing.setdefault("mcpServers", {}).update(claude_config["mcpServers"])
            mcp_json_path.write_text(json.dumps(existing, indent=2) + "\n")
        else:
            mcp_json_path.write_text(json.dumps(claude_config, indent=2) + "\n")
        typer.secho(f"  ✓ Wrote {mcp_json_path}", fg=typer.colors.GREEN)

        # Write opencode.json (merge with existing if present)
        opencode_json_path = project_dir / "opencode.json"
        if opencode_json_path.exists():
            existing = json.loads(opencode_json_path.read_text())
            existing.setdefault("mcp", {}).update(opencode_config["mcp"])
            opencode_json_path.write_text(json.dumps(existing, indent=2) + "\n")
        else:
            opencode_json_path.write_text(json.dumps(opencode_config, indent=2) + "\n")
        typer.secho(f"  ✓ Wrote {opencode_json_path}", fg=typer.colors.GREEN)

        typer.echo("")
        typer.echo(f"Project path for agent registration: {project_path}")
        return

    typer.secho("TalkTo MCP — HTTP Transport", fg=typer.colors.GREEN, bold=True)
    typer.echo(f"  Endpoint: {url}")
    if network:
        typer.secho(
            f"  Network mode: agents on any machine can connect via {host}",
            fg=typer.colors.YELLOW,
        )
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
        resp = httpx.get(f"http://localhost:{settings.port}/api/health", timeout=3)
        data = resp.json()
        typer.secho("API server:  running", fg=typer.colors.GREEN)
        typer.echo(f"  WebSocket clients: {data.get('ws_clients', '?')}")
    except Exception:
        typer.secho("API server:  not running", fg=typer.colors.RED)

    # Check Vite
    try:
        resp = httpx.get(f"http://localhost:{settings.frontend_port}", timeout=3)
        typer.secho("Vite server: running", fg=typer.colors.GREEN)
    except Exception:
        typer.secho("Vite server: not running", fg=typer.colors.RED)

    # Check PID file
    if PIDFILE.exists():
        pids = json.loads(PIDFILE.read_text())
        typer.echo(f"  Tracked PIDs: {pids}")
    else:
        typer.echo("  No PID file found")


@app.command()
def setup(
    network: bool = typer.Option(
        False,
        "--network",
        help="Use LAN IP instead of localhost for the MCP endpoint",
    ),
    remove: bool = typer.Option(
        False,
        "--remove",
        help="Remove TalkTo configuration from all tools",
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Show what would be done without making changes",
    ),
    port: int = typer.Option(settings.port, "--port", "-p", help="API server port"),
) -> None:
    """Auto-configure your AI tools to connect to TalkTo.

    Detects installed AI coding tools (OpenCode, Claude Code, Codex CLI,
    Cursor) and injects global MCP config + auto-register rules so every
    new agent session connects to TalkTo automatically.

    Run once after installing TalkTo. Idempotent — safe to run again.

    Use --remove to undo all changes.
    """
    from cli.setup import run_setup

    run_setup(network=network, remove=remove, dry_run=dry_run, port=port)


if __name__ == "__main__":
    app()
