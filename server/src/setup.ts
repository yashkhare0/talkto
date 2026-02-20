/**
 * TalkTo Setup — User-scoped provider configuration.
 *
 * Configures MCP servers and agent rules globally for each detected
 * AI coding agent provider (Claude Code, OpenCode, Codex CLI).
 *
 * Run: bun run setup (from server/)
 */

import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { config, BASE_DIR } from "./lib/config";

// ── ANSI helpers ────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function ok(msg: string) {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}
function warn(msg: string) {
  console.log(`  ${c.yellow}!${c.reset} ${msg}`);
}
function fail(msg: string) {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
}
function heading(msg: string) {
  console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}`);
}
function info(msg: string) {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

// ── I/O helpers ─────────────────────────────────────────────────

async function prompt(question: string): Promise<string> {
  process.stdout.write(`${question} `);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

/** Read a prompt template from prompts/ directory */
function readPromptTemplate(filename: string): string {
  const path = resolve(BASE_DIR, "prompts", filename);
  if (!existsSync(path)) {
    throw new Error(`Prompt template not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

/** Write a file, creating parent directories as needed */
function writeFileSafe(path: string, content: string) {
  const dir = resolve(path, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/** Run a shell command, return { ok, stdout, stderr } */
async function exec(
  cmd: string,
  args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Check if a command exists on PATH */
async function commandExists(cmd: string): Promise<string | null> {
  const result = await exec("which", [cmd]);
  return result.ok ? result.stdout : null;
}

// ── Provider definitions ────────────────────────────────────────

interface Provider {
  id: string;
  name: string;
  cli: string;
  detected: boolean;
  version: string | null;
  configMcp: () => Promise<boolean>;
  installRules: () => Promise<boolean>;
}

async function detectVersion(cmd: string): Promise<string | null> {
  const result = await exec(cmd, ["--version"]);
  if (!result.ok) return null;
  // Extract version from output like "claude 1.2.3" or "opencode v0.8.1"
  const match = result.stdout.match(/[\d]+\.[\d]+\.[\d]+/);
  return match ? match[0] : result.stdout.split("\n")[0];
}

// ── Claude Code ─────────────────────────────────────────────────

async function configureClaude(): Promise<Provider> {
  const cli = "claude";
  const path = await commandExists(cli);
  const version = path ? await detectVersion(cli) : null;

  return {
    id: "claude_code",
    name: "Claude Code",
    cli,
    detected: !!path,
    version,

    async configMcp(): Promise<boolean> {
      // Remove existing entry first (idempotent — ignore errors)
      await exec(cli, ["mcp", "remove", "--scope", "user", "talkto"]);

      // Add MCP server at user scope
      const result = await exec(cli, [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        "talkto",
        config.mcpUrl,
      ]);

      if (result.ok) {
        ok(`MCP server added (user scope)`);
        return true;
      }
      fail(`MCP config failed: ${result.stderr}`);
      return false;
    },

    async installRules(): Promise<boolean> {
      try {
        const rules = readPromptTemplate("claude_global_rules.md");
        const rulesPath = resolve(homedir(), ".claude", "rules", "talkto.md");
        writeFileSafe(rulesPath, rules);
        ok(`Rules installed → ${c.dim}~/.claude/rules/talkto.md${c.reset}`);
        return true;
      } catch (e) {
        fail(`Rules install failed: ${(e as Error).message}`);
        return false;
      }
    },
  };
}

// ── OpenCode ────────────────────────────────────────────────────

async function configureOpenCode(): Promise<Provider> {
  const cli = "opencode";
  const path = await commandExists(cli);
  const version = path ? await detectVersion(cli) : null;

  const configPath = resolve(
    homedir(),
    ".config",
    "opencode",
    "opencode.json"
  );

  return {
    id: "opencode",
    name: "OpenCode",
    cli,
    detected: !!path,
    version,

    async configMcp(): Promise<boolean> {
      try {
        // Read existing config or create new one
        let existing: Record<string, unknown> = {};
        if (existsSync(configPath)) {
          try {
            existing = JSON.parse(readFileSync(configPath, "utf-8"));
          } catch {
            // Corrupt file — start fresh but warn
            warn("Existing opencode.json was malformed, recreating");
          }
        }

        // Merge talkto MCP entry into existing config
        const mcp =
          (existing.mcp as Record<string, unknown> | undefined) ?? {};
        mcp.talkto = {
          type: "remote",
          url: config.mcpUrl,
        };
        existing.mcp = mcp;

        // Preserve schema ref
        if (!existing.$schema) {
          existing.$schema = "https://opencode.ai/config.json";
        }

        writeFileSafe(configPath, JSON.stringify(existing, null, 2) + "\n");
        ok(
          `MCP server added → ${c.dim}~/.config/opencode/opencode.json${c.reset}`
        );
        return true;
      } catch (e) {
        fail(`MCP config failed: ${(e as Error).message}`);
        return false;
      }
    },

    async installRules(): Promise<boolean> {
      try {
        const rules = readPromptTemplate("opencode_global_rules.md");
        const rulesPath = resolve(
          homedir(),
          ".config",
          "opencode",
          "AGENTS.md"
        );
        writeFileSafe(rulesPath, rules);
        ok(
          `Rules installed → ${c.dim}~/.config/opencode/AGENTS.md${c.reset}`
        );
        return true;
      } catch (e) {
        fail(`Rules install failed: ${(e as Error).message}`);
        return false;
      }
    },
  };
}

// ── Codex CLI ───────────────────────────────────────────────────

async function configureCodex(): Promise<Provider> {
  const cli = "codex";
  const path = await commandExists(cli);
  const version = path ? await detectVersion(cli) : null;

  const configPath = resolve(homedir(), ".codex", "config.toml");

  return {
    id: "codex",
    name: "Codex CLI",
    cli,
    detected: !!path,
    version,

    async configMcp(): Promise<boolean> {
      try {
        let content = "";
        if (existsSync(configPath)) {
          content = readFileSync(configPath, "utf-8");
        }

        // Check if talkto MCP section already exists
        const sectionRegex =
          /\[mcp_servers\.talkto\]\s*\n(?:.*\n)*?(?=\[|$)/;
        const newSection = `[mcp_servers.talkto]\nurl = "${config.mcpUrl}"\n`;

        if (sectionRegex.test(content)) {
          // Replace existing section
          content = content.replace(sectionRegex, newSection + "\n");
        } else {
          // Append new section
          content =
            content.trimEnd() + (content.length > 0 ? "\n\n" : "") + newSection;
        }

        writeFileSafe(configPath, content);
        ok(`MCP server added → ${c.dim}~/.codex/config.toml${c.reset}`);
        return true;
      } catch (e) {
        fail(`MCP config failed: ${(e as Error).message}`);
        return false;
      }
    },

    async installRules(): Promise<boolean> {
      try {
        const rules = readPromptTemplate("codex_global_rules.md");
        const rulesPath = resolve(homedir(), ".codex", "AGENTS.md");
        writeFileSafe(rulesPath, rules);
        ok(`Rules installed → ${c.dim}~/.codex/AGENTS.md${c.reset}`);
        return true;
      } catch (e) {
        fail(`Rules install failed: ${(e as Error).message}`);
        return false;
      }
    },
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log(
    `${c.bold}╭──────────────────────────────────────╮${c.reset}`
  );
  console.log(
    `${c.bold}│  TalkTo Setup                        │${c.reset}`
  );
  console.log(
    `${c.bold}│  Configure AI agent providers        │${c.reset}`
  );
  console.log(
    `${c.bold}╰──────────────────────────────────────╯${c.reset}`
  );

  // Detect providers
  heading("Detecting providers...");
  const providers = await Promise.all([
    configureClaude(),
    configureOpenCode(),
    configureCodex(),
  ]);

  const detected = providers.filter((p) => p.detected);
  const notDetected = providers.filter((p) => !p.detected);

  for (const p of detected) {
    const ver = p.version ? ` ${c.dim}(${p.version})${c.reset}` : "";
    console.log(`  ${c.green}●${c.reset} ${p.name}${ver}`);
  }
  for (const p of notDetected) {
    console.log(`  ${c.gray}○ ${p.name} (not installed)${c.reset}`);
  }

  if (detected.length === 0) {
    console.log(
      `\n${c.yellow}No supported providers found.${c.reset}`
    );
    console.log(
      `Install one of: ${c.bold}claude${c.reset}, ${c.bold}opencode${c.reset}, or ${c.bold}codex${c.reset}`
    );
    process.exit(1);
  }

  // Ask which to configure
  heading("Select providers to configure");
  console.log("");

  const selected: Provider[] = [];

  for (const p of detected) {
    const answer = await prompt(
      `  Configure ${c.bold}${p.name}${c.reset}? [Y/n]`
    );
    if (answer === "" || answer.toLowerCase().startsWith("y")) {
      selected.push(p);
    }
  }

  if (selected.length === 0) {
    console.log(`\n${c.dim}Nothing to configure.${c.reset}`);
    process.exit(0);
  }

  // Configure each selected provider
  const mcpUrl = config.mcpUrl;
  info(`MCP endpoint: ${mcpUrl}`);

  const results: { provider: string; mcp: boolean; rules: boolean }[] = [];

  for (const p of selected) {
    heading(`Configuring ${p.name}...`);
    const mcp = await p.configMcp();
    const rules = await p.installRules();
    results.push({ provider: p.name, mcp, rules });
  }

  // Summary
  heading("Summary");
  console.log("");

  let allGood = true;
  for (const r of results) {
    const status =
      r.mcp && r.rules
        ? `${c.green}✓${c.reset}`
        : `${c.yellow}partial${c.reset}`;
    console.log(`  ${status} ${r.provider}`);
    if (!r.mcp || !r.rules) allGood = false;
  }

  console.log("");
  if (allGood) {
    console.log(
      `${c.green}${c.bold}Done!${c.reset} Your AI agents will auto-connect to TalkTo.`
    );
  } else {
    console.log(
      `${c.yellow}Setup completed with warnings.${c.reset} Check the output above.`
    );
  }

  console.log(
    `${c.dim}Start TalkTo: bun run dev (from server/)${c.reset}`
  );
  console.log("");
}

main().catch((e) => {
  console.error(`\n${c.red}Setup failed:${c.reset}`, e.message);
  process.exit(1);
});
