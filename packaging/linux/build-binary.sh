#!/usr/bin/env bash
# OPTIONAL: builds a single-file Linux program (WorkanaAssistant-linux) with PyInstaller, like the Windows .exe.
# Must run ON Linux (PyInstaller cannot cross-compile). Not needed to use the app - ./start.sh works without it.
# The binary runs on Linux systems with the same or a newer glibc than the machine that built it.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"

[ -x .venv/bin/python ] || ./install.sh
echo "== installing PyInstaller into .venv"
.venv/bin/python -m pip install --quiet "pyinstaller>=6.0"

echo "== building WorkanaAssistant-linux (takes a few minutes)"
.venv/bin/python -m PyInstaller --noconfirm --clean --onefile --console \
  --name WorkanaAssistant-linux \
  --distpath "$DIR" --workpath "$DIR/build" --specpath "$DIR/build" \
  --paths "$DIR" \
  --add-data "$DIR/dashboard/dist:dashboard/dist" \
  --add-data "$DIR/.env.example:." \
  --collect-submodules hub \
  --collect-submodules uvicorn \
  --collect-submodules websockets \
  --collect-all curl_cffi \
  "$DIR/entry.py"
rm -rf "$DIR/build"

echo
echo "Built: $DIR/WorkanaAssistant-linux"
echo "It uses the same .env and data/ in this folder. ./start.sh and ./install-service.sh now use it automatically."
