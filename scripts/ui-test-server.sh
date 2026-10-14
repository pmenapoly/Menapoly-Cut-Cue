#!/usr/bin/env bash
# Real backend + built UI on :8765 for browser tests: fixture transcriber, fresh data dir, synthetic media.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK="${CUTCUE_UI_TEST_DIR:-$(mktemp -d)}"
mkdir -p "$WORK"
[ -f "$WORK/fixtures/market-mocha-podcast.wav" ] || backend/.venv/bin/python scripts/make_fixture.py "$WORK/fixtures" >/dev/null
rm -rf "$WORK/data"
echo "$WORK/fixtures" > frontend/e2e/.fixtures-path
cd backend
CUTCUE_TRANSCRIBER=fixture CUTCUE_FIXTURE_DIR="$WORK/fixtures" CUTCUE_DATA_DIR="$WORK/data" CUTCUE_PORT=8765 \
  CUTCUE_PASSWORD="" ANTHROPIC_API_KEY="" exec .venv/bin/python -m cutcue
