"""Logging configuration for TalkTo using loguru.

Import `logger` from this module everywhere. Call `setup_logging()` once at
startup (server.py main) to configure sinks.

Console: colorized, concise format
File: data/talkto.log with 10MB rotation, 7-day retention
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from loguru import logger

# Re-export so all modules do: from .log import logger
__all__ = ["logger", "setup_logging"]

# Log directory (same as DB: project_root/data/)
_LOG_DIR = Path(__file__).resolve().parent.parent / "data"

# Env overrides
LOG_LEVEL = os.environ.get("TALKTO_LOG_LEVEL", "DEBUG").upper()
LOG_FILE = os.environ.get("TALKTO_LOG_FILE", str(_LOG_DIR / "talkto.log"))

_configured = False


def setup_logging() -> None:
    """Configure loguru sinks. Safe to call multiple times (idempotent)."""
    global _configured
    if _configured:
        return
    _configured = True

    # Remove default stderr handler
    logger.remove()

    # Console sink: colorized, concise
    logger.add(
        sys.stderr,
        level=LOG_LEVEL,
        format=(
            "<green>{time:HH:mm:ss}</green> | "
            "<level>{level: <8}</level> | "
            "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
            "<level>{message}</level>"
        ),
        colorize=True,
    )

    # File sink: structured, rotated
    _LOG_DIR.mkdir(exist_ok=True)
    logger.add(
        LOG_FILE,
        level="DEBUG",
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} - {message}",
        rotation="10 MB",
        retention="7 days",
        compression="gz",
        encoding="utf-8",
    )

    logger.info("Logging initialized | level={} | file={}", LOG_LEVEL, LOG_FILE)
