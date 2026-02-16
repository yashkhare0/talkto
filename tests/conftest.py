"""Shared test fixtures for TalkTo backend tests.

Provides an isolated in-memory SQLite database per test, factory functions
for creating test entities, and an async HTTP client wired to the real
ASGI app with the test DB injected.
"""

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.db import Base, get_db
from backend.app.main import app
from backend.app.models.agent import Agent
from backend.app.models.channel import Channel
from backend.app.models.channel_member import ChannelMember
from backend.app.models.feature import FeatureRequest, FeatureVote
from backend.app.models.message import Message
from backend.app.models.user import User

# ---------------------------------------------------------------------------
# Database fixtures
# ---------------------------------------------------------------------------

# In-memory engine shared across a test session.  Each test gets its own
# tables (created/dropped per test function) so tests are fully isolated.
_test_engine = create_async_engine(
    "sqlite+aiosqlite://",
    echo=False,
    connect_args={"check_same_thread": False},
)

_TestSessionLocal = async_sessionmaker(
    _test_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


def _set_test_pragmas(dbapi_conn, connection_record):  # noqa: ARG001
    """Set SQLite PRAGMAs on every test connection (mirrors production behavior)."""
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys = ON")
    cursor.execute("PRAGMA busy_timeout = 5000")
    cursor.close()


event.listen(_test_engine.sync_engine, "connect", _set_test_pragmas)


@pytest.fixture(autouse=True)
async def _setup_db():
    """Create all tables before each test, drop them after."""
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield

    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture
async def db() -> AsyncGenerator[AsyncSession, None]:
    """Provide a clean async database session for a test."""
    async with _TestSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


@pytest.fixture
async def client(db: AsyncSession) -> AsyncGenerator[AsyncClient, None]:
    """Async HTTP client with the test DB injected into the FastAPI app."""

    async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
        # Reuse the same session so test data is visible to the app
        yield db

    app.dependency_overrides[get_db] = _override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Factory functions
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def create_user(
    db: AsyncSession,
    *,
    name: str = "test-user",
    user_type: str = "human",
    display_name: str | None = None,
    about: str | None = None,
    agent_instructions: str | None = None,
) -> User:
    """Create and persist a User."""
    user = User(
        id=str(uuid.uuid4()),
        name=name,
        type=user_type,
        created_at=_now(),
        display_name=display_name,
        about=about,
        agent_instructions=agent_instructions,
    )
    db.add(user)
    await db.flush()
    return user


async def create_agent(
    db: AsyncSession,
    *,
    agent_name: str = "test-agent",
    agent_type: str = "opencode",
    project_path: str = "/tmp/test-project",
    project_name: str = "test-project",
    status: str = "online",
    server_url: str | None = None,
    provider_session_id: str | None = None,
    description: str | None = None,
    personality: str | None = None,
    current_task: str | None = None,
    gender: str | None = None,
) -> tuple[User, Agent]:
    """Create a User + Agent pair."""
    user = await create_user(db, name=agent_name, user_type="agent")
    agent = Agent(
        id=user.id,
        agent_name=agent_name,
        agent_type=agent_type,
        project_path=project_path,
        project_name=project_name,
        status=status,
        server_url=server_url,
        provider_session_id=provider_session_id,
        description=description,
        personality=personality,
        current_task=current_task,
        gender=gender,
    )
    db.add(agent)
    await db.flush()
    return user, agent


async def create_channel(
    db: AsyncSession,
    *,
    name: str = "#test-channel",
    channel_type: str = "general",
    project_path: str | None = None,
    created_by: str = "system",
) -> Channel:
    """Create and persist a Channel."""
    channel = Channel(
        id=str(uuid.uuid4()),
        name=name,
        type=channel_type,
        project_path=project_path,
        created_by=created_by,
        created_at=_now(),
    )
    db.add(channel)
    await db.flush()
    return channel


async def create_message(
    db: AsyncSession,
    *,
    channel_id: str,
    sender_id: str,
    content: str = "Hello, world!",
    mentions: str | None = None,
    parent_id: str | None = None,
) -> Message:
    """Create and persist a Message."""
    msg = Message(
        id=str(uuid.uuid4()),
        channel_id=channel_id,
        sender_id=sender_id,
        content=content,
        mentions=mentions,
        parent_id=parent_id,
        created_at=_now(),
    )
    db.add(msg)
    await db.flush()
    return msg


async def create_channel_member(
    db: AsyncSession,
    *,
    channel_id: str,
    user_id: str,
) -> ChannelMember:
    """Add a user to a channel."""
    member = ChannelMember(
        channel_id=channel_id,
        user_id=user_id,
        joined_at=_now(),
    )
    db.add(member)
    await db.flush()
    return member


async def create_feature(
    db: AsyncSession,
    *,
    title: str = "Test Feature",
    description: str = "A test feature request.",
    status: str = "open",
    created_by: str,
) -> FeatureRequest:
    """Create and persist a FeatureRequest."""
    feature = FeatureRequest(
        id=str(uuid.uuid4()),
        title=title,
        description=description,
        status=status,
        created_by=created_by,
        created_at=_now(),
    )
    db.add(feature)
    await db.flush()
    return feature


async def create_vote(
    db: AsyncSession,
    *,
    feature_id: str,
    user_id: str,
    vote: int = 1,
) -> FeatureVote:
    """Create and persist a FeatureVote."""
    fv = FeatureVote(
        feature_id=feature_id,
        user_id=user_id,
        vote=vote,
    )
    db.add(fv)
    await db.flush()
    return fv
