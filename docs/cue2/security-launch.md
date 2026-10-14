# Relay identity-header vulnerability: production status, containment and launch plan (2026-10-14)

Everything below comes from GitHub Actions run records and logs (GitHub masks secret values in logs; this document never contains any) and from a new read-only CI workflow that reports only whether each secret is *set* or *missing*. Nothing was merged, deployed or changed in Cloudflare.

## 1. What is in production right now

| Question | Finding | Evidence |
|---|---|---|
| Has the Cloudflare production Worker been deployed by CI? | **No.** All four runs of "Deploy Menapoly Cue to Cloudflare" (Sept 4–9) failed at `wrangler deploy` with "CLOUDFLARE_API_TOKEN … necessary". No later runs. | Actions runs 33905309268 … 34307142156; job log |
| Has the separate preview Worker been deployed? | **No.** All four "Deploy Preview" runs (Sept 10) stopped at the gate, because the Access secrets were missing. | Run 34526027116 |
| Was anything deployed manually from a laptop (`npm run deploy:cloudflare`)? | **Unknown.** Not visible from GitHub. You can check in the Cloudflare dashboard → Workers & Pages for `menapoly-cue-production` / `menapoly-cue-preview`. | — |
| The ChatGPT Sites preview (`.openai/hosting.json`) | **Unknown whether it is live.** Its URL isn't recorded in the repo and I can't see the ChatGPT Sites account. | — |
| Repository secrets **today** | `CLOUDFLARE_API_TOKEN` **set** · `CLOUDFLARE_ACCOUNT_ID` **set** · `CF_ACCESS_AUD` **missing** · `CF_ACCESS_TEAM_DOMAIN` **missing** · `CF_ACCESS_AUD_PREVIEW` **missing** · `CF_ACCESS_SERVICE_TOKENS` **missing** | Run 38647082850, step "Required secrets present?" |

### What that means

1. **No CI-deployed Cloudflare Worker exists, so on Cloudflare (as far as GitHub shows) there is nothing to exploit today.**
2. **There is a live trigger, though.**
   - The Cloudflare token is now set and the Access secrets are not. The **next push or merge to `main`** would run the old deploy workflow and publish the Worker.
   - The old workflow skips the Access step when those secrets are empty. The result would be a public `*.workers.dev` app that accepts `oai-authenticated-user-email` from anyone: full impersonation, with no login at all.
3. **If a Worker was deployed manually**, or the ChatGPT Sites preview is live, its exposure depends on what sits in front of it:
   - **A Cloudflare Worker without Access in front:** anyone can impersonate anyone. **Critical.**
   - **A Cloudflare Worker with Access in front:** any signed-in user, a client for example, can impersonate the owner. **High.**
   - **The ChatGPT Sites preview:** safe *only if* the Sites edge removes client-sent `oai-authenticated-*` headers. That is not verified (see the probe below).

### Safe probe (read-only, uses a non-member email, exposes no data)

Run this if you know a live URL. It tells you whether that deployment accepts client-supplied identity:

```bash
curl -s https://<host>/api/os -H 'oai-authenticated-user-email: probe-not-a-member@example.invalid' | head -c 300
```

| Response | Meaning |
|---|---|
| `{"user":{… "email":"probe-not-a-member@example.invalid" …` | **Vulnerable.** The app trusted your header. Because the email is not a member, the workspace list is empty and no data comes back. |
| Cloudflare Access login page, a redirect, or `{"error":"Sign in required"}` | Not exploitable without signing in first. With Access in front, a signed-in client could still use the header, so the fix is still needed. |

I did not run this probe: I don't have the production URL, and the request is yours to authorize.

## 2. Containment (none of these change production data)

| Option | Effect | Risk | Who |
|---|---|---|---|
| **A. Disable the "Deploy Menapoly Cue to Cloudflare" workflow** (GitHub → Actions → the workflow → "…" → Disable workflow) | Prevents the latent trigger above. Fully reversible. | None. Merges to `main` simply won't deploy. | You (one click) |
| **B. Don't merge anything to `main`** until the fix is in | Same effect, by discipline | Easy to forget | You |
| C. If a Worker exists: in the Cloudflare dashboard, turn off its `workers.dev` route, or put an Access application with an "owner only" policy in front | Stops strangers. Signed-in clients can still impersonate the owner until the code fix ships. | Low | You |
| D. If the ChatGPT Sites preview is live and the probe says vulnerable: unpublish it in ChatGPT Sites | Stops the exposure | Preview users lose access | You |

## 3. Emergency patch (prepared; needs your approval to merge)

- **`hotfix/access-identity-minimal`** (based on production `main`, commit `fc8457e`). It touches 6 files, with no schema or data changes:
  - `app/identity-headers.ts`;
  - `app/chatgpt-auth.ts`;
  - `worker/index.ts`;
  - `wrangler.jsonc` (adds `CUE_AUTH_MODE=cloudflare-access`);
  - `deploy-cloudflare.yml` (refuses to deploy without the Access secrets);
  - `security-readiness.yml` (read-only CI).
