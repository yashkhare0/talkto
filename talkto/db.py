"""SQLite database layer for TalkTo."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from .log import logger
from .models import Agent, Message, FeatureRequest, DirectQueueEntry

# Resolve DB path relative to project root
_DB_DIR = Path(__file__).resolve().parent.parent / "data"
_DB_DIR.mkdir(exist_ok=True)
DB_PATH = os.environ.get("TALKTO_DB_PATH", str(_DB_DIR / "talkto.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL,
    bio TEXT NOT NULL,
    personality TEXT NOT NULL,
    gender TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    content TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'chat',
    mentions TEXT NOT NULL DEFAULT '[]',
    project_tag TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_agent_name ON messages(agent_name);
CREATE INDEX IF NOT EXISTS idx_messages_project_tag ON messages(project_tag);

CREATE TABLE IF NOT EXISTS feature_requests (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    project TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    vote_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (agent_name) REFERENCES agents(name)
);

CREATE TABLE IF NOT EXISTS feature_request_votes (
    request_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (request_id, agent_name),
    FOREIGN KEY (request_id) REFERENCES feature_requests(id),
    FOREIGN KEY (agent_name) REFERENCES agents(name)
);

CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests(status);
CREATE INDEX IF NOT EXISTS idx_feature_requests_project ON feature_requests(project);
CREATE INDEX IF NOT EXISTS idx_feature_requests_vote_count ON feature_requests(vote_count DESC);

CREATE TABLE IF NOT EXISTS direct_queue (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    prompt TEXT NOT NULL,
    wrapped_prompt TEXT NOT NULL,
    chat_message_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    responded_at TEXT,
    response TEXT,
    FOREIGN KEY (from_agent) REFERENCES agents(name),
    FOREIGN KEY (to_agent) REFERENCES agents(name)
);

CREATE INDEX IF NOT EXISTS idx_direct_queue_to_agent ON direct_queue(to_agent);
CREATE INDEX IF NOT EXISTS idx_direct_queue_status ON direct_queue(status);
CREATE INDEX IF NOT EXISTS idx_direct_queue_created ON direct_queue(created_at);
"""


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create tables if they don't exist."""
    logger.info("Initializing database: {}", DB_PATH)
    conn = _get_conn()
    conn.executescript(SCHEMA)
    # Migrations: add columns if missing
    _migrate(conn)
    conn.close()
    logger.info("Database ready")


def _migrate(conn: sqlite3.Connection) -> None:
    """Add new columns to existing tables if they don't exist."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agents)").fetchall()}
    migrated = []
    if "cli_type" not in cols:
        conn.execute("ALTER TABLE agents ADD COLUMN cli_type TEXT")
        migrated.append("cli_type")
    if "session_id" not in cols:
        conn.execute("ALTER TABLE agents ADD COLUMN session_id TEXT")
        migrated.append("session_id")
    if "working_dir" not in cols:
        conn.execute("ALTER TABLE agents ADD COLUMN working_dir TEXT")
        migrated.append("working_dir")
    if "backend_session_id" not in cols:
        conn.execute("ALTER TABLE agents ADD COLUMN backend_session_id TEXT")
        migrated.append("backend_session_id")
    conn.commit()
    if migrated:
        logger.info("DB migration: added columns {}", migrated)


def _dt_to_str(dt: datetime) -> str:
    return dt.isoformat()


def _str_to_dt(s: str) -> datetime:
    return datetime.fromisoformat(s)


# ── Agents ───────────────────────────────────────────────────────────────────

def _row_to_agent(r: sqlite3.Row) -> Agent:
    """Convert a database row to an Agent model."""
    return Agent(
        id=r["id"],
        name=r["name"],
        project=r["project"],
        bio=r["bio"],
        personality=r["personality"],
        gender=r["gender"],
        cli_type=r["cli_type"],
        session_id=r["session_id"],
        working_dir=r["working_dir"],
        backend_session_id=r["backend_session_id"],
        registered_at=_str_to_dt(r["registered_at"]),
        last_seen=_str_to_dt(r["last_seen"]),
    )


def get_agent_by_name(name: str) -> Optional[Agent]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM agents WHERE name = ?", (name,)).fetchone()
    conn.close()
    if row is None:
        return None
    return _row_to_agent(row)


def get_agent_by_id(agent_id: str) -> Optional[Agent]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    return _row_to_agent(row)


def register_agent(agent: Agent) -> tuple[Agent, bool]:
    """Register or re-register an agent. Returns (agent, is_new)."""
    existing = get_agent_by_name(agent.name)
    conn = _get_conn()

    if existing:
        logger.info("Re-registering agent: {} (project={})", agent.name, agent.project)
        # Re-registration: update profile fields, cli fields, and last_seen
        conn.execute(
            """UPDATE agents SET project=?, bio=?, personality=?, gender=?,
               cli_type=?, session_id=?, working_dir=?, last_seen=?
               WHERE name=?""",
            (agent.project, agent.bio, agent.personality, agent.gender,
             agent.cli_type or existing.cli_type,
             agent.session_id or existing.session_id,
             agent.working_dir or existing.working_dir,
             _dt_to_str(agent.last_seen), agent.name),
        )
        conn.commit()
        conn.close()
        updated = get_agent_by_name(agent.name)
        return updated, False
    else:
        logger.info("New agent registered: {} (project={} cli={})", agent.name, agent.project, agent.cli_type)
        conn.execute(
            """INSERT INTO agents (id, name, project, bio, personality, gender,
               cli_type, session_id, working_dir, registered_at, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (agent.id, agent.name, agent.project, agent.bio, agent.personality,
             agent.gender, agent.cli_type, agent.session_id, agent.working_dir,
             _dt_to_str(agent.registered_at), _dt_to_str(agent.last_seen)),
        )
        conn.commit()
        conn.close()
        return agent, True


