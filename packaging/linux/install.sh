#!/usr/bin/env bash
# Installs the Workana Assistant hub on Linux: a private Python environment (.venv) + dependencies + .env.
# Needs Python 3.10 or newer and internet access (pip downloads the packages once).
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
if [ -z "$PY" ]; then
  echo "Python 3.10+ was not found. Install it first:"
  echo "  Debian/Ubuntu:  sudo apt install python3 python3-venv"
  echo "  Fedora:         sudo dnf install python3"
  echo "  Arch:           sudo pacman -S python"
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Python 3.10 or newer is required (found: $("$PY" -V 2>&1))."
  echo "Run again with a newer one, e.g.:  PYTHON=python3.12 ./install.sh"
  exit 1
fi
if ! "$PY" -c 'import venv, ensurepip' >/dev/null 2>&1; then
  echo "The Python 'venv' module is missing. On Debian/Ubuntu:  sudo apt install python3-venv"
  exit 1
fi

echo "== creating the Python environment (.venv) with $("$PY" -V 2>&1)"
"$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
echo "== installing dependencies (one-time download)"
.venv/bin/python -m pip install --quiet -r requirements.txt

mkdir -p data
if [ ! -f .env ]; then
  cp .env.example .env
  secret="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(24))')"
  sed -i "s/^HUB_SHARED_SECRET=.*/HUB_SHARED_SECRET=${secret}/" .env
  echo "== created .env with a new shared secret"
fi
chmod 600 .env
chmod +x start.sh install-service.sh build-binary.sh 2>/dev/null || true

echo "== self-check"
.venv/bin/python -c 'import hub.main, curl_cffi; print("   OK - all modules load")'

echo
echo "Installed. Start it with:   ./start.sh"
echo "Run it in the background at boot (optional):   ./install-service.sh"
echo "Shared secret for the extension popups (also in .env):"
grep '^HUB_SHARED_SECRET=' .env | sed 's/^/  /'
