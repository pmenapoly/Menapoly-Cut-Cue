#!/bin/sh
# Install (or update) the Menapoly Cue Mac worker as a launchd user agent. macOS only. Intel and Apple Silicon.
# Usage: scripts/install_agent_launchd.sh            install + start
#        scripts/install_agent_launchd.sh --remove   stop + remove
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LABEL=com.menapoly.cue.agent
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/MenapolyCue"
[ "$(uname)" = "Darwin" ] || { echo "launchd is macOS only"; exit 1; }
if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi
PY="$ROOT/backend/.venv/bin/python"
[ -x "$PY" ] || { echo "Run 'make setup' first"; exit 1; }
[ -f "$ROOT/.env" ] && chmod 600 "$ROOT/.env"
(cd "$ROOT/backend" && "$PY" -m cutcue.agent --check) || { echo "Fix the agent settings in .env first (see docs/cloud/setup.md)"; exit 1; }
mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"
sed -e "s#__PYTHON__#$PY#" -e "s#__BACKEND__#$ROOT/backend#" -e "s#__LOGDIR__#$LOGDIR#g" \
  "$ROOT/deploy/macos/$LABEL.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Logs: $LOGDIR/agent.log   Stop: scripts/install_agent_launchd.sh --remove"
