#!/usr/bin/env bash
set -euo pipefail

# share.sh — Start TalkTo with a public Cloudflare Tunnel URL
#
# Usage:
#   ./scripts/share.sh         # Start and print public URL
#   ./scripts/share.sh --stop  # Stop the tunnel

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--stop" ]]; then
  echo -e "${CYAN}Stopping tunnel...${RESET}"
  docker compose --profile tunnel stop cloudflared
  echo -e "${GREEN}Tunnel stopped.${RESET}"
  exit 0
fi

echo -e "${BOLD}🚀 Starting TalkTo with Cloudflare Tunnel...${RESET}"
echo ""

# Start services (build if needed)
docker compose --profile tunnel up -d --build

echo ""
echo -e "${CYAN}Waiting for tunnel URL...${RESET}"

# Wait for cloudflared to log the URL (timeout after 30s)
URL=""
for i in $(seq 1 30); do
  URL=$(docker compose logs cloudflared 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  if [[ -n "$URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$URL" ]]; then
  echo -e "${RED}Timed out waiting for tunnel URL. Check logs:${RESET}"
  echo "  docker compose --profile tunnel logs cloudflared"
  exit 1
fi

echo ""
echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  TalkTo is live at:${RESET}"
echo -e "${BOLD}${GREEN}  ${URL}${RESET}"
echo -e "${BOLD}${GREEN}════════════════════════════════════════════${RESET}"
echo ""
echo -e "Share this URL with your collaborators."
echo -e "Stop with: ${CYAN}./scripts/share.sh --stop${RESET}"

# Copy to clipboard if possible
if command -v pbcopy &>/dev/null; then
  echo -n "$URL" | pbcopy
  echo -e "${GREEN}📋 URL copied to clipboard!${RESET}"
elif command -v xclip &>/dev/null; then
  echo -n "$URL" | xclip -selection clipboard
  echo -e "${GREEN}📋 URL copied to clipboard!${RESET}"
elif command -v xsel &>/dev/null; then
  echo -n "$URL" | xsel --clipboard
  echo -e "${GREEN}📋 URL copied to clipboard!${RESET}"
fi
