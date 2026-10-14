# Setup and deployment (Menapoly Cue 2.0)

It is the same single process as Cut Cue: FastAPI serves the API and the built UI.

## Install and run on the Mac

```bash
git fetch origin && git checkout menapoly-cue-2.0
make setup            # Python venv, npm install, .env from .env.example, dependency check
make whisper-model    # once: download the speech model named in .env
make start            # builds the UI, then serves everything at http://127.0.0.1:8000
```

**Before upgrading an existing install, back up `data/` first.** Migration 5 runs automatically on first start; see `migration-plan.md`.

Open `http://127.0.0.1:8000/`. You land on Home. Cut Cue (the editor) opens from any project.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on Claude for Ask Cue and Cut Cue. Without it, both use the clearly labelled local planner. |
| `CUTCUE_PROJECT_BUDGET_USD` | AI budget per project. The same value also caps Ask Cue's global spend. Default 5. |
| `CUTCUE_PASSWORD`, `CUTCUE_SECRET_KEY` | Owner sign-in. Set both when anything other than this Mac can reach the app. |
| `CUTCUE_PUBLIC_URL` | Base URL used when showing review and upload links, e.g. a tunnel address. Defaults to the browser's address. |
| `CUE_TEXT_PROVIDER`, `CUE_TEXT_NUMBER`, `CUE_TEXT_AUTH_TOKEN`, `CUE_TEXT_WEBHOOK_URL` | Cue Text inbound. All four are required; otherwise the webhook returns 503. See `cue-text.md`. |
| `CUE_RELAY_URL`, `CUE_RELAY_WORKSPACE_ID`, `CUE_RELAY_ACCESS_CLIENT_ID`, `CUE_RELAY_ACCESS_CLIENT_SECRET` | Publish to the client portal. See `relay-connector.md`. |
| `CUE_SMTP_HOST`, `CUE_SMTP_PORT`, `CUE_SMTP_USER`, `CUE_SMTP_PASSWORD`, `CUE_SMTP_SECURITY`, `CUE_EMAIL_FROM`, `CUE_EMAIL_TO`, `CUE_EMAIL_KINDS` | Email notifications. Off unless host, from and to are set. |

## Sharing review links outside your network

Review and upload links only work for someone who can reach this computer. Three ways to set that up:

1. **Same Wi-Fi:** run with `CUTCUE_HOST=0.0.0.0`, set a password, and share `http://<mac-name>.local:8000/review/?t=…`.
2. **Internet:** use an HTTPS tunnel you trust (for example Cloudflare Tunnel or Tailscale Funnel) pointing at port 8000. Set `CUTCUE_PUBLIC_URL` to the tunnel URL and **always set `CUTCUE_PASSWORD`**. Only `/api/public/*` (token- or signature-scoped) and the static pages work without the password.
3. **Client portal:** publish approved renders to the Cloudflare Menapoly Cue (Relay) instead. See `relay-connector.md`; it needs the Relay branches deployed first.

## Checks

```bash
make test                               # backend: 91 tests (real FFmpeg renders); the real-Relay test needs CUE_RELAY_TEST_URL
cd frontend && npx tsc --noEmit && npm run build
make ui-test                            # Playwright: desktop, tablet, phone + the 5-width shell check
python3 scripts/check_contrast.py       # design tokens, WCAG AA
make validate MEDIA=~/Movies/episode.mp4 LONG=~/Movies/full.mp4 PHONE=1  # harness, steps 1–18
make backup                             # checksummed backup; make restore BACKUP=… (app stopped)
```
