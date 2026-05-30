#!/usr/bin/env bash
set -euo pipefail

echo "Starting Project Nexus..."

# Start the Compose stack in detached mode
docker compose up -d

# Wait a few seconds for containers to initialize
sleep 4

URL="http://localhost"

if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
else
  echo "Could not detect a browser opener; please open $URL manually"
fi

exit 0
