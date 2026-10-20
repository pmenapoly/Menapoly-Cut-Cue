#!/bin/bash
# Menapoly Cut Cue on your Mac: start, stop and check the desktop app and the Mac worker.
#
#   scripts/cue_mac.sh start          build (first time) and start the app, then open it in Chrome
#   scripts/cue_mac.sh stop           stop the app
#   scripts/cue_mac.sh status         is the app running? is the worker running?
#   scripts/cue_mac.sh open           open the app in Chrome
#   scripts/cue_mac.sh worker-start   start the Mac worker (needs CUE_CLOUD_URL and CUE_WORKER_TOKEN in .env)
#   scripts/cue_mac.sh worker-stop    stop it gracefully (its current job goes back to the queue, nothing is lost)
#   scripts/cue_mac.sh logs           follow the app and worker logs
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1
RUN="$ROOT/data/run"; mkdir -p "$RUN"
PORT=$(grep -E '^CUTCUE_PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-8000}
URL="http://127.0.0.1:$PORT"
LABEL=com.menapoly.cue.agent
PY="$ROOT/backend/.venv/bin/python"

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
launchd_agent() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }
open_chrome() { if [ -d "/Applications/Google Chrome.app" ]; then open -a "Google Chrome" "$URL"; else open "$URL"; fi; }

case "${1:-status}" in
start)
  if alive "$RUN/app.pid"; then echo "Already running at $URL"; open_chrome; exit 0; fi
  [ -x "$PY" ] || { echo "Run scripts/mac_setup.sh first."; exit 1; }
  if [ ! -f frontend/out/index.html ]; then echo "Building the app (first time, about a minute)…"; (cd frontend && npm run build >/dev/null) || { echo "Build failed: run 'make build' to see why."; exit 1; }; fi
  (cd backend || exit 1; nohup "$PY" -m cutcue > "$RUN/app.log" 2>&1 & echo $! > "$RUN/app.pid")
  printf "Starting"
  for _ in $(seq 60); do curl -fs "$URL/api/health" >/dev/null 2>&1 && break; printf "."; sleep 1; done; echo
  if curl -fs "$URL/api/health" >/dev/null 2>&1; then echo "Menapoly Cut Cue is running at $URL"; open_chrome
  else echo "It didn't start. Last lines of the log:"; tail -20 "$RUN/app.log"; exit 1; fi ;;
stop)
  if alive "$RUN/app.pid"; then
    P=$(cat "$RUN/app.pid"); kill "$P"
    for _ in $(seq 20); do kill -0 "$P" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$P" 2>/dev/null && kill -9 "$P"
    rm -f "$RUN/app.pid"; echo "Stopped."
  else echo "Not running."; fi ;;
open) open_chrome ;;
status)
  if alive "$RUN/app.pid"; then echo "App: running at $URL"; else echo "App: stopped"; fi
  if launchd_agent; then echo "Worker: installed as a login service ($(launchctl print "gui/$(id -u)/$LABEL" | awk '/state =/ {print $3; exit}'))"
  elif alive "$RUN/agent.pid"; then echo "Worker: running"; else echo "Worker: stopped"; fi ;;
worker-start)
  if launchd_agent; then launchctl kickstart "gui/$(id -u)/$LABEL" && echo "Worker started (login service)."; exit 0; fi
  if alive "$RUN/agent.pid"; then echo "Worker already running."; exit 0; fi
  (cd backend && "$PY" -m cutcue.agent --check) || exit 1
  (cd backend || exit 1; nohup "$PY" -m cutcue.agent > "$RUN/agent.log" 2>&1 & echo $! > "$RUN/agent.pid")
  echo "Worker started. Logs: $RUN/agent.log" ;;
worker-stop)
  # SIGTERM = graceful: the current job is handed back to the queue and the phone shows "Mac offline" at once.
  if launchd_agent; then launchctl kill SIGTERM "gui/$(id -u)/$LABEL" && echo "Worker stopping (it stays installed; worker-start brings it back)."; exit 0; fi
  if alive "$RUN/agent.pid"; then kill -TERM "$(cat "$RUN/agent.pid")"; rm -f "$RUN/agent.pid"; echo "Worker stopping."; else echo "Worker not running."; fi ;;
logs) tail -f "$RUN/app.log" "$RUN/agent.log" "$HOME/Library/Logs/MenapolyCue/agent.log" 2>/dev/null ;;
*) sed -n '2,12p' "$0"; exit 1 ;;
esac
