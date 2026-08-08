#!/usr/bin/env bash
# Start the LaunchAgent (registers first if needed).
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

if [[ ! -f "${PLIST_DEST}" ]]; then
  echo "plist missing; registering…"
  render_plist
fi

if service_loaded; then
  kickstart_service
  echo "restarted ${LABEL}"
else
  bootstrap_service
  kickstart_service
  echo "started ${LABEL}"
fi

echo "  dashboard http://127.0.0.1:${PORT}"
