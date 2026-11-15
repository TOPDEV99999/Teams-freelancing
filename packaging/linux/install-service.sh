#!/usr/bin/env bash
# Runs the hub as a systemd *user* service: starts at login (or at boot with lingering), restarts on failure.
#   ./install-service.sh            install + start
#   ./install-service.sh --remove   stop + uninstall
# Logs:  journalctl --user -u workana-assistant -f
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
UNIT="$HOME/.config/systemd/user/workana-assistant.service"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd was not found on this system - use ./start.sh (e.g. inside tmux or screen) instead."
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now workana-assistant.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Service removed. Your data in $DIR/data is untouched."
  exit 0
fi

if [ -x "$DIR/WorkanaAssistant-linux" ]; then
  EXEC="$DIR/WorkanaAssistant-linux --no-browser"
elif [ -x "$DIR/.venv/bin/python" ]; then
  EXEC="$DIR/.venv/bin/python -m hub --no-browser"
else
  echo "Not installed yet - run ./install.sh first."
  exit 1
fi

mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=Workana Proposal Assistant hub
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$EXEC
Restart=on-failure
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now workana-assistant.service
sleep 2
systemctl --user --no-pager status workana-assistant.service | head -n 5 || true
echo
echo "Running. Dashboard: http://localhost:$(grep -E '^HUB_PORT=' .env 2>/dev/null | cut -d= -f2 || echo 8766)"
echo "Logs:   journalctl --user -u workana-assistant -f"
echo "To keep it running when you are logged out (start at boot):  sudo loginctl enable-linger $USER"
