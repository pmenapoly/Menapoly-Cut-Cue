# Security gate (must hold before any pilot deployment)

## 1. Resolved: MenapolyRelay's deploy workflows are disabled (S1)

Done 2026-10-20 with the owner's approval. MenapolyRelay's two deploy workflows, "Deploy Menapoly Cue to
Cloudflare" and "Deploy Preview (menapoly-cue-preview)", are `disabled_manually`. No files were deleted and nothing
was merged. `cloud/control-plane/pilot/preflight.py` re-checks both states and refuses every pilot provision or deploy
while either one is active. The workflows that never deploy stay on: CI Checks, Verify Cue, Security readiness.

Relay's own security work is tracked in the private MenapolyRelay repository, not in this public one. Don't re-enable
those workflows from here.

## 2. Cloudflare Access configuration required (checked by the preflight before every deploy)

The pilot address is the Worker's workers.dev hostname, `menapoly-cue-cloud.<subdomain>.workers.dev`
([domain-options.md](domain-options.md)).

| Requirement | Why | Checked by |
|---|---|---|
| Zero Trust organization (team domain `<team>.cloudflareaccess.com`) | issues and signs the sign-in tokens | preflight §3 |
| Access app **"Menapoly Cue"**, self-hosted, the whole workers.dev hostname, policy **Allow** → *Emails* → your address only | everyone else gets the Access login page and can't get past it | preflight §3 (rejects Bypass, Everyone and IP-range policies) |
| Access app **"Menapoly Cue – Mac worker"**, self-hosted, same hostname, path `v1/worker`, policy **Service Auth** → the service token `menapoly-mac` only | the Mac signs in without a browser; nothing on the host is public | preflight §3 |
| **No Bypass policies** on the host | client review links stay off in the pilot | preflight + `PUBLIC_REVIEW=disabled` in the Worker |
| Session duration 24 hours (suggested; at most 1 week) | stays signed in for a working day | preflight prints it |
| Worker secrets `CF_ACCESS_AUD` (the people app's AUD tag) and `CF_ACCESS_TEAM_DOMAIN` | the Worker verifies the token's signature, audience, issuer and expiry itself, so Access isn't the only lock | `cloud/control-plane/test/access.test.ts`, `test_cloud_e2e.py` production-mode tests |

There are two independent locks: Access at the edge, and the Worker's own token check plus the email allowlist. If one
is misconfigured, the other still refuses. With the Access settings missing, the Worker answers 503 to every private
route. After each deploy, the workflow probes the address without signing in, and removes the Worker unless every probe
is sent to sign-in or refused.

## 3. MenapolyRelay and the Cue pilot stay separate

| | MenapolyRelay | Menapoly Cue pilot |
|---|---|---|
| Worker | its own | `menapoly-cue-cloud` |
| D1 | its own | `menapoly-cue-cloud` |
| Media | its own | `menapoly-cue-media` (presigned URLs only, no binding) |
| Deploys from | its own workflows (disabled) | `.github/workflows/pilot.yml` (manual, owner-approved) |
| Connector | Cut Cue's `relay.py` stays unconfigured | not used in the pilot |

`cloud/control-plane/test/config.test.mjs` fails the build if the pilot config ever reuses Relay's Worker or D1 name,
binds a shared R2 bucket, or turns on cloud processing or client links.
