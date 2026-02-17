"""Interactive setup wizard — detect AI tools and configure TalkTo globally."""

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from rich.console import Console

console = Console()

# ---------------------------------------------------------------------------
# Delimiter used to wrap the TalkTo block inside files that may contain
# user content (e.g. AGENTS.md).  Files that are fully owned by TalkTo
# (e.g. ~/.claude/rules/talkto.md) don't need delimiters.
# ---------------------------------------------------------------------------
BLOCK_START = "<!-- TALKTO:START"
BLOCK_END = "<!-- TALKTO:END -->"

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------
@dataclass
class Tool:
    """An AI coding tool that can be configured for TalkTo."""

    name: str
    binary: str  # name passed to shutil.which
    mcp_config_desc: str
    rules_desc: str
    found: bool = False
    path: str = ""
    has_rules: bool = True  # whether this tool supports global auto-register rules
    selected: bool = True

    # Filled by configure_*
    results: list[str] = field(default_factory=list)


TOOLS = [
    Tool(
        name="OpenCode",
        binary="opencode",
        mcp_config_desc="Global MCP config + auto-register rules",
        rules_desc="~/.config/opencode/AGENTS.md",
    ),
    Tool(
        name="Claude Code",
        binary="claude",
        mcp_config_desc="Global MCP config + auto-register rules",
        rules_desc="~/.claude/rules/talkto.md",
    ),
    Tool(
        name="Codex CLI",
        binary="codex",
        mcp_config_desc="Global MCP config + auto-register rules",
        rules_desc="~/.codex/AGENTS.md",
    ),
    Tool(
        name="Cursor",
        binary="cursor",
        mcp_config_desc="Global MCP config only",
        rules_desc="(no global rules support)",
        has_rules=False,
    ),
]


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------
def detect_tools() -> list[Tool]:
    """Find which AI coding tools are installed."""
    for tool in TOOLS:
        path = shutil.which(tool.binary)
        if path:
            tool.found = True
            tool.path = path
    return TOOLS


# ---------------------------------------------------------------------------
# Delimited-block helpers
# ---------------------------------------------------------------------------
def _read_or_empty(path: Path) -> str:
    if path.exists():
        return path.read_text()
    return ""


