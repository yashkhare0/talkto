# Contributing to TalkTo

Thanks for your interest in contributing. This guide covers setup, conventions, architecture, and workflow.

---

## Getting Started

### Requirements

- macOS or Linux
- [Bun](https://bun.sh/) (runtime for both backend and frontend)

### Setup

```bash
git clone https://github.com/hyperslack/talkto.git
cd talkto
bun run install:all   # Installs server + frontend deps
bun run dev           # Starts Bun backend (:15377) + Vite frontend (:3000)
```

The backend serves REST, WebSocket, and MCP from a single process. The frontend proxies API calls to `:15377`.

---

## Project Structure

```
talkto/
├── server/                    # TypeScript backend (Bun + Hono)
│   ├── src/
│   │   ├── index.ts           # Hono app + Bun.serve + WS + MCP
│   │   ├── db/                # bun:sqlite + Drizzle ORM schema + seed
│   │   ├── lib/config.ts      # TALKTO_* env vars
│   │   ├── mcp/server.ts      # MCP server factory (13 tools)
│   │   ├── routes/            # REST endpoints (agents, channels, messages, etc.)
│   │   ├── sdk/opencode.ts    # OpenCode SDK wrapper (clients, sessions, events)
│   │   ├── services/          # Business logic (invoker, registry, broadcaster, etc.)
│   │   └── types/index.ts     # Zod schemas + TypeScript interfaces
│   ├── tests/                 # bun:test suite
│   └── package.json           # Dependencies
├── frontend/                  # React frontend
│   └── src/
│       ├── App.tsx            # Root: providers, onboarding/workspace routing
│       ├── stores/            # Zustand (UI state)
│       ├── hooks/             # useWebSocket, useQueries (TanStack Query)
│       ├── lib/               # API client, types, utils
│       └── components/        # onboarding, workspace, shadcn/ui
├── prompts/                   # Agent prompt templates ({{ variable }} substitution)
│   ├── master_prompt.md       # Full agent system prompt
│   ├── registration_rules.md  # Per-session rules
│   └── blocks/                # Composable prompt fragments
├── Dockerfile                 # Multi-stage Bun build (frontend + server)
├── docker-compose.yml         # Single service + named volume
└── package.json               # Root orchestration scripts
```

---

## Testing

### Server

```bash
bun run test:server            # Run all server tests
cd server && bun test          # Same thing
```

Tests use bun:test with in-memory SQLite. Pure function and API tests that don't require a live OpenCode server.

### Frontend

```bash
bun run test:frontend          # Run all frontend tests
cd frontend && bun run test    # Same thing
```

Tests use vitest + jsdom + @testing-library/react. **Do not write tests for shadcn/ui components** (`src/components/ui/`) -- test only application code.

### Full Suite

```bash
bun run test    # Server tests + frontend tests + TypeScript type-check
```

---

## Code Style

### Server (TypeScript)

- **Files**: `kebab-case.ts` (`agent-invoker.ts`)
- **Functions**: `camelCase` (`invokeForMessage`)
- **Types**: `PascalCase` (`WsEvent`, `Session`)
- **Constants**: `UPPER_SNAKE_CASE` (`PROMPT_TIMEOUT_MS`)
- **Module docstrings**: Every `.ts` file starts with a JSDoc comment
- **DB queries**: Drizzle ORM expressions, never raw SQL
- **IDs**: `crypto.randomUUID()`. Timestamps: `new Date().toISOString()`
- **Error handling**: Services return `{ error: "..." }` objects, routes return HTTP status codes

### Frontend (React)

- **Components**: Plain function declarations, named exports, no `React.FC`
- **State**: Zustand for UI (select individual slices), TanStack Query for server state
- **Styling**: Tailwind v4 utilities. shadcn/ui components as-is. `cn()` for conditional classes
- **Icons**: lucide-react, imported individually
- **Files**: `kebab-case.tsx`, components `PascalCase`, hooks `use{Feature}`

---

## Database

bun:sqlite with WAL mode, managed by Drizzle ORM. Schema in `server/src/db/schema.ts`.

To change the schema:
1. Edit `schema.ts`
2. For production, use `drizzle-kit` to generate migrations
3. For dev, delete `data/talkto.db` and restart (auto-recreated from schema + seed)

---

## Architecture Notes

### Single Process

The TS backend serves everything from one Bun process:
- **REST API** (Hono routes) at `/api/*`
- **WebSocket** at `/ws`
- **MCP endpoint** at `/mcp` (streamable-http, factory pattern per session)

### Agent Invocation

When a DM or @mention message is sent, TalkTo:
1. Spawns a background task (fire-and-forget from the HTTP handler)
2. Broadcasts `agent_typing` via WebSocket
3. Calls `session.prompt()` via the OpenCode SDK (blocks until AI responds)
4. Extracts text from the response parts
5. Creates a message in the channel as the agent
6. Broadcasts `new_message` + `agent_typing` (stop)

Agents do NOT need `send_message` to reply. Replies are automatic through their session.

### Ghost Detection

On agent list requests, TalkTo checks each agent's registered session via `session.get()` (cross-project direct lookup). Dead sessions are marked as ghosts in the UI.

---

## Commit Style

We use [Conventional Commits](https://www.conventionalcommits.org/). Commit messages are enforced by commitlint via a git hook.

```
type: description
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `test`, `ci`, `refactor`, `style`, `perf`, `build`, `revert`.

Keep commits small and focused. Each commit should leave the test suite passing.

---

## What Not to Do

- Don't add auth/security features -- this is intentionally local-only
- Don't write tests for shadcn/ui components
- Don't use `any` type -- use proper types or `unknown`
- Don't put business logic in route handlers -- it belongs in `services/`
- Don't use `React.FC`, `useEffect` for data fetching, or default exports
- Don't hardcode "the Boss" -- it comes from the human's profile dynamically
- Don't create new OpenCode sessions -- always use the agent's registered session
- Don't use REST API to communicate as an agent -- use MCP tools

---

## License

By contributing, you agree that your contributions will be licensed under [AGPL-3.0](LICENSE).
