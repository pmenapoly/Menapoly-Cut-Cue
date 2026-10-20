# Security gate (must be resolved before any pilot deployment)

Checked on 2026-10-19, read-only (GitHub Actions API, the Relay repository, the hotfix branch). Nothing was changed.

## Findings

| # | Finding | Evidence |
|---|---|---|
| 1 | Relay `main` is still `e5a904d`: the build that trusts the client-controllable `oai-authenticated-user-email` header. | `git ls-remote` |
| 2 | **"Deploy Menapoly Cue to Cloudflare" is active** and runs on every push to `main`. Its Access step is optional (`if: …secrets != ''`), so it would deploy the vulnerable build without Access. | workflow 350419547, state `active` |
| 3 | **"Deploy Preview (menapoly-cue-preview)" is also active** (runs on pushes to `claude/mobile-navigation-fix-0x9p89` and manual dispatch). Its only guard is "the Access secrets exist". Once you add `CF_ACCESS_TEAM_DOMAIN` for the pilot, that guard passes for an un-hotfixed branch on a public `*.workers.dev` address. | workflow 355167474, state `active` |
| 4 | Relay's Access secrets are still missing (`CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD_PREVIEW`, `CF_ACCESS_SERVICE_TOKENS`); the API token and account ID are set. | last readiness run (Oct 14); no runs since |
| 5 | No CI deployment of Relay has ever succeeded. Whether a Worker was deployed by hand can only be seen in your dashboard. | Actions history |

## 1. Done: disable the unsafe Relay deployment workflows

**Executed 2026-10-20 with the owner's approval (S1)** via `gh workflow disable 350419547` and
`gh workflow disable 355167474`. Verified afterwards with `gh workflow list --all` and the GitHub workflow API: both
`disabled_manually`. No files were deleted and nothing was merged. To re-enable later (only after the Relay hotfix and
its Access secrets are in place): Actions → workflow → **Enable workflow**.

The original preparation notes follow.

This is a production change to the Relay repository (it changes what pushes do), so it waits for your approval
(checklist item **S1**). It changes no code and is reversible with one click.

In the browser (2 minutes):

1. github.com/pmenapoly/MenapolyRelay → **Actions**.
2. Left list → **Deploy Menapoly Cue to Cloudflare** → **⋯** (top right) → **Disable workflow**.
3. Left list → **Deploy Preview (menapoly-cue-preview)** → **⋯** → **Disable workflow**.

Or with the GitHub CLI on your Mac:

```sh
gh workflow disable "Deploy Menapoly Cue to Cloudflare" -R pmenapoly/MenapolyRelay
gh workflow disable "Deploy Preview (menapoly-cue-preview)" -R pmenapoly/MenapolyRelay
gh workflow list --all -R pmenapoly/MenapolyRelay      # both must show "disabled_manually"
```

Leave "CI Checks", "Verify Cue" and "Security readiness (no deploy)" enabled: they never deploy.
`cloud/control-plane/pilot/preflight.py` re-checks both states and refuses the pilot deploy while either is active.

**This resolves the gate for the pilot.** With both disabled, no push can deploy the vulnerable Relay build, and
adding Access settings for the pilot can't unlock the preview deploy either.

## 2. Cloudflare Access configuration required (verified against the code, not yet against your account)

| Requirement | Why | Checked by |
|---|---|---|
| Zone `menapoly-digital.com` active in the same Cloudflare account | the Worker's custom domain and Access both need it | preflight §2 |
| Zero Trust organization (team domain `<team>.cloudflareaccess.com`) | issues and signs the login tokens | preflight §3 |
| Access app **"Menapoly Cue"**, self-hosted, domain `cue.menapoly-digital.com` (whole host), policy **Allow** → *Emails* → your address only | everyone else gets the Access login page and can't get past it | preflight §3 (rejects Bypass / Everyone / IP-range policies) |
| Access app **"Menapoly Cue – Mac worker"**, self-hosted, domain `cue.menapoly-digital.com/v1/worker`, policy **Service Auth** → the service token "menapoly-mac" only | the Mac authenticates without a browser; nothing on the host is public | preflight §3 |
| **No Bypass policies anywhere** on the host | client review links stay off in the pilot | preflight + `PUBLIC_REVIEW=disabled` in the Worker |
| Session duration 24 hours (suggested; at most 1 week) | phone stays signed in for a working day | preflight prints it |
| Worker secrets `CF_ACCESS_AUD` (the people app's AUD tag) and `CF_ACCESS_TEAM_DOMAIN` | the Worker verifies the token's signature, audience, issuer and expiry itself, so Access is not the only lock | `cloud/control-plane/test/access.test.ts` (5 tests), `test_cloud_e2e.py` production-mode tests |

Two independent locks: Access at the edge, and the Worker's own JWT check plus the email allowlist. If either is
misconfigured, the other still refuses. With Access settings missing, the Worker answers 503 to every private route.

## 3. Can the Relay hotfix be deployed without exposing the application?

Re-verified today on `hotfix/access-identity-minimal` (`fc8457e`, 6 files on top of `main`): typecheck ✓, lint ✓,
`npm test` (build + rendered HTML) ✓, the 10 identity tests from the security branch ✓ (forged headers authenticate
nobody, fail closed without Access settings, valid RS256 Access JWT accepted, invalid ones rejected, every API entry
point answers 401 without credentials), `wrangler deploy --dry-run` ✓ (`CUE_AUTH_MODE=cloudflare-access` is bound).

| Question | Answer |
|---|---|
| Does any data route answer without a verified Access JWT? | No. Every handler in `app/api/assets`, `app/api/os` and `app/api/uploads` returns 401 when there is no user, and in Access mode the only user source is a verified JWT. `/api/health` (no data) and static files are public. |
| What happens in the seconds between `wrangler deploy` and the workflow's `secret put` steps? | The new code sees `CUE_AUTH_MODE=cloudflare-access` without settings → "misconfigured" → nobody is signed in (fail closed). A short outage, not an exposure. |
| What about the `*.workers.dev` address? | Relay's `wrangler.jsonc` doesn't set `workers_dev`, so a `*.workers.dev` URL exists outside Access. With the hotfix it's still safe, because no request there carries a valid Access JWT, so the data routes answer 401. Recommended hardening when you approve the Relay deploy: set `"workers_dev": false` once Relay has its own custom domain. |
| Can the deploy happen by accident? | Not once S1 is done. With the hotfix merged, the deploy workflow itself also refuses to run without both Access secrets. |

**Conclusion:** yes, the hotfix can be deployed without exposing the application, provided Relay's Access
secrets are set first. Merging and deploying it is a **separate** approval (checklist item **R1**). It isn't needed
for the Cue pilot.

## 4. Relay and the Cue pilot stay separate

| | MenapolyRelay | Menapoly Cue pilot |
|---|---|---|
| Worker | `menapoly-cue-production` | `menapoly-cue-cloud` |
| D1 | `menapoly-cue-production` | `menapoly-cue-cloud` |
| Media | Relay's R2 binding | `menapoly-cue-media` (presigned URLs only, no binding) |
| Hostname | (Relay's own) | `cue.menapoly-digital.com` |
| Deploys from | GitHub Actions (disabled by S1) | your Mac, by hand, with `pilot/provision.sh` (no CI deploy exists) |
| Connector | Cut Cue's `relay.py` stays unconfigured (no `CUE_RELAY_URL`) | not used in the pilot |

`cloud/control-plane/test/config.test.mjs` fails the build if the pilot config ever reuses Relay's Worker or D1
name, binds a shared R2 bucket, re-enables `workers_dev`/preview URLs, or turns on cloud processing or client links.