def list_agents(project: Optional[str] = None) -> list[Agent]:
    conn = _get_conn()
    if project:
        rows = conn.execute(
            "SELECT * FROM agents WHERE project LIKE ? ORDER BY registered_at",
            (f"%{project}%",),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM agents ORDER BY registered_at").fetchall()
    conn.close()
    return [_row_to_agent(r) for r in rows]


def update_agent_seen(agent_id: str) -> None:
    conn = _get_conn()
    conn.execute(
        "UPDATE agents SET last_seen=? WHERE id=?",
        (_dt_to_str(datetime.now(timezone.utc)), agent_id),
    )
    conn.commit()
    conn.close()


def update_agent_cli(
    name: str,
    cli_type: Optional[str] = None,
    session_id: Optional[str] = None,
    working_dir: Optional[str] = None,
) -> Optional[Agent]:
    """Update an agent's cli_type, session_id, and/or working_dir.

    Enforces session_id uniqueness: if another agent already holds this
    session_id, that agent's session_id is cleared (most recent wins).

    Returns updated agent or None if not found.
    """
    existing = get_agent_by_name(name)
    if not existing:
        return None

    conn = _get_conn()

    # Enforce session_id uniqueness - clear it from any other agent
    if session_id:
        cleared = conn.execute(
            "UPDATE agents SET session_id=NULL WHERE session_id=? AND name!=?",
            (session_id, name),
        ).rowcount
        if cleared:
            logger.info("Cleared session_id from {} other agent(s) (uniqueness enforcement)", cleared)

    conn.execute(
        "UPDATE agents SET cli_type=?, session_id=?, working_dir=? WHERE name=?",
        (cli_type, session_id, working_dir, name),
    )
    conn.commit()
    conn.close()
    logger.debug("Updated CLI config for {}: cli={} session={} dir={}", name, cli_type, session_id and (session_id[:12] + "..."), working_dir)
    return get_agent_by_name(name)


def update_agent_backend_session(name: str, backend_session_id: str) -> None:
    """Update the backend-managed session ID for an agent (e.g. OpenCode serve session)."""
    conn = _get_conn()
    conn.execute(
        "UPDATE agents SET backend_session_id=? WHERE name=?",
        (backend_session_id, name),
    )
    conn.commit()
    conn.close()
    logger.debug("Updated backend_session_id for {}: {}", name, backend_session_id[:16] + "..." if len(backend_session_id) > 16 else backend_session_id)


# ── Messages ─────────────────────────────────────────────────────────────────

def insert_message(msg: Message) -> Message:
    conn = _get_conn()
    cursor = conn.execute(
        """INSERT INTO messages (agent_id, agent_name, content, message_type, mentions, project_tag, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (msg.agent_id, msg.agent_name, msg.content, msg.message_type,
         json.dumps(msg.mentions), msg.project_tag, _dt_to_str(msg.created_at)),
    )
    msg.id = cursor.lastrowid
    conn.commit()
    conn.close()
    logger.info("Message #{} from {} [{}]: {}", msg.id, msg.agent_name, msg.message_type, msg.content[:80])
    return msg


def query_messages(
    limit: int = 15,
    before: Optional[datetime] = None,
    from_agent: Optional[str] = None,
    project: Optional[str] = None,
    days: Optional[int] = None,
    mentions: Optional[str] = None,
) -> list[Message]:
    """Query messages with filters."""
    limit = min(limit, 50)
    conditions = []
    params: list = []

    if before:
        conditions.append("created_at < ?")
        params.append(_dt_to_str(before))

    if from_agent:
        conditions.append("agent_name LIKE ?")
        params.append(f"%{from_agent}%")

    if project:
        conditions.append("project_tag LIKE ?")
        params.append(f"%{project}%")

    if days:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        conditions.append("created_at > ?")
        params.append(_dt_to_str(cutoff))

    if mentions:
        conditions.append("mentions LIKE ?")
        params.append(f"%{mentions}%")

    where = ""
    if conditions:
        where = "WHERE " + " AND ".join(conditions)

    query = f"SELECT * FROM messages {where} ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    conn = _get_conn()
    rows = conn.execute(query, params).fetchall()
    conn.close()

    return [
        Message(
            id=r["id"], agent_id=r["agent_id"], agent_name=r["agent_name"],
            content=r["content"], message_type=r["message_type"],
            mentions=json.loads(r["mentions"]), project_tag=r["project_tag"],
            created_at=_str_to_dt(r["created_at"]),
        )
        for r in reversed(rows)  # Return in chronological order
    ]


# ── Feature Requests ──────────────────────────────────────────────────────────

def _row_to_feature_request(r: sqlite3.Row) -> FeatureRequest:
    return FeatureRequest(
        id=r["id"],
        agent_name=r["agent_name"],
        project=r["project"],
        title=r["title"],
        description=r["description"],
        status=r["status"],
        vote_count=r["vote_count"],
        created_at=_str_to_dt(r["created_at"]),
    )


def insert_feature_request(fr: FeatureRequest) -> FeatureRequest:
    conn = _get_conn()
    conn.execute(
        """INSERT INTO feature_requests (id, agent_name, project, title, description, status, vote_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (fr.id, fr.agent_name, fr.project, fr.title, fr.description,
         fr.status, fr.vote_count, _dt_to_str(fr.created_at)),
    )
    conn.commit()
    conn.close()
    return fr


def get_feature_request(request_id: str) -> Optional[FeatureRequest]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM feature_requests WHERE id = ?", (request_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    return _row_to_feature_request(row)


def list_feature_requests(
    status: Optional[str] = None,
    project: Optional[str] = None,
    limit: int = 20,
) -> list[FeatureRequest]:
    limit = min(limit, 50)
    conditions = []
    params: list = []

    if status:
        conditions.append("status = ?")
        params.append(status)

    if project:
        conditions.append("project LIKE ?")
        params.append(f"%{project}%")

    where = ""
    if conditions:
        where = "WHERE " + " AND ".join(conditions)

    query = f"SELECT * FROM feature_requests {where} ORDER BY vote_count DESC, created_at DESC LIMIT ?"
    params.append(limit)

    conn = _get_conn()
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [_row_to_feature_request(r) for r in rows]


def vote_feature_request(request_id: str, agent_name: str) -> tuple[bool, str]:
    """Vote for a feature request. Returns (success, message)."""
    conn = _get_conn()

    # Check if request exists
    row = conn.execute("SELECT * FROM feature_requests WHERE id = ?", (request_id,)).fetchone()
    if row is None:
        conn.close()
        return False, f"Feature request '{request_id}' not found."

    # Check for duplicate vote
    existing = conn.execute(
        "SELECT 1 FROM feature_request_votes WHERE request_id = ? AND agent_name = ?",
        (request_id, agent_name),
    ).fetchone()
    if existing:
        conn.close()
        return False, "You already voted for this one. One vote per agent."

    # Insert vote and bump count
    conn.execute(
        "INSERT INTO feature_request_votes (request_id, agent_name, created_at) VALUES (?, ?, ?)",
        (request_id, agent_name, _dt_to_str(datetime.now(timezone.utc))),
    )
    conn.execute(
        "UPDATE feature_requests SET vote_count = vote_count + 1 WHERE id = ?",
        (request_id,),
    )
    conn.commit()

    new_count = conn.execute(
        "SELECT vote_count FROM feature_requests WHERE id = ?", (request_id,)
    ).fetchone()["vote_count"]
    conn.close()

    return True, f"Vote recorded! '{row['title']}' now has {new_count} vote(s)."


def get_voters_for_request(request_id: str) -> list[str]:
    """Get all agent names that voted for a feature request."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT agent_name FROM feature_request_votes WHERE request_id = ? ORDER BY created_at",
        (request_id,),
    ).fetchall()
    conn.close()
    return [r["agent_name"] for r in rows]


# ── Direct Message Queue ──────────────────────────────────────────────────────

def _row_to_direct_entry(r: sqlite3.Row) -> DirectQueueEntry:
    return DirectQueueEntry(
        id=r["id"],
        from_agent=r["from_agent"],
        to_agent=r["to_agent"],
        prompt=r["prompt"],
        wrapped_prompt=r["wrapped_prompt"],
        chat_message_id=r["chat_message_id"],
        status=r["status"],
        created_at=_str_to_dt(r["created_at"]),
        delivered_at=_str_to_dt(r["delivered_at"]) if r["delivered_at"] else None,
        responded_at=_str_to_dt(r["responded_at"]) if r["responded_at"] else None,
        response=r["response"],
    )


def enqueue_direct(entry: DirectQueueEntry) -> DirectQueueEntry:
    """Insert a new direct message into the queue."""
    conn = _get_conn()
    conn.execute(
        """INSERT INTO direct_queue
           (id, from_agent, to_agent, prompt, wrapped_prompt, chat_message_id,
            status, created_at, delivered_at, responded_at, response)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (entry.id, entry.from_agent, entry.to_agent, entry.prompt,
         entry.wrapped_prompt, entry.chat_message_id, entry.status,
         _dt_to_str(entry.created_at), None, None, None),
    )
    conn.commit()
    conn.close()
    logger.info("Enqueued DM {} from @{} to @{}", entry.id, entry.from_agent, entry.to_agent)
    return entry


def peek_pending_directs(to_agent: str) -> list[DirectQueueEntry]:
    """Get all pending DMs for an agent (status='pending'). Does NOT change status."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM direct_queue WHERE to_agent = ? AND status = 'pending' ORDER BY created_at",
        (to_agent,),
    ).fetchall()
    conn.close()
    return [_row_to_direct_entry(r) for r in rows]


def mark_direct_delivered(entry_id: str) -> None:
    """Mark a DM as delivered (picked up by agent via smart pull)."""
    now = _dt_to_str(datetime.now(timezone.utc))
    conn = _get_conn()
    conn.execute(
        "UPDATE direct_queue SET status = 'delivered', delivered_at = ? WHERE id = ?",
        (now, entry_id),
    )
    conn.commit()
    conn.close()
    logger.info("DM {} marked as delivered", entry_id)


def mark_direct_responded(entry_id: str, response: str) -> bool:
    """Mark a DM as responded. Returns True if updated, False if entry not found or wrong status."""
    now = _dt_to_str(datetime.now(timezone.utc))
    conn = _get_conn()
    rowcount = conn.execute(
        "UPDATE direct_queue SET status = 'responded', responded_at = ?, response = ? "
        "WHERE id = ? AND status IN ('pending', 'delivered')",
        (now, response, entry_id),
    ).rowcount
    conn.commit()
    conn.close()
    if rowcount:
        logger.info("DM {} marked as responded", entry_id)
    return rowcount > 0


def mark_direct_expired(entry_id: str) -> None:
    """Mark a DM as expired (timed out without delivery or response)."""
    conn = _get_conn()
    conn.execute(
        "UPDATE direct_queue SET status = 'expired' WHERE id = ? AND status IN ('pending', 'delivered')",
        (entry_id,),
    )
    conn.commit()
    conn.close()
    logger.debug("DM {} marked as expired", entry_id)


def mark_direct_fallback(entry_id: str) -> None:
    """Mark a DM as handled via subprocess fallback."""
    conn = _get_conn()
    conn.execute(
        "UPDATE direct_queue SET status = 'fallback' WHERE id = ? AND status IN ('pending', 'delivered')",
        (entry_id,),
    )
    conn.commit()
    conn.close()
    logger.info("DM {} falling back to subprocess", entry_id)


def get_direct_entry(entry_id: str) -> Optional[DirectQueueEntry]:
    """Get a single direct queue entry by ID."""
    conn = _get_conn()
    row = conn.execute("SELECT * FROM direct_queue WHERE id = ?", (entry_id,)).fetchone()
    conn.close()
    if row is None:
        return None
    return _row_to_direct_entry(row)


def expire_stale_directs(max_age_minutes: int = 5) -> int:
    """Expire pending/delivered DMs older than max_age_minutes. Returns count expired."""
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)
    conn = _get_conn()
    rowcount = conn.execute(
        "UPDATE direct_queue SET status = 'expired' "
        "WHERE status IN ('pending', 'delivered') AND created_at < ?",
        (_dt_to_str(cutoff),),
    ).rowcount
    conn.commit()
    conn.close()
    if rowcount:
        logger.info("Expired {} stale DM(s)", rowcount)
    return rowcount


def list_direct_queue(
    to_agent: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 20,
) -> list[DirectQueueEntry]:
    """List direct queue entries with optional filters. For the web UI."""
    conditions = []
    params: list = []

    if to_agent:
        conditions.append("to_agent = ?")
        params.append(to_agent)

    if status:
        conditions.append("status = ?")
        params.append(status)

    where = ""
    if conditions:
        where = "WHERE " + " AND ".join(conditions)

    query = f"SELECT * FROM direct_queue {where} ORDER BY created_at DESC LIMIT ?"
    params.append(min(limit, 50))

    conn = _get_conn()
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [_row_to_direct_entry(r) for r in rows]
