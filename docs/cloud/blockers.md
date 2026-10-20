# Remaining blockers and unverified items

## Needs your decision or action (nothing below was done)

The pilot's single list of approvals is [pilot/APPROVAL-CHECKLIST.md](pilot/APPROVAL-CHECKLIST.md). In short:

1. ~~Security gate (S1)~~ **Resolved 2026-10-20:** both Relay deploy workflows are disabled (verified). Relay `main`
   is still the build that trusts identity headers, but nothing can deploy it now. The hotfix (R1) stays a later decision.
2. **Domain:** confirm `menapoly-digital.com` is an active zone in your Cloudflare account and `cue` is free (C1–C3).
   This sandbox can't do DNS lookups or reach Cloudflare's API, so it couldn't be checked from here.
3. **Paid services (PAID-1..3)** and **production changes (PROD-1..6)**, each approved separately.
4. Relay hotfix merge/deploy (R1) stays a separate, later decision.

## Verified only locally (labelled unverified until done for real)

| Item | Verified here | Not yet verified |
|---|---|---|
| Access JWT verification | unit tests with real RS256 keys and a stubbed key endpoint | against your real Access team |
| R2 | S3 API behaviour via moto (multipart, ListParts, presigned GET/PUT) | real R2: CORS rule, `response-content-disposition`, speed |
| Queues / cron | workerd local Queues and `/__scheduled` | Cloudflare-hosted delivery, DLQ, cron timing |
| Email notifications | code path only (`send_email` binding) | any real email |
| Mac agent on macOS | Linux, real FFmpeg, fixture transcriber, real H.264/AAC in and out | **Intel Mac** with faster-whisper, launchd install, sleep/wake, a 20 GB upload |
| Phone | Chromium at 390×844 (Pixel 7 profile); install steps in pilot/android.md | real iPhone Safari / Android Chrome, Add to Home Screen, background tab behaviour, cellular hand-offs |
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
