#!/usr/bin/env bash
# Stop the LaunchAgent (plist stays installed; use register/run to start again).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

if service_loaded; then
  bootout_service
  echo "stopped ${LABEL}"
else
  echo "${LABEL} is not running"
fi

# Clear a stray listener if anything is still bound.
if lsof -tiTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -tiTCP:"${PORT}" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  echo "freed port ${PORT}"
fi