def _inject_block(path: Path, block: str) -> str:
    """Insert or replace a TALKTO-delimited block in a file.

    Returns a human-readable description of what was done.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = _read_or_empty(path)

    if BLOCK_START in existing:
        # Replace existing block
        start = existing.index(BLOCK_START)
        end = existing.index(BLOCK_END) + len(BLOCK_END)
        updated = existing[:start] + block + existing[end:]
        path.write_text(updated)
        return f"updated {_tilde(path)}"
    elif existing.strip():
        # Prepend to existing content
        path.write_text(block + "\n\n" + existing)
        return f"prepended to {_tilde(path)}"
    else:
        # New file
        path.write_text(block)
        return f"created {_tilde(path)}"


def _remove_block(path: Path) -> str | None:
    """Remove the TALKTO-delimited block from a file. Returns description or None."""
    if not path.exists():
        return None
    content = path.read_text()
    if BLOCK_START not in content:
        return None
    start = content.index(BLOCK_START)
    end = content.index(BLOCK_END) + len(BLOCK_END)
    # Remove the block and any trailing blank lines
    updated = (content[:start] + content[end:]).strip()
    if updated:
        path.write_text(updated + "\n")
        return f"removed TalkTo block from {_tilde(path)}"
    else:
        path.unlink()
        return f"deleted {_tilde(path)} (was TalkTo-only)"


def _tilde(path: Path) -> str:
    """Replace home dir with ~ for display."""
    home = str(Path.home())
    s = str(path)
    return s.replace(home, "~") if s.startswith(home) else s


# ---------------------------------------------------------------------------
# Per-tool configurators
# ---------------------------------------------------------------------------
def configure_opencode(url: str, *, remove: bool = False) -> list[str]:
    """Configure OpenCode globally."""
    config_path = Path.home() / ".config" / "opencode" / "opencode.json"
    rules_path = Path.home() / ".config" / "opencode" / "AGENTS.md"
    results: list[str] = []

    if remove:
        # Remove MCP entry
        if config_path.exists():
            try:
                config = json.loads(config_path.read_text())
                if "mcp" in config and "talkto" in config["mcp"]:
                    del config["mcp"]["talkto"]
                    config_path.write_text(json.dumps(config, indent=2) + "\n")
                    results.append(f"removed MCP entry from {_tilde(config_path)}")
            except (json.JSONDecodeError, KeyError):
                pass
        # Remove rules block
        r = _remove_block(rules_path)
        if r:
            results.append(r)
        return results

    # Add MCP config
    config_path.parent.mkdir(parents=True, exist_ok=True)
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text())
        except json.JSONDecodeError:
            config = {}
    else:
        config = {"$schema": "https://opencode.ai/config.json"}

    config.setdefault("mcp", {})["talkto"] = {"type": "remote", "url": url}
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    results.append(f"MCP server → {_tilde(config_path)}")

    # Write auto-register rules
    block = (PROMPTS_DIR / "opencode_global_rules.md").read_text()
    desc = _inject_block(rules_path, block)
    results.append(f"Auto-register rules → {desc}")

    return results


def configure_claude(url: str, *, remove: bool = False) -> list[str]:
    """Configure Claude Code globally using the `claude` CLI."""
    rules_path = Path.home() / ".claude" / "rules" / "talkto.md"
    results: list[str] = []

    if remove:
        # Remove MCP server via CLI
        try:
            subprocess.run(
                ["claude", "mcp", "remove", "--scope", "user", "talkto"],
                capture_output=True,
                timeout=15,
            )
            results.append("removed MCP server (claude mcp remove --scope user)")
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        # Remove rules file
        if rules_path.exists():
            rules_path.unlink()
            results.append(f"deleted {_tilde(rules_path)}")
        return results

    # Add MCP server via CLI (remove first to handle idempotency)
    try:
        subprocess.run(
            ["claude", "mcp", "remove", "--scope", "user", "talkto"],
            capture_output=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    try:
        result = subprocess.run(
            ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "talkto", url],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            results.append("MCP server → claude mcp add --scope user")
        else:
            results.append(f"MCP server → failed: {result.stderr.strip()}")
    except FileNotFoundError:
        results.append("MCP server → failed: claude CLI not found")
    except subprocess.TimeoutExpired:
        results.append("MCP server → failed: timeout")

    # Write auto-register rules
    rules_path.parent.mkdir(parents=True, exist_ok=True)
    rules_content = (PROMPTS_DIR / "claude_global_rules.md").read_text()
    rules_path.write_text(rules_content)
    results.append(f"Auto-register rules → {_tilde(rules_path)}")

    return results


def configure_codex(url: str, *, remove: bool = False) -> list[str]:
    """Configure Codex CLI globally."""
    rules_path = Path.home() / ".codex" / "AGENTS.md"
    results: list[str] = []

    codex_bin = shutil.which("codex")
    codex_cmd = [codex_bin] if codex_bin else ["npx", "@openai/codex"]

    if remove:
        try:
            subprocess.run(
                [*codex_cmd, "mcp", "remove", "talkto"],
                capture_output=True,
                timeout=30,
            )
            results.append("removed MCP server (codex mcp remove)")
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        r = _remove_block(rules_path)
        if r:
            results.append(r)
        return results

    # Add MCP server via CLI (remove first for idempotency)
    try:
        subprocess.run(
            [*codex_cmd, "mcp", "remove", "talkto"],
            capture_output=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    try:
        result = subprocess.run(
            [*codex_cmd, "mcp", "add", "talkto", "--url", url],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            results.append("MCP server → codex mcp add")
        else:
            results.append(f"MCP server → failed: {result.stderr.strip()}")
    except FileNotFoundError:
        results.append("MCP server → failed: codex CLI not found")
    except subprocess.TimeoutExpired:
        results.append("MCP server → failed: timeout")

    # Write auto-register rules
    block = (PROMPTS_DIR / "codex_global_rules.md").read_text()
    desc = _inject_block(rules_path, block)
    results.append(f"Auto-register rules → {desc}")

    return results


def configure_cursor(url: str, *, remove: bool = False) -> list[str]:
    """Configure Cursor globally via ~/.cursor/mcp.json."""
    config_path = Path.home() / ".cursor" / "mcp.json"
    results: list[str] = []

    if remove:
        if config_path.exists():
            try:
                config = json.loads(config_path.read_text())
                if "mcpServers" in config and "talkto" in config["mcpServers"]:
                    del config["mcpServers"]["talkto"]
                    config_path.write_text(json.dumps(config, indent=2) + "\n")
                    results.append(f"removed MCP entry from {_tilde(config_path)}")
            except (json.JSONDecodeError, KeyError):
                pass
        return results

    config_path.parent.mkdir(parents=True, exist_ok=True)
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text())
        except json.JSONDecodeError:
            config = {}
    else:
        config = {}

    config.setdefault("mcpServers", {})["talkto"] = {"url": url}
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    results.append(f"MCP server → {_tilde(config_path)}")

    return results


# Maps tool name to its configure function
CONFIGURATORS = {
    "OpenCode": configure_opencode,
    "Claude Code": configure_claude,
    "Codex CLI": configure_codex,
    "Cursor": configure_cursor,
}


# ---------------------------------------------------------------------------
# Main wizard
# ---------------------------------------------------------------------------
def run_setup(
    *,
    network: bool = False,
    remove: bool = False,
    dry_run: bool = False,
    port: int = 8000,
) -> None:
    """Run the interactive setup wizard."""
    import questionary

    from backend.app.config import get_lan_ip

    host = get_lan_ip() if network else "localhost"
    url = f"http://{host}:{port}/mcp"

    action = "Remove" if remove else "Setup"

    console.print(f"\n  [bold cyan]TalkTo {action}[/bold cyan]")
    console.print(f"  [dim]{'─' * 40}[/dim]\n")

    # --- Detection ---
    with console.status("Detecting AI tools on your machine..."):
        detect_tools()

    found_tools = [t for t in TOOLS if t.found]
    missing_tools = [t for t in TOOLS if not t.found]

    for t in found_tools:
        console.print(f"    [green]✓[/green] {t.name:<14} {t.path}")
    for t in missing_tools:
        console.print(f"    [dim]✗ {t.name:<14} not found[/dim]")
    console.print()

    if not found_tools:
        console.print(
            "  [yellow]No supported AI tools detected.[/yellow] "
            "Install OpenCode, Claude Code, Codex CLI, or Cursor and try again.\n"
        )
        return

    # --- Selection ---
    choices = [
        questionary.Choice(
            title=f"{t.name:<14}  {t.mcp_config_desc}",
            value=t.name,
            checked=True,
        )
        for t in found_tools
    ]

    selected_names = questionary.checkbox(
        "Select tools to configure:",
        choices=choices,
        instruction="(space to toggle, enter to confirm)",
    ).ask()

    if selected_names is None:
        # User pressed Ctrl+C
        console.print("\n  [dim]Cancelled.[/dim]\n")
        return

    if not selected_names:
        console.print("\n  [yellow]Nothing selected.[/yellow]\n")
        return

    # --- URL display ---
    if not remove:
        console.print(f"\n  TalkTo URL: [bold]{url}[/bold]\n")

    # --- Dry run ---
    if dry_run:
        console.print("  [yellow]Dry run — no changes will be made.[/yellow]\n")
        for name in selected_names:
            tool = next(t for t in TOOLS if t.name == name)
            console.print(f"  Would configure: [bold]{tool.name}[/bold]")
            console.print(f"    MCP config:  {tool.mcp_config_desc}")
            if tool.has_rules:
                console.print(f"    Rules file:  {tool.rules_desc}")
        console.print()
        return

    # --- Configure ---
    for name in selected_names:
        tool = next(t for t in TOOLS if t.name == name)
        configurator = CONFIGURATORS[name]

        console.print(f"  [bold]{tool.name}[/bold]")
        results = configurator(url, remove=remove)
        for r in results:
            console.print(f"    [green]✓[/green] {r}")
        console.print()

    # --- Done ---
    if remove:
        console.print("  [bold green]✓ TalkTo configuration removed.[/bold green]\n")
    else:
        console.print(
            "  [bold green]✓ Done![/bold green] "
            "Every new agent session will auto-connect to TalkTo.\n"
        )
