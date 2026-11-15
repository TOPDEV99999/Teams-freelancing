#!/usr/bin/env bash
# Starts the hub in this terminal (Ctrl+C stops it). Dashboard: http://localhost:8766 (HUB_PORT in .env).
set -euo pipefail
cd "$(dirname "$0")"

# A single-file binary built with ./build-binary.sh is used when present.
if [ -x ./WorkanaAssistant-linux ] && [ "${USE_SOURCE:-0}" != "1" ]; then
  RUN=(./WorkanaAssistant-linux)
elif [ -x .venv/bin/python ]; then
  RUN=(.venv/bin/python -m hub)
else
  echo "Not installed yet - run ./install.sh first."
  exit 1
fi

# No desktop (server / SSH session): don't try to open a browser.
if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  set -- --no-browser "$@"
fi
exec "${RUN[@]}" "$@"
