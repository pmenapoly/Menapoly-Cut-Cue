#!/usr/bin/env bash
# Start the API (auto-reload) and the Next.js dev server together. Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x backend/.venv/bin/python ] || { echo "Run 'make setup' first."; exit 1; }
[ -d frontend/node_modules ] || { echo "Run 'make setup' first."; exit 1; }
trap 'kill 0' EXIT INT TERM
(cd backend && .venv/bin/python -m cutcue --reload) &
(cd frontend && npm run dev) &
sleep 3
echo
echo "  Menapoly Cut Cue is starting: open http://localhost:3000"
echo
wait
