.PHONY: start dev install clean reset

start:
	uv run python -m talkto

dev:
	uv run python -m talkto --reload

install:
	uv sync

clean:
	rm -f data/talkto.db
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true

reset: clean start
