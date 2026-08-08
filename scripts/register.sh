#!/usr/bin/env bash
# Install LaunchAgent so consumption-watch starts at login and stays alive.
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

render_plist
bootout_service
bootstrap_service
kickstart_service

echo "registered ${LABEL}"
echo "  plist   ${PLIST_DEST}"
echo "  dashboard http://127.0.0.1:${PORT}"
echo "  logs    /tmp/consumption-watch.log  /tmp/consumption-watch.err"
