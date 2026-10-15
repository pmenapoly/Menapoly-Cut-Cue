# Menapoly Cut Cue — one-command workflows. Requires Python 3.10+ (3.12 recommended), Node 20+, FFmpeg.
PY ?= python3
VENV := backend/.venv
VPY := $(VENV)/bin/python

.PHONY: setup check dev start build test ui-test validate fixture whisper-model clean backup backup-db restore cloud-setup cloud-check cloud-dev cloud-ui-test agent agent-check agent-install

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

validate: ## Real-world validation: make validate MEDIA=~/Movies/episode.mp4 [CLIP_MINUTES=10] [BRIEF=brief.pdf] [LONG=~/Movies/full.mp4] [PHONE=1]
	$(VPY) scripts/validate.py $(if $(MEDIA),--media "$(MEDIA)") $(if $(CLIP_MINUTES),--clip-minutes $(CLIP_MINUTES)) $(if $(BRIEF),--brief "$(BRIEF)") $(if $(LONG),--long-media "$(LONG)") $(if $(PHONE),--phone-check)

backup: ## Back up database + media (safe while running) -> backups/cutcue-backup-<time>
	cd backend && .venv/bin/python -m cutcue.backup create --out ../backups

backup-db: ## Back up the database only (small, fast)
	cd backend && .venv/bin/python -m cutcue.backup create --no-media --out ../backups

restore: ## Restore a backup (stop the app first): make restore BACKUP=backups/cutcue-backup-<time>
	cd backend && .venv/bin/python -m cutcue.backup verify "$(abspath $(BACKUP))" && .venv/bin/python -m cutcue.backup restore "$(abspath $(BACKUP))" --yes

fixture: ## Generate the synthetic Market Mocha interview + brief in data/fixtures
	$(VPY) scripts/make_fixture.py data/fixtures

whisper-model: ## Pre-download the Whisper model named in .env (CUTCUE_WHISPER_MODEL)
	cd backend && .venv/bin/python -c "from cutcue.config import settings as s; from faster_whisper import WhisperModel; WhisperModel(s.whisper_model, device='cpu', compute_type=s.whisper_compute_type); print('Whisper model ready:', s.whisper_model)"

cloud-setup: ## Install the cloud control-plane tooling (Wrangler, TypeScript) - local only, deploys nothing
	cd cloud/control-plane && npm ci --no-audit --no-fund

cloud-check: ## Control plane: typecheck, unit tests, Wrangler dry-run build (no deploy)
	cd cloud/control-plane && npx tsc --noEmit && npm test && npx wrangler deploy --dry-run --outdir .wrangler/dry

cloud-dev: ## Run the cloud app locally (wrangler dev + local S3) -> prints the URL; state in data/cloud-dev.json
	$(VPY) scripts/cloud_dev.py --port 8787

cloud-ui-test: ## Phone-size browser tests of the cloud app with the real Mac agent; screenshots -> docs/cloud/screenshots
	cd frontend && npx playwright test -c playwright.cloud.config.ts

agent: ## Run the Mac worker agent in the foreground (needs CUE_CLOUD_URL and CUE_WORKER_TOKEN in .env)
	cd backend && .venv/bin/python -m cutcue.agent

agent-check: ## Check the agent configuration and that the control plane accepts this Mac
	cd backend && .venv/bin/python -m cutcue.agent --check

agent-install: ## Install the launchd service so the agent starts at login (macOS)
	./scripts/install_agent_launchd.sh

clean:
	rm -rf frontend/.next frontend/out backend/.pytest_cache
