# Menapoly Cut Cue — one-command workflows. Requires Python 3.10+ (3.12 recommended), Node 20+, FFmpeg.
PY ?= python3
VENV := backend/.venv
VPY := $(VENV)/bin/python

.PHONY: setup check dev start build test ui-test validate fixture whisper-model clean

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

ui-test: build ## Browser interaction tests (Playwright) at desktop, tablet and phone sizes; screenshots -> docs/screenshots
	cd frontend && npx playwright test

validate: ## Real-world validation on this machine: make validate MEDIA=~/Movies/episode.mp4 [CLIP_MINUTES=10] [BRIEF=brief.pdf]
	$(VPY) scripts/validate.py $(if $(MEDIA),--media "$(MEDIA)") $(if $(CLIP_MINUTES),--clip-minutes $(CLIP_MINUTES)) $(if $(BRIEF),--brief "$(BRIEF)")

fixture: ## Generate the synthetic Market Mocha interview + brief in data/fixtures
	$(VPY) scripts/make_fixture.py data/fixtures

whisper-model: ## Pre-download the Whisper model named in .env (CUTCUE_WHISPER_MODEL)
	cd backend && .venv/bin/python -c "from cutcue.config import settings as s; from faster_whisper import WhisperModel; WhisperModel(s.whisper_model, device='cpu', compute_type=s.whisper_compute_type); print('Whisper model ready:', s.whisper_model)"

clean:
	rm -rf frontend/.next frontend/out backend/.pytest_cache
