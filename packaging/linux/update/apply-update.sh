#!/usr/bin/env bash
# Installs this update over an existing Linux installation. Your .env and data/ are kept, and backed up first.
#
#   Put this "update" folder inside your installation folder (next to WorkanaAssistant/), then run:
#     bash update/apply-update.sh
#   Or point it at the installation:
#     bash apply-update.sh ~/workana-assistant
set -euo pipefail

UPD="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${1:-$UPD/..}" 2>/dev/null && pwd || true)"
APP="$ROOT/WorkanaAssistant"

if [ -z "$ROOT" ] || [ ! -d "$APP/hub" ]; then
  echo "No installation found at: ${1:-$UPD/..}"
  echo "Put the update folder next to WorkanaAssistant/ or run:  bash apply-update.sh /path/to/workana-assistant"
  exit 1
fi
[ -d "$UPD/WorkanaAssistant/hub" ] || { echo "This update folder is incomplete (WorkanaAssistant/hub missing)."; exit 1; }

# --- stop the app -------------------------------------------------------------------------------
SERVICE=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet workana-assistant.service 2>/dev/null; then
  echo "== stopping the background service"
  systemctl --user stop workana-assistant.service
  SERVICE=1
fi
if pgrep -f "$APP/WorkanaAssistant-linux" >/dev/null 2>&1 || pgrep -f "$APP/.venv/bin/python -m hub" >/dev/null 2>&1 \
   || pgrep -f "^\.venv/bin/python -m hub" >/dev/null 2>&1; then
  echo "The app is still running in a terminal. Stop it there with Ctrl+C, then run this again."
  [ "$SERVICE" = 1 ] && systemctl --user start workana-assistant.service
  exit 1
fi

# --- backup ------------------------------------------------------------------------------------
STAMP="$(date +%Y%m%d-%H%M%S)"
BK="$ROOT/backups/$STAMP"
echo "== backing up to $BK"
mkdir -p "$BK"
for x in data .env hub dashboard WorkanaAssistant-linux; do
  [ -e "$APP/$x" ] && cp -a "$APP/$x" "$BK/"
done
[ -d "$ROOT/extensions" ] && cp -a "$ROOT/extensions" "$BK/"

# --- copy the new files -------------------------------------------------------------------------
echo "== installing the new version"
rm -rf "$APP/hub" "$APP/dashboard"          # removes files that no longer exist in the new version
cp -a "$UPD/WorkanaAssistant/hub" "$UPD/WorkanaAssistant/dashboard" "$APP/"
for f in requirements.txt entry.py .env.example install.sh start.sh install-service.sh build-binary.sh; do
  [ -e "$UPD/WorkanaAssistant/$f" ] && cp -a "$UPD/WorkanaAssistant/$f" "$APP/"
done
chmod +x "$APP"/*.sh
if [ -d "$UPD/extensions" ]; then
  mkdir -p "$ROOT/extensions"
  for e in "$UPD"/extensions/*/; do
    n="$(basename "$e")"; rm -rf "$ROOT/extensions/$n"; cp -a "$e" "$ROOT/extensions/$n"
  done
fi
for f in MASTER-PROMPT.txt README.md; do
  [ -e "$UPD/$f" ] && cp -a "$UPD/$f" "$ROOT/"
done

# A single-file binary built earlier still contains the OLD version - set it aside so the new code runs.
if [ -e "$APP/WorkanaAssistant-linux" ]; then
  mv "$APP/WorkanaAssistant-linux" "$BK/WorkanaAssistant-linux.old"
  BINARY=1
else
  BINARY=0
fi

# --- dependencies + check -----------------------------------------------------------------------
if [ -x "$APP/.venv/bin/python" ]; then
  echo "== updating dependencies"
  "$APP/.venv/bin/python" -m pip install --quiet -r "$APP/requirements.txt"
  (cd "$APP" && .venv/bin/python -c 'import hub.main; print("   OK - the new version loads")')
else
  echo "== no .venv found - running install.sh"
  (cd "$APP" && ./install.sh)
fi

[ "$SERVICE" = 1 ] && { echo "== starting the background service again"; systemctl --user start workana-assistant.service; }

echo
echo "Update installed. Backup: $BK"
[ "$SERVICE" = 0 ] && echo "Start the app:   cd \"$APP\" && ./start.sh"
[ "$BINARY" = 1 ] && echo "Your old single-file program was set aside (it had the old version). The app now runs from source;" \
  && echo "to build a new one:   cd \"$APP\" && ./build-binary.sh"
echo "Then reload the dashboard tab (Ctrl+F5). If the extensions changed: chrome://extensions -> reload them."
echo "You can delete the update folder now:   rm -rf \"$UPD\""
