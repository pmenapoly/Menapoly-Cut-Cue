# Menapoly Cue private pilot: launch request (workers.dev + Access, Workers Free)

**Address:** `https://menapoly-cue-cloud.pmenapoly.workers.dev` (subdomain confirmed 2026-10-21; the preflight refuses
any other), for you only, behind Cloudflare Access.
**No DNS or nameserver change** ([domain-options.md](domain-options.md)).

**Untouched by every step below:**
- Canva DNS and the Canva website;
- Zoho email;
- the existing **Growth Loop** Worker (`prissly-growth-loop-staging`): the pilot only ever deploys or deletes `menapoly-cue-cloud`;
- MenapolyRelay and its disabled deploy workflows.

Status 2026-10-21: **nothing deployed, created, purchased or changed** in GitHub settings, Cloudflare, Canva or DNS.

## Security review results (read-only)

### SCRUB-1 and the public Git history

| Question | Finding |
|---|---|
| Credentials, keys, tokens, `.env` files, account IDs anywhere in the history (23 commits, both branches)? | **None.** Only placeholders and fake test values |
| Client data, real emails or phone numbers, business documents, the Growth Loop Worker? | **None.** All emails and phone numbers are test placeholders; screenshots use test data |
| MenapolyRelay security details? | **Yes**, in 6 commits on `menapoly-cue-2.0` only (11f268d, 24cffa6, a2fb38b, 01c6d45, 2915aa2, eb7c3ca). The default branch has none |
| What SCRUB-1 changes | A docs-only commit, drafted locally and **not pushed**. It deletes `docs/cue2/security-launch.md` and rewrites `docs/cloud/pilot/security-gate.md` for workers.dev. In 9 other docs it replaces Relay's bypass description, probe command, secret status, commit IDs and branch names with "tracked in the private MenapolyRelay repository". No code or tests change |
| What SCRUB-1 leaves | **The history**: anyone can still open the 6 old commits. Also a local-development option in `backend/cutcue/relay.py` that names the Relay preview header, Relay's Worker name in a config test, and Relay's two workflow names (the preflight needs them) |
| Removing it from history too | **SCRUB-2** (optional): rewrite and force-push `menapoly-cue-2.0`, which changes all 12 of its commit IDs. GitHub can keep old commits reachable by ID until it cleans up (GitHub Support can purge them). The repository has 0 forks. Recommended only if Relay turns out to be live (check R-1) |

### Is every endpoint behind Access before any data can be uploaded?

| Check | Result |
|---|---|
| New test: every route in `src/index.ts` (45+), called with no token, a garbage Access token, forged identity headers and a fake worker token, in production settings | **All refused** (401, or 403 for the disabled review links). `/v1/health` returns only `ok`, `service`, `version` and `environment`. **Zero rows** written to projects, uploads, assets, jobs, workers, actions or versions |
| Order of operations | The deploy is refused unless both Access apps already cover the workers.dev hostname with no Bypass or Everyone rule, and the AUD and team domain match the Worker secrets. Access secrets go into the **same** deploy as the code |
| After deploy (tightened today) | Every people path (`/`, `/review.html`, `/v1/health`, `/v1/projects`, `/v1/library`, review links) must be **redirected to Cloudflare's sign-in**. A Worker-side 401 now counts as a failure, because it means Access isn't in front. Any failure removes the Worker automatically, before you could upload anything |
| Media | Uploads and downloads use signed R2 links (15 and 10 minutes) that only the Access-protected API issues; the bucket is private and CORS allows only the pilot address |

## Minimum approvals

