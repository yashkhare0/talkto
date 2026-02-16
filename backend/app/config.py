"""Application configuration with environment variable support.

All settings can be overridden via environment variables prefixed with ``TALKTO_``,
or via a ``.env`` file in the project root.

Examples::

    TALKTO_PORT=9000 uv run talkto start
    TALKTO_DB_PATH=/var/data/talkto.db uv run talkto start
    TALKTO_LOG_LEVEL=DEBUG uv run talkto start
    TALKTO_NETWORK=true uv run talkto start   # expose on LAN
"""

import secrets
import socket
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Project root: two levels up from this file (backend/app/config.py -> talkto/)
_BASE_DIR = Path(__file__).resolve().parent.parent.parent


def get_lan_ip() -> str:
    """Detect the machine's LAN IP address.

    Opens a UDP socket to a public DNS server (doesn't actually send data)
    to determine which network interface the OS would use for outbound traffic.
    Falls back to 127.0.0.1 if detection fails.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            # Connect to a public DNS server — no data is actually sent
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


class Settings(BaseSettings):
    """TalkTo configuration — all values overridable via env vars."""

    model_config = SettingsConfigDict(
        env_prefix="TALKTO_",
        env_file=str(_BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    frontend_port: int = 3000

    # Network mode — expose on LAN so agents on other machines can connect
    network: bool = False

    # Paths
    data_dir: Path = _BASE_DIR / "data"
    prompts_dir: Path = _BASE_DIR / "prompts"

    # Logging
    log_level: str = "INFO"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "talkto.db"

    @property
    def database_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.db_path}"

    @property
    def advertise_host(self) -> str:
        """The hostname/IP to advertise in MCP configs and startup messages.

        In network mode, returns the machine's LAN IP. Otherwise, localhost.
        """
        if self.network:
            return get_lan_ip()
        return "localhost"

    @property
    def base_url(self) -> str:
        """The full base URL for the API server (used in MCP configs, CORS, etc.)."""
        return f"http://{self.advertise_host}:{self.port}"

    @property
    def mcp_url(self) -> str:
        """The full MCP endpoint URL."""
        return f"{self.base_url}/mcp"

    @property
    def frontend_url(self) -> str:
        return f"http://{self.advertise_host}:{self.frontend_port}"


# Singleton instance — import this everywhere
settings = Settings()

# Shared secret for internal endpoints (/_internal/*).
# Generated at startup — both the broadcaster and the internal API endpoint
# live in the same process or share this module, so the secret matches.
INTERNAL_SECRET = secrets.token_hex(32)

# Backward-compatible aliases (used by existing imports)
BASE_DIR = _BASE_DIR
DATA_DIR = settings.data_dir
DB_PATH = settings.db_path
DATABASE_URL = settings.database_url
PROMPTS_DIR = settings.prompts_dir

API_HOST = settings.host
API_PORT = settings.port

FRONTEND_PORT = settings.frontend_port
FRONTEND_URL = settings.frontend_url
