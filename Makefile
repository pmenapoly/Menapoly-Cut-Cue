# Menapoly Cut Cue — one-command workflows. Requires Python 3.10+ (3.12 recommended), Node 20+, FFmpeg.
PY ?= python3
VENV := backend/.venv
VPY := $(VENV)/bin/python

.PHONY: setup check dev start build test fixture whisper-model clean

setup: ## Install backend + frontend dependencies and create .env
	test -d $(VENV) || $(PY) -m venv $(VENV)
	$(VPY) -m pip install --upgrade pip
	$(VPY) -m pip install -r backend/requirements-dev.txt
	cd frontend && npm install --no-audit --no-fund
	test -f .env || cp .env.example .env
	$(VPY) scripts/check_deps.py

check: ## Verify FFmpeg, Python packages, Node, configuration
	$(VPY) scripts/check_deps.py

dev: ## API on :8000 (auto-reload) + Next.js dev server on :3000 -> open http://localhost:3000
	./scripts/dev.sh

build: ## Build the static frontend into frontend/out
	cd frontend && npm run build

start: build ## Single process: API + built UI on http://127.0.0.1:8000
	cd backend && .venv/bin/python -m cutcue

test: ## Backend unit, integration and end-to-end tests (real FFmpeg renders)
	cd backend && .venv/bin/python -m pytest -q

fixture: ## Generate the synthetic Market Mocha interview + brief in data/fixtures
	$(VPY) scripts/make_fixture.py data/fixtures

whisper-model: ## Pre-download the Whisper model named in .env (CUTCUE_WHISPER_MODEL)
	cd backend && .venv/bin/python -c "from cutcue.config import settings as s; from faster_whisper import WhisperModel; WhisperModel(s.whisper_model, device='cpu', compute_type=s.whisper_compute_type); print('Whisper model ready:', s.whisper_model)"

clean:
	rm -rf frontend/.next frontend/out backend/.pytest_cache
