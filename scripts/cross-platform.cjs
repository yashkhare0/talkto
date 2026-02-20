/**
 * Cross-platform helper scripts for TalkTo.
 *
 * Usage: node scripts/cross-platform.js <command>
 *   stop    — Kill processes on ports 15377 and 3000
 *   status  — Check if servers are listening
 *   clean   — Remove database and build artifacts
 *   nuke    — Remove node_modules (run after 'clean')
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const isWin = process.platform === "win32";
const command = process.argv[2];

const PORTS = [15377, 3000];
const PORT_NAMES = { 15377: "Backend", 3000: "Frontend" };

function killPort(port) {
  try {
    if (isWin) {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: "ignore" }
      );
    } else {
      execSync(`lsof -ti :${port} 2>/dev/null | xargs kill -9 2>/dev/null`, {
        stdio: "ignore",
      });
    }
  } catch {
    // Port might not be in use — that's fine
  }
}

function checkPort(port) {
  try {
    if (isWin) {
      const result = execSync(
        `powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue){'LISTENING'}else{'not running'}"`,
        { encoding: "utf8" }
      ).trim();
      return result;
    } else {
      execSync(`lsof -i :${port} -P -n 2>/dev/null | grep LISTEN`, {
        stdio: "ignore",
      });
      return "LISTENING";
    }
  } catch {
    return "not running";
  }
}

function clean() {
  const root = path.resolve(__dirname, "..");
  const dbFiles = [
    "data/talkto.db",
    "data/talkto.db-wal",
    "data/talkto.db-shm",
  ];
  for (const f of dbFiles) {
    try {
      fs.unlinkSync(path.join(root, f));
    } catch {
      // File doesn't exist — fine
    }
  }
  try {
    fs.rmSync(path.join(root, "frontend", "dist"), {
      recursive: true,
      force: true,
    });
  } catch {
    // Already gone
  }
  console.log("Cleaned.");
}

function nuke() {
  const root = path.resolve(__dirname, "..");
  const dirs = ["server/node_modules", "frontend/node_modules", "node_modules"];
  for (const d of dirs) {
    try {
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
    } catch {
      // Already gone
    }
  }
  console.log("Nuked. Run 'bun run install:all' to set up again.");
}

switch (command) {
  case "stop":
    for (const port of PORTS) killPort(port);
    console.log("Killed processes on :15377 and :3000");
    break;
  case "status":
    for (const port of PORTS) {
      const name = PORT_NAMES[port] || `Port ${port}`;
      console.log(`${name}  (:${port}): ${checkPort(port)}`);
    }
    break;
  case "clean":
    clean();
    break;
  case "nuke":
    nuke();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: node scripts/cross-platform.js <stop|status|clean|nuke>");
    process.exit(1);
}
