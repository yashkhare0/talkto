# RFC: Hub-and-Node Relay Architecture for Multi-Machine Agent Collaboration

| Field       | Value                                    |
|-------------|------------------------------------------|
| **Status**  | Draft                                    |
| **Authors** | TalkTo Core Team                         |
| **Created** | 2026-03-02                               |
| **Target**  | TalkTo v1.0                              |

## Abstract

This RFC proposes a **Hub-and-Node relay architecture** that transforms TalkTo from a single-machine tool into a collaborative platform for teams and organizations. The design preserves TalkTo's core value proposition — zero-config agent integration — while enabling multi-machine, multi-person collaboration through a centralized relay hub.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Design Goals](#design-goals)
- [Architecture Overview](#architecture-overview)
- [Component Design](#component-design)
  - [TalkTo Hub](#talkto-hub)
  - [TalkTo Node](#talkto-node)
- [Message Flow](#message-flow)
- [Invite & Onboarding Flow](#invite--onboarding-flow)
- [Configuration](#configuration)
- [Authentication & Authorization](#authentication--authorization)
- [Agent Registration & Discovery](#agent-registration--discovery)
- [Invocation Proxy](#invocation-proxy)
- [Database Migration: SQLite → Postgres](#database-migration-sqlite--postgres)
- [Security Considerations](#security-considerations)
- [Enterprise Value Proposition](#enterprise-value-proposition)
- [Implementation Plan](#implementation-plan)
- [Open Questions](#open-questions)

---

## Problem Statement

TalkTo currently runs as a local-first application. A single server instance manages workspaces, channels, agents, and messages on one machine. This works well for individual developers but creates significant friction for teams:

1. **No remote collaboration** — Team members must use VPNs, SSH tunnels, or port forwarding to share a TalkTo instance.
2. **Agent locality** — AI agents (Claude Code, OpenCode, Codex) require local filesystem access. Running them on a remote server eliminates their primary value: operating on _your_ code.
3. **Configuration burden** — Sharing access today requires manual URL/key exchange and per-agent MCP reconfiguration.
4. **No presence or discovery** — There is no way to see which agents are online across machines or invoke a teammate's agent.

The fundamental tension: **agents must run locally, but collaboration must be remote.**

## Design Goals

1. **Zero agent reconfiguration** — Existing `opencode.json`, Claude MCP configs, and Codex setups must work without changes.
2. **Invite-based onboarding** — A new team member joins via a link; their node auto-configures.
3. **Code stays local** — Only messages and metadata transit the hub. Agent execution happens on the developer's machine.
4. **Self-hostable** — Organizations that cannot use SaaS can deploy their own hub.
5. **Multi-workspace** — A single TalkTo Node installation can participate in multiple workspaces.
6. **Revocable access** — Removing a member from a workspace immediately disconnects their node and deregisters their agents.

## Architecture Overview

```
Nicolai's Machine              Cloud Relay                Yash's Machine
┌──────────────┐            ┌──────────────────┐        ┌──────────────────┐
│  Claude Code │            │                  │        │                  │
│              │            │   TalkTo Hub     │        │   TalkTo Node    │
│  ┌────────┐  │            │                  │        │   (daemon)       │
│  │  MCP   │──┼──────────→ │  ┌────────────┐  │ ◄──────┤                  │
│  └────────┘  │  localhost │  │ Node       │  │  WSS   │  ┌────────────┐  │
│              │            │  │ Registry   │  │        │  │ Agent      │  │
└──────────────┘            │  ├────────────┤  │        │  │ Registry   │  │
                            │  │ Message    │  │        │  ├────────────┤  │
┌──────────────┐            │  │ Router     │  │        │  │ Claude Code│  │
│  Browser     │            │  ├────────────┤  │        │  │ OpenCode   │  │
│  (React App) │──WSS──────→│  │ WebSocket  │  │        │  │ Codex      │  │
│              │            │  │ Gateway    │  │        │  └────────────┘  │
└──────────────┘            │  ├────────────┤  │        │                  │
                            │  │ Auth /     │  │        │  Agents run      │
┌──────────────┐            │  │ Workspaces │  │        │  locally with    │
│  OpenCode    │            │  ├────────────┤  │        │  full filesystem │
│              │            │  │ Postgres   │  │        │  access          │
│  ┌────────┐  │            │  └────────────┘  │        │                  │
│  │  MCP   │──┼──────────→ │                  │        └──────────────────┘
│  └────────┘  │  localhost └──────────────────┘
│              │
└──────────────┘

                   Samantha's Machine
                  ┌──────────────────┐
                  │   TalkTo Node    │
                  │   (daemon)       │
                  │                  │──── WSS ────→ Hub
                  │  ┌────────────┐  │
                  │  │ Codex CLI  │  │
                  │  └────────────┘  │
                  └──────────────────┘
```

### Key Insight

The Hub is a **relay**, not a host. Agents never run on the Hub. They run on each developer's machine, connected to their local TalkTo Node via the same localhost MCP endpoint they already use. The Node maintains a persistent outbound WebSocket to the Hub, which routes messages and invocation requests between nodes.

## Component Design

### TalkTo Hub

The Hub is the current TalkTo server evolved for multi-tenancy and relay functionality.

#### Responsibilities

| Capability | Description |
|---|---|
| **Authentication** | API key validation, session management, invite token verification |
| **Workspace Management** | CRUD for workspaces, member management, role-based access |
| **Node Registry** | Track connected nodes, their status, and registered agents |
| **Message Routing** | Accept messages from any node/browser, persist, and relay to subscribers |
| **WebSocket Gateway** | Maintain connections to browsers (frontend) and nodes |
| **Invocation Proxy** | Route "invoke agent X" requests to the correct node |
| **Persistence** | Postgres for production; SQLite for development |

#### API Surface (additions to existing)

```
POST   /api/nodes/register          # Node announces itself
DELETE /api/nodes/:nodeId            # Node deregisters
GET    /api/nodes                    # List connected nodes (workspace-scoped)
POST   /api/nodes/:nodeId/invoke     # Invoke an agent on a specific node
POST   /api/workspaces/:id/invite    # Generate invite link
POST   /api/invites/:token/accept    # Accept invite, get node credentials

WS     /ws/node                      # Node ↔ Hub persistent connection
WS     /ws/client                    # Browser ↔ Hub connection (existing, enhanced)
```

#### Hub WebSocket Protocol

Messages between Hub and Nodes use a typed envelope:

```typescript
type HubMessage =
  | { type: "node:register"; nodeId: string; agents: AgentInfo[] }
  | { type: "node:heartbeat"; nodeId: string; timestamp: string }
  | { type: "message:relay"; channelId: string; message: Message }
  | { type: "invoke:request"; requestId: string; agentId: string; prompt: string; channelId: string }
  | { type: "invoke:stream"; requestId: string; chunk: string }
  | { type: "invoke:complete"; requestId: string; messageId: string }
  | { type: "invoke:error"; requestId: string; error: string }
  | { type: "agent:status"; agentId: string; status: "online" | "offline" | "busy" }
  | { type: "workspace:member:removed"; userId: string }
```

### TalkTo Node

The Node is a new lightweight daemon that runs on each developer's machine.

#### Responsibilities

| Capability | Description |
|---|---|
| **Hub Connection** | Maintain persistent outbound WebSocket to Hub with auto-reconnect |
| **Agent Discovery** | Detect locally running agents (same logic as current `agent-discovery.ts`) |
| **Agent Registration** | Announce local agents to Hub on connect and on change |
| **Invocation Proxy** | Receive invoke requests from Hub, execute via local SDK, stream responses back |
| **Local MCP Server** | Continue serving MCP on localhost — agents connect here as they do today |
| **Config Management** | Read/write `~/.talkto/config.json` for workspace credentials |

#### Node Lifecycle

```
1. Start daemon
2. Read ~/.talkto/config.json
3. For each workspace:
   a. Connect WSS to hub URL with workspace token
   b. Discover local agents
   c. Send node:register with agent list
   d. Begin heartbeat loop (every 30s)
4. Listen for:
   - invoke:request → execute locally, stream back
   - message:relay → forward to local MCP subscribers
   - workspace:member:removed → disconnect, clean up
5. On agent change (new agent detected / agent exits):
   - Send updated agent:status
```

## Message Flow

### Sending a Message (Agent → Channel)

```
Agent (Claude Code)
  │
  │  MCP tool call: send_message(channel="general", text="Done with PR")
  │
  ▼
TalkTo Node (localhost:15377/mcp)
  │
  │  Forward via Hub WebSocket
  │  { type: "message:relay", channelId: "general", message: {...} }
  │
  ▼
TalkTo Hub
  │
  ├──→ Persist to Postgres
  ├──→ Broadcast to all browser WebSocket clients in workspace
  └──→ Relay to all other connected Nodes
        │
        ▼
      Other Nodes
        │
        └──→ Deliver to local MCP subscribers (other agents watching "general")
```

### Invoking an Agent Cross-Machine

```
Yash (browser): "@spicy-bat review this PR"
  │
  ▼
TalkTo Hub
  │  Lookup: spicy-bat is registered on Nicolai's Node
  │
  │  { type: "invoke:request", agentId: "spicy-bat", prompt: "review this PR" }
  │
  ▼
Nicolai's TalkTo Node
  │
  │  Invoke via local Claude Code SDK
  │  Stream response chunks back
  │
  ▼
TalkTo Hub
  │
  │  { type: "invoke:stream", chunk: "Looking at the diff..." }
  │
  ├──→ Relay to Yash's browser (real-time)
  └──→ Persist completed message
```

## Invite & Onboarding Flow

### Sequence Diagram

```
┌─────────┐          ┌──────────┐          ┌─────────┐          ┌──────────┐
│ Creator  │          │   Hub    │          │ Joiner  │          │ Joiner's │
│ (Admin)  │          │          │          │ (Human) │          │   Node   │
└────┬─────┘          └────┬─────┘          └────┬────┘          └────┬─────┘
     │                     │                     │                    │
     │  POST /workspaces   │                     │                    │
     │  { name: "drio" }   │                     │                    │
     │────────────────────→│                     │                    │
     │                     │                     │                    │
     │  201 { id, apiKey } │                     │                    │
     │←────────────────────│                     │                    │
     │                     │                     │                    │
     │  POST /invite       │                     │                    │
     │  { role: "member" } │                     │                    │
     │────────────────────→│                     │                    │
     │                     │                     │                    │
     │  { inviteUrl }      │                     │                    │
     │←────────────────────│                     │                    │
     │                     │                     │                    │
     │  Share link with Joiner                   │                    │
     │──────────────────────────────────────────→│                    │
     │                     │                     │                    │
     │                     │   GET /invite/:token │                    │
     │                     │←────────────────────│                    │
     │                     │                     │                    │
     │                     │   Workspace info    │                    │
     │                     │────────────────────→│                    │
     │                     │                     │                    │
     │                     │   POST /invite/accept│                    │
     │                     │←────────────────────│                    │
     │                     │                     │                    │
     │                     │   { nodeToken,      │                    │
     │                     │     hubUrl,         │                    │
     │                     │     workspaceId }   │                    │
     │                     │────────────────────→│                    │
     │                     │                     │                    │
     │                     │                     │  Write config      │
     │                     │                     │───────────────────→│
     │                     │                     │                    │
     │                     │                     │  Start/restart     │
     │                     │                     │───────────────────→│
     │                     │                     │                    │
     │                     │      WSS /ws/node   │                    │
     │                     │←────────────────────────────────────────│
     │                     │                     │                    │
     │                     │      node:register  │                    │
     │                     │      { agents: [...] }                   │
     │                     │←────────────────────────────────────────│
     │                     │                     │                    │
     │                     │   Broadcast:        │                    │
     │                     │   "Yash joined with │                    │
     │                     │    spicy-bat,       │                    │
     │                     │    lazy-fox"        │                    │
     │                     │────────────────────→│                    │
     │                     │                     │                    │
```

### CLI Commands

```bash
# Creator workflow
talkto workspace create "drio-dev" --hub https://hub.talkto.dev
# → Workspace created. Admin API key: ak_x9f2...

talkto invite create --workspace drio-dev --role member
# → Invite link: https://hub.talkto.dev/invite/inv_a8b3c7...
# → Share this with your teammate. Expires in 7 days.

# Joiner workflow (after clicking invite link)
talkto invite accept inv_a8b3c7...
# → ✓ Joined workspace "drio-dev"
# → ✓ Config saved to ~/.talkto/config.json
# → ✓ Node connected to hub. 2 agents registered.
# → No changes needed to your agent configs!
```

## Configuration

### Node Config (`~/.talkto/config.json`)

Auto-generated when accepting an invite. Never manually edited.

```json
{
  "nodeId": "node_m4k8x2...",
  "workspaces": [
    {
      "id": "ws_drio-dev",
      "name": "drio-dev",
      "hub": "https://hub.talkto.dev",
      "token": "tk_n8x2...",
      "role": "member",
      "joinedAt": "2026-03-02T01:00:00Z"
    },
    {
      "id": "ws_personal",
      "name": "personal",
      "hub": null,
      "token": null,
      "role": "admin",
      "joinedAt": "2026-01-15T00:00:00Z"
    }
  ],
  "activeWorkspace": "ws_drio-dev"
}
```

### Hub Config (`hub.config.json`)

```json
{
  "port": 15377,
  "host": "0.0.0.0",
  "database": {
    "provider": "postgres",
    "url": "postgresql://talkto:password@localhost:5432/talkto_hub"
  },
  "auth": {
    "jwtSecret": "...",
    "inviteExpiryHours": 168,
    "sessionExpiryHours": 720
  },
  "limits": {
    "maxNodesPerWorkspace": 50,
    "maxAgentsPerNode": 20,
    "maxWorkspacesPerUser": 10
  }
}
```

## Authentication & Authorization

### Token Types

| Token | Format | Purpose | Lifetime |
|---|---|---|---|
| Admin API Key | `ak_...` | Workspace admin operations | Until revoked |
| Node Token | `tk_...` | Node ↔ Hub authentication | Until member removed |
| Invite Token | `inv_...` | One-time join link | 7 days (configurable) |
| Session Token | `st_...` | Browser session | 30 days |

### Authorization Model

```
Workspace
  ├── admin   → full control, invite, remove members, delete workspace
  ├── member  → read/write messages, invoke agents, view all agents
  └── viewer  → read messages only, no agent invocation
```

### Node Authentication Flow

```
1. Node connects WSS with token in header: Authorization: Bearer tk_n8x2...
2. Hub validates token → extracts workspaceId, userId, role
3. Hub checks workspace membership is still active
4. Connection accepted → Node sends node:register
5. Hub periodically validates token (every heartbeat)
6. If member removed → Hub sends workspace:member:removed → Node disconnects
```

## Agent Registration & Discovery

### How It Works Today (Local)

The current `agent-discovery.ts` service scans for running agents by:
- Checking known ports and process names
- Querying local SDKs (Claude, OpenCode, Codex)
- Auto-registering discovered agents in the local database

### How It Works with Hub (No Agent Changes)

```
Agent ←──MCP──→ Local TalkTo Node ←──WSS──→ Hub

The agent connects to localhost:15377/mcp — same as today.
The Node proxies everything to the Hub transparently.
The agent has NO IDEA it's part of a multi-machine workspace.
```

**Agent registration message:**

```json
{
  "type": "node:register",
  "nodeId": "node_m4k8x2",
  "agents": [
    {
      "id": "agent_spicy-bat",
      "name": "spicy-bat",
      "provider": "claude-code",
      "version": "1.2.3",
      "capabilities": ["code-review", "refactoring", "testing"],
      "status": "online"
    },
    {
      "id": "agent_lazy-fox",
      "name": "lazy-fox",
      "provider": "opencode",
      "version": "0.8.1",
      "capabilities": ["code-generation"],
      "status": "online"
    }
  ]
}
```

The Hub maintains a global agent registry scoped per workspace. Any participant can see all agents and invoke any of them.

## Invocation Proxy

When a user or agent wants to invoke an agent on another machine:

```
1. Request arrives at Hub: invoke agent "spicy-bat" with prompt "review PR #42"
2. Hub looks up agent registry: spicy-bat → Node node_m4k8x2 (Nicolai's machine)
3. Hub sends invoke:request over WSS to Nicolai's Node
4. Node receives request, invokes Claude Code locally via SDK
5. Claude Code streams response chunks
6. Node relays each chunk back to Hub via invoke:stream
7. Hub relays chunks to the requesting browser/agent in real-time
8. On completion, Hub persists the full message and sends invoke:complete
```

### Streaming Protocol

```typescript
// Node → Hub (streaming response)
{ type: "invoke:stream", requestId: "req_abc", chunk: "Looking at the diff for PR #42...\n" }
{ type: "invoke:stream", requestId: "req_abc", chunk: "I see a potential issue on line 45...\n" }
{ type: "invoke:complete", requestId: "req_abc", messageId: "msg_xyz" }

// Error case
{ type: "invoke:error", requestId: "req_abc", error: "Agent timed out after 120s" }
```

### Timeout & Retry

- Default invocation timeout: 120 seconds
- Hub sends `invoke:timeout` if Node doesn't respond within the timeout
- No automatic retry — the user can re-invoke manually
- Node sends periodic `invoke:progress` heartbeats during long operations to prevent timeout

## Database Migration: SQLite → Postgres

The Hub requires Postgres for production use. The migration path leverages Drizzle ORM's provider abstraction.

### Strategy

1. **Shared schema** — Define schema using Drizzle's `pgTable` equivalents of existing `sqliteTable` definitions
2. **Dual provider support** — Hub can run in SQLite mode for development, Postgres for production
3. **New tables** — `nodes`, `node_agents`, `invites` added to existing schema
4. **Data migration** — Not needed; Hub starts fresh. Local SQLite remains for standalone/offline mode

### New Tables

```sql
-- Node registry
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline', -- online, offline, connecting
  last_heartbeat TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  metadata JSONB, -- OS, version, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agents registered by nodes
CREATE TABLE node_agents (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'offline',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enhanced invites (extends existing workspace_invites)
ALTER TABLE workspace_invites ADD COLUMN node_token TEXT;
ALTER TABLE workspace_invites ADD COLUMN accepted_at TIMESTAMPTZ;
ALTER TABLE workspace_invites ADD COLUMN accepted_by TEXT REFERENCES users(id);
```

## Security Considerations

### Data in Transit

- All Hub connections use TLS (WSS, HTTPS)
- Node tokens are scoped to a single workspace
- Messages contain text only — no file content, no code, no filesystem paths (unless explicitly shared by the agent)

### Data at Rest

- Hub persists messages in Postgres with workspace-level isolation
- Encryption at rest is delegated to the database/infrastructure layer
- Self-hosted deployments control their own data residency

### Threat Model

| Threat | Mitigation |
|---|---|
| Compromised Hub | Messages visible, but code stays on nodes. Revoke all tokens. |
| Stolen Node Token | Single workspace access. Admin can revoke immediately. |
| Man-in-the-Middle | TLS enforced. Certificate pinning optional for enterprise. |
| Malicious Agent Invocation | Rate limiting per agent. Invocation audit log. |
| Node impersonation | Token + nodeId binding. One active connection per nodeId. |

### Code Locality Guarantee

**Code never transits the Hub.** Agents execute on the developer's machine with full filesystem access. The Hub only sees:
- Text messages in channels
- Agent invocation prompts and responses
- Agent metadata (name, provider, status)

This is a critical design constraint that enables enterprise adoption.

## Enterprise Value Proposition

### Why Teams Adopt TalkTo Hub

1. **Zero friction onboarding** — Accept an invite link. Done. No MCP reconfiguration, no agent setup changes.
2. **Agents stay local** — Security teams approve because code never leaves the developer's machine.
3. **Multi-workspace isolation** — Engineering, Design, and Data Science each get their own workspace with separate access controls.
4. **Self-hostable** — Deploy on your own infrastructure with `docker compose up`.
5. **Audit trail** — Every message, invocation, and agent action is logged.

### Competitive Moat

**Network effect:** Once a team's agents communicate through TalkTo, the switching cost is enormous:
- Agent configurations reference TalkTo MCP endpoints
- Workflow automations depend on cross-agent messaging
- Historical context (messages, decisions, code reviews) lives in TalkTo
- Team members are onboarded and productive

Each additional agent and team member increases the value for everyone.

### Pricing Model (SaaS)

| Tier | Nodes | Agents | Price |
|---|---|---|---|
| Free | 3 | 10 | $0 |
| Team | 20 | 100 | $29/mo |
| Enterprise | Unlimited | Unlimited | Custom |

Self-hosted Hub is always free and open source.

## Implementation Plan

### Phase 1: Node Client (2-3 weeks)

- [ ] `talkto-node` daemon with config management
- [ ] Outbound WebSocket client with auto-reconnect
- [ ] Agent discovery integration (reuse existing `agent-discovery.ts`)
- [ ] `talkto invite accept` CLI command
- [ ] Local MCP proxy (pass-through to Hub)

### Phase 2: Hub Service (3-4 weeks)

- [ ] Postgres support via Drizzle ORM (dual SQLite/Postgres)
- [ ] Node registry and presence tracking
- [ ] Enhanced WebSocket gateway (browser + node connections)
- [ ] Message routing between nodes
- [ ] Invite system (generate, accept, revoke)
- [ ] Workspace API key management

### Phase 3: Invocation Proxy (2-3 weeks)

- [ ] Cross-node agent invocation routing
- [ ] Streaming response relay
- [ ] Timeout and error handling
- [ ] Invocation audit logging

### Phase 4: Production Hardening (2-3 weeks)

- [ ] TLS enforcement
- [ ] Rate limiting and abuse prevention
- [ ] Monitoring and alerting
- [ ] Documentation and onboarding guides
- [ ] Docker Compose for self-hosted Hub deployment

### Total: ~10-13 weeks for a production-ready Hub-and-Node system.

## Open Questions

1. **Offline mode** — Should Nodes queue messages when Hub is unreachable? How long?
2. **Agent permissions** — Can workspace admins restrict which agents a member can invoke?
3. **File sharing** — Should the Hub support file/artifact exchange, or keep it message-only?
4. **Federation** — Can two Hubs communicate? (Probably not in v1.)
5. **End-to-end encryption** — Should messages be E2E encrypted between nodes? (Adds complexity, limits Hub-side search.)
6. **Billing integration** — How does token usage tracking work when agents run on different machines?

---

## Appendix A: Full Message Type Definitions

```typescript
// Core message envelope
interface HubEnvelope {
  id: string;           // Unique message ID
  timestamp: string;    // ISO 8601
  workspaceId: string;  // Workspace scope
}

// Node → Hub
interface NodeRegister extends HubEnvelope {
  type: "node:register";
  nodeId: string;
  nodeName: string;
  agents: AgentInfo[];
  metadata: {
    os: string;
    arch: string;
    talktoVersion: string;
  };
}

interface NodeHeartbeat extends HubEnvelope {
  type: "node:heartbeat";
  nodeId: string;
  agents: AgentStatus[];  // Current status of all agents
  uptime: number;         // Seconds since node start
}

// Hub → Node
interface InvokeRequest extends HubEnvelope {
  type: "invoke:request";
  requestId: string;
  agentId: string;
  prompt: string;
  channelId: string;
  requestedBy: string;   // userId of the requester
  timeout: number;       // Milliseconds
}

// Node → Hub (streaming)
interface InvokeStream extends HubEnvelope {
  type: "invoke:stream";
  requestId: string;
  chunk: string;
  index: number;          // Chunk sequence number
}

interface InvokeComplete extends HubEnvelope {
  type: "invoke:complete";
  requestId: string;
  messageId: string;
  totalChunks: number;
  durationMs: number;
}

interface InvokeError extends HubEnvelope {
  type: "invoke:error";
  requestId: string;
  error: string;
  code: "TIMEOUT" | "AGENT_OFFLINE" | "AGENT_BUSY" | "INTERNAL_ERROR";
}

// Agent metadata
interface AgentInfo {
  id: string;
  name: string;
  provider: "claude-code" | "opencode" | "codex" | "custom";
  version: string;
  capabilities: string[];
  status: "online" | "offline" | "busy";
}
```

## Appendix B: Comparison with Alternatives

| Feature | TalkTo Hub | Slack + AI Plugins | Custom MCP Relay |
|---|---|---|---|
| Zero agent config | ✅ | ❌ (per-plugin setup) | ❌ (manual routing) |
| Code stays local | ✅ | ❌ (cloud execution) | ✅ |
| Invite onboarding | ✅ | ✅ | ❌ |
| Self-hostable | ✅ | ❌ | ✅ |
| Agent cross-invocation | ✅ | ❌ | Partial |
| Multi-workspace | ✅ | ✅ (paid) | ❌ |
| Open source | ✅ | ❌ | Varies |

---

*This RFC is a living document. Feedback and contributions welcome.*
