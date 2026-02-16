#!/usr/bin/env node

/**
 * TalkTo CLI wrapper — bootstraps the Python project and forwards commands.
 *
 * Usage:
 *   npx talkto              → starts TalkTo (clone + install on first run)
 *   npx talkto start        → same as above
 *   npx talkto stop         → stop running servers
 *   npx talkto status       → check server status
 *   npx talkto mcp-config . → generate MCP config
 *
 * On first run:
 *   1. Checks prerequisites (Python 3.12+, uv, pnpm, git)
 *   2. Clones the repo to ~/.talkto/
 *   3. Runs `make install`
 *
 * Subsequent runs skip straight to the command.
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TALKTO_HOME = join(homedir(), ".talkto");
const REPO_DIR = join(TALKTO_HOME, "repo");
const REPO_URL = "https://github.com/yashkhare0/talkto.git";

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  console.log(`\x1b[36m[talkto]\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m[talkto]\x1b[0m ${msg}`);
}

function fatal(msg) {
  console.error(`\x1b[31m[talkto]\x1b[0m ${msg}`);
  process.exit(1);
}

function which(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
}

// ── Prerequisite Checks ─────────────────────────────────────────────

function checkPrerequisites() {
  const missing = [];

  // uv (checked first because it can manage Python)
  const hasUv = which("uv");
  if (!hasUv) {
    missing.push(
      "uv (Python package manager) — install: curl -LsSf https://astral.sh/uv/install.sh | sh"
    );
  }

  // Python 3.12+ — either in PATH or uv will handle it
  if (!hasUv) {
    // Only require system Python if uv is missing (uv can install Python itself)
    let pythonOk = false;
    for (const cmd of ["python3", "python"]) {
      if (which(cmd)) {
        try {
          const version = run(`${cmd} --version`);
          const match = version.match(/(\d+)\.(\d+)/);
          if (match && Number(match[1]) >= 3 && Number(match[2]) >= 12) {
            pythonOk = true;
            break;
          }
        } catch {
          // continue
        }
      }
    }
    if (!pythonOk) {
      missing.push(
        "Python 3.12+ — install from https://www.python.org/ or install uv (which manages Python for you)"
      );
    }
  }

  // pnpm
  if (!which("pnpm")) {
    missing.push(
      "pnpm (Node package manager) — install: npm install -g pnpm  OR  corepack enable"
    );
  }

  // git
  if (!which("git")) {
    missing.push("git — install from https://git-scm.com/");
  }

  if (missing.length > 0) {
    fatal(
      `Missing prerequisites:\n${missing.map((m) => `  - ${m}`).join("\n")}\n\nInstall them and try again.`
    );
  }
}

// ── Clone / Update ──────────────────────────────────────────────────

function ensureRepo() {
  if (!existsSync(REPO_DIR)) {
    log("First run — cloning TalkTo...");
    mkdirSync(TALKTO_HOME, { recursive: true });
    try {
      execSync(`git clone ${REPO_URL} "${REPO_DIR}"`, { stdio: "inherit" });
    } catch {
      fatal(
        `Failed to clone ${REPO_URL}\nMake sure you have access to the repository.`
      );
    }
    log("Clone complete.");
  } else {
    // Best-effort update — silent failure if offline
    try {
      execSync("git pull --ff-only", {
        cwd: REPO_DIR,
        stdio: "pipe",
        timeout: 10000,
      });
    } catch {
      // Offline or diverged — that's fine, use what we have
    }
  }
}

// ── Install ─────────────────────────────────────────────────────────

function ensureInstalled() {
  const venvExists = existsSync(join(REPO_DIR, ".venv"));
  const nodeModulesExists = existsSync(
    join(REPO_DIR, "frontend", "node_modules")
  );

  if (venvExists && nodeModulesExists) {
    return; // Already installed
  }

  log("Installing dependencies (this takes ~30 seconds on first run)...");

  // Run each step individually so partial installs can resume
  try {
    if (!venvExists) {
      log("Creating Python virtual environment...");
      execSync("uv venv", { cwd: REPO_DIR, stdio: "inherit" });
    }

    log("Installing Python dependencies...");
    execSync('uv pip install -e ".[dev]"', { cwd: REPO_DIR, stdio: "inherit" });

    if (!nodeModulesExists) {
      log("Installing frontend dependencies...");
      execSync("pnpm install", {
        cwd: join(REPO_DIR, "frontend"),
        stdio: "inherit",
      });
    }
  } catch {
    fatal(
      "Installation failed. Try running manually:\n" +
        `  cd ${REPO_DIR}\n  make install`
    );
  }
  log("Installation complete.");
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  // Special flags that don't need the repo
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
TalkTo — Local-first messaging platform for AI coding agents

Usage:
  npx talkto [command] [options]

Commands:
  start          Start TalkTo servers (default if no command given)
  stop           Stop running TalkTo servers
  status         Check if TalkTo is running
  mcp-config     Generate MCP config for a project

Options (for start):
  --api-only     Start API server only (no frontend)
  --no-open      Don't auto-open browser
  --port, -p     API server port (default: 8000)

Examples:
  npx talkto                          # Start with defaults
  npx talkto start --port 9000        # Custom port
  npx talkto mcp-config /path/to/project  # Generate MCP config
  npx talkto stop                     # Stop servers

First run clones and installs TalkTo to ~/.talkto/
Repo: ${REPO_URL}
`);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    try {
      const pkg = run(`node -e "console.log(require('./package.json').version)"`, {
        cwd: join(import.meta.dirname, ".."),
      });
      console.log(`talkto ${pkg}`);
    } catch {
      console.log("talkto (version unknown)");
    }
    process.exit(0);
  }

  // Prerequisite check
  checkPrerequisites();

  // Ensure repo is cloned and deps installed
  ensureRepo();
  ensureInstalled();

  // Default command: start
  const command = args.length === 0 ? ["start"] : args;

  // Forward to the Python CLI
  log(`Running: talkto ${command.join(" ")}`);
  const child = spawn("uv", ["run", "talkto", ...command], {
    cwd: REPO_DIR,
    stdio: "inherit",
    env: { ...process.env, PATH: `${homedir()}/.local/bin:${process.env.PATH}` },
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });

  // Forward signals so Ctrl+C works cleanly
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }
}

main();
