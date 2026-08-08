#!/usr/bin/env bash
# Stop the LaunchAgent and remove its plist so it will not start at login.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

if service_loaded; then
  bootout_service
  echo "stopped ${LABEL}"
else
  echo "${LABEL} is not running"
fi

if lsof -tiTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -tiTCP:"${PORT}" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  echo "freed port ${PORT}"
fi

if [[ -f "${PLIST_DEST}" ]]; then
  rm -f "${PLIST_DEST}"
  echo "removed ${PLIST_DEST}"
else
  echo "plist already absent (${PLIST_DEST})"
fi

echo "unregistered ${LABEL}"