- **Verified:**
  - typecheck, lint and `npm test` (build plus rendered bundle);
  - the 10 auth tests run against `main`'s real route code;
  - **GitHub CI on the hotfix branch is green** (run 38647470300). It includes a Wrangler dry run with the production `wrangler.jsonc`, which shows `env.CUE_AUTH_MODE ("cloudflare-access")`.
- **`security/access-identity-headers`** is the same fix on the development line, with 10 tests in the 49-test suite. CI is green (run 38647082850).

Procedure, when you approve:

1. Add the repository secrets `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN`, and create the Access application for the production hostname. The patched workflow refuses to deploy without them.
2. Open a PR from `hotfix/access-identity-minimal` to `main`. Readiness CI runs on the PR.
3. **Merge (your approval).** The workflow deploys. If the Access secrets are missing it stops before deploying.
4. Smoke test (below).
5. Later, merge the full `security/access-identity-headers` (with tests) and `feature/cue-connector`. They contain the same fix, so there are no conflicts in auth code.

## 4. Sign-in methods today and after the fix

| Method | Where | Today | After the fix |
|---|---|---|---|
| Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`, RS256, audience/issuer/expiry/key checked) | Cloudflare deployment with `CF_ACCESS_*` set | Works, but a request with `oai-authenticated-user-email` **bypasses it** | **The only method.** The header is ignored and stripped. |
| ChatGPT Sites headers (`oai-authenticated-user-email`, `…-full-name`) | ChatGPT Sites preview, and **any** deployment (bug) | Trusted from any request | Trusted **only** where `CUE_AUTH_MODE` is unset and Access is unconfigured, i.e. a dedicated Sites build |
| Access service token (`common_name` → mapped email) | — | Not supported | `feature/cue-connector` only, allow-listed via `CF_ACCESS_SERVICE_TOKENS`. Still needs workspace membership. |
| Missing configuration | — | Silently falls back to trusting headers | **Fails closed:** "access required", nobody signed in |

### Keeping a preview, safely

**Recommended: a Cloudflare Access preview, not header trust.**
- Deploy the existing `menapoly-cue-preview` Worker (workflow `deploy-preview.yml` on `claude/mobile-navigation-fix-0x9p89`). Put an Access application on its hostname, set `CF_ACCESS_AUD_PREVIEW`, and invite only preview testers.
- With the fix, the preview verifies Access tokens like production does, and identity headers are ignored.
- Its data is separate (its own D1 and R2), so it can never touch production.

**The ChatGPT Sites preview** can only stay if both of these hold:
- the probe above shows the Sites edge **strips** client-sent headers; and
- it is built without `CUE_AUTH_MODE`. The production `wrangler.jsonc` now sets it, so the Sites build would need its own config.

Until the probe has been run, treat the Sites preview as untrusted. With the fix merged, a Sites build from `main` shows "access required", which is the safe failure.

## 5. What users will notice after the fix

- **Owner and team on the Cloudflare deployment:**
  - nothing changes when signing in through Access;
  - any tool or script that relied on sending `oai-authenticated-user-email` stops working (expected).
- **Clients:** they keep exactly their role and can no longer act as someone else.
- **ChatGPT Sites preview built from `main`:** shows "access required" instead of signing people in.
- **Deploys:** they now **stop** unless both Access secrets exist (the workflow fails with a clear message).
- **Local `npm run dev`:** needs real Access values, or `CUE_AUTH_MODE="chatgpt-sites"` in `.dev.vars` for local-only header testing.

## 6. Rollback

There is no data migration, so rollback is code-only.

1. **Revert the merge commit on `main`.** That auto-deploys the previous code.
   - The previous code is vulnerable, so roll back only for a show-stopping outage.
   - Do it together with containment A or C.
2. **Faster, for a Worker already deployed:** in Cloudflare → Workers → `menapoly-cue-production` → Deployments, "Rollback" to the prior version. The same caveat applies.
3. **If Access secrets are wrong** (everyone sees "access required"): fix `CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN` with `wrangler secret put`. No redeploy is needed.

## 7. Smoke tests after deploying (5 minutes)

1. `GET https://<host>/api/health` returns `{"ok":true,"product":"Menapoly Cue"}`.
2. The owner signs in through Access and sees their workspaces.
3. The probe in section 1, sent **without** an Access session, returns the Access login or 401, never a `"user"`.
4. Signed in as a **client**: repeat an `/api/os` POST (`invite_member`) with an extra `oai-authenticated-user-email: <owner>` header. The answer must be **403**.
5. GitHub → Actions: the deploy run is green and the "Configure Cloudflare Access verification" step ran (not skipped).