| Code | What | Cost |
|---|---|---|
| **SCRUB-1** | Push the reviewed docs-only commit | free |
| **GH-A** | Add `.github/workflows/pilot.yml` to the default branch (the default branch itself stays) | free |
| **GH-2** | Environment `menapoly-cue-pilot` (you as reviewer, admin bypass off, `menapoly-cue-2.0` only) + its secrets | free |
| **GH-4** | Read-only `RELAY_ACTIONS_TOKEN` (the preflight confirms Relay's workflows stay disabled) | free |
| ~~CF-SUB~~ | Not needed: `pmenapoly.workers.dev` already exists. **Don't rename it** (Growth Loop's address would change) | — |
| **C3-P** | Cloudflare API token, account-level, no Zone permissions | free |
| **PROD-1** | Zero Trust Free: team, service token, two self-hosted Access apps on the Cue hostname only | free |
| **PAID-2** | Enable R2 (requires a payment method; free up to 10 GB) | $0 expected |
| **PROD-2** | Run **provision** (D1, private bucket, queues for Cue only) | free |
| **PROD-3** | Run **deploy** | free |

Recommended but optional: **GH-3** (protect the branch). Only if asked: **PAID-0** (Zero Trust card prompt).
Not requested: Workers Paid, DNS or nameserver changes, "Protect all Workers" (it would also put Growth Loop behind
sign-in), the Mac worker, client links, SMS, cloud rendering, re-enabling Relay workflows.

## Launch checklist (one step at a time; each waits for the approval named)

1. **R-1 to R-3 (read-only):**
   - Is any Relay app live? Check Workers & Pages, and ChatGPT → Sites.
   - Does a workers.dev subdomain already exist (Workers & Pages → Account details)?
   - Plan = Free?
2. **SCRUB-1:** I push the reviewed commit.
3. **GH-A:** on github.com, switch to branch `ccr-f6eeb6a3-yozzh0` → *Add file → Create new file* →
   `.github/workflows/pilot.yml` → paste the file from `menapoly-cue-2.0` → *Commit directly*.
4. **GH-2 and GH-4:**
   - Settings → Environments → `menapoly-cue-pilot` → required reviewer = you, *Allow administrators to bypass* off,
     branch `menapoly-cue-2.0`.
   - Create the read-only Relay token and add it as an environment secret.
   - Confirm Settings → Secrets → **Repository secrets** is empty.
5. **CF-SUB** (only if step 1 found no subdomain).
6. **C3-P:**
   - Create the API token: *Account* → Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Queues Edit, Account
     Settings Read, Access: Apps and Policies Read, Access: Organizations, Identity Providers, and Groups Read.
   - Add the environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   - Actions → *Menapoly Cue pilot* → *Run workflow* → branch `menapoly-cue-2.0`, action **check**, phrase
     `check the pilot` → approve. The log shows the exact Cue address. Access shows NOT YET.
7. **PROD-1:**
   - Zero Trust → set the team name.
   - Create the service token `menapoly-mac`.
   - Create self-hosted app "Menapoly Cue" for the address from step 6 (Allow → Emails → you; 24 h session).
   - Create self-hosted app "Menapoly Cue – Mac worker" for the same address, path `v1/worker`, Service Auth → `menapoly-mac`.
   - Add the environment secrets `CF_ACCESS_AUD` (the first app's AUD), `CF_ACCESS_TEAM_DOMAIN` and `OWNER_EMAILS`.
   - Run **check** again: Access must be OK.
8. **PAID-2 and PROD-2:**
   - Enable R2.
   - Run **provision** (phrase `I approve creating the pilot resources`), then save the printed D1 id as
     `D1_DATABASE_ID`.
   - Create an R2 token for the bucket `menapoly-cue-media` only, and add `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and
     `S3_SECRET_ACCESS_KEY`.
9. **PROD-3:** run **deploy** (phrase `I approve deploying the Menapoly Cue pilot`). The run ends either "Deployed and
   verified at https://…" or removes the Worker.
10. **Open it:** Chrome on the iMac → the address → sign in with your email → the real-device checklist in
    [browser-first.md §7](browser-first.md). On Android: Chrome → the address → sign in → ⋮ → *Install app*.

**Stop at any time:** run **rollback** (phrase `I approve removing the pilot Worker`). It deletes only
`menapoly-cue-cloud`; data in D1 and R2 is kept.
