# Remaining blockers and unverified items

## Needs your decision or action (nothing below was done)

1. **Relay's deploy workflow is still active and `main` would deploy the vulnerable build.** The Access secrets
   `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD_PREVIEW` and `CF_ACCESS_SERVICE_TOKENS` are still missing in
   MenapolyRelay (readiness run, Oct 14). Until the hotfix branch `hotfix/access-identity-minimal` is approved and the
   secrets exist, **any push to Relay's `main` deploys a Worker that trusts identity headers.** Recommended: disable
   "Deploy Menapoly Cue to Cloudflare" in GitHub Actions until then. This is the Phase 0 gate; the new control plane
   doesn't depend on Relay, but I did not deploy anything while this risk is open.
2. **Approval to deploy** the control plane (Workers Paid $5/month, R2, D1, Queues). See [costs.md](costs.md) and
   [setup.md §3](setup.md).
3. **Choose the hostname** (e.g. `cue.<your-domain>`) and create the Access application with bypass paths.
4. **R2 API token** scoped to the one bucket, stored with `wrangler secret put`.
5. `database_id` for D1 goes into `wrangler.jsonc` after `wrangler d1 create`.

## Verified only locally (labelled unverified until done for real)

| Item | Verified here | Not yet verified |
|---|---|---|
| Access JWT verification | unit tests with real RS256 keys and a stubbed key endpoint | against your real Access team |
| R2 | S3 API behaviour via moto (multipart, ListParts, presigned GET/PUT) | real R2: CORS rule, `response-content-disposition`, speed |
| Queues / cron | workerd local Queues and `/__scheduled` | Cloudflare-hosted delivery, DLQ, cron timing |
| Email notifications | code path only (`send_email` binding) | any real email |
| Mac agent on macOS | Linux, real FFmpeg, fixture transcriber, real H.264/AAC in and out | **Intel Mac** with faster-whisper, launchd install, sleep/wake, a 20 GB upload |
| Phone | Chromium at 390×844 (Pixel 7 profile) | real iPhone Safari / Android Chrome, Add to Home Screen, background tab behaviour, cellular hand-offs |
| In-browser H.264 playback | URL serves the real MP4 (`ftyp` checked) | actual playback: this Chromium build has no H.264 codec |

## Not built yet (by design or next milestones)

- Optional cloud render worker: off; `CLOUD_RENDERING=disabled`; no paid processing exists to approve.
- Cue Text (SMS/MMS): stays disabled. The `/v1` notification model is ready to fan out to SMS later. No provider is
  connected and no message will be sent until you choose one and complete messaging compliance (A2P 10DLC in the US).
- Web push notifications (in-app inbox + email only for now).
- Moving local editor projects into the cloud (the two stores are separate on purpose).
- Agent job types are transcribe, auto-edit and render. Clip Factory and audio enhancement remain desktop-only for now.
- The agent's AI cost is reported as $0 because its pipeline makes no paid calls. If a Claude-driven step is added to
  the worker, it must report measured usage and respect `ai_budget_remaining_usd`.
