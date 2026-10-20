# Where Cue lives: domain options (researched 2026-10-20)

Your situation:
- `menapoly-digital.com` is registered with Canva, and Canva runs its nameservers.
- The website is on Canva (A records → `103.169.142.0`), and email is Zoho Mail.
- Cloudflare has the domain *added but not activated*. Its nameservers were never changed.

Goal: open Cue privately in Chrome without touching the website or email.

## What the official documentation says

| Fact | Source |
|---|---|
| Changing a Canva domain's nameservers **stops the Canva website from working**. You then configure all DNS yourself; Canva keeps the registration, and you can **Reconnect** Canva's nameservers later | [Canva: Change your domain's nameservers](https://www.canva.com/help/changing-domain-nameservers/) |
| With custom nameservers, DNS changes made in Canva no longer apply | [Canva: Website DNS settings](https://www.canva.com/en_au/help/dns-settings/) |
| Making only `cue.menapoly-digital.com` its own Cloudflare zone (**subdomain setup**) is **Enterprise only** | [Cloudflare: Subdomain setup](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/) |
| Keeping your DNS elsewhere and pointing single names at Cloudflare by CNAME (**partial / CNAME setup**) is **Business or Enterprise only** | [Cloudflare: Partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/) |
| A Worker **Custom Domain** (what `cue.menapoly-digital.com` needs) requires the zone to be active in the same account | [Cloudflare: Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) |
| A Worker's **`workers.dev` hostname can be protected by Cloudflare Access**, either as a self-hosted Access application with that hostname or with Access attached to the Worker | [Cloudflare: Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [changelog 2026-08-14](https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/) |
| Cloudflare for SaaS (customer CNAMEs onto your zone) includes 100 hostnames on Free, but needs **a different domain already active on Cloudflare** | [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/) |
| Zero Trust Free covers up to 50 users at $0 | [Cloudflare Zero Trust plans](https://www.cloudflare.com/plans/sase-zero-trust.md) |
| Nothing in GitHub changes with the address: the workflow, environment approval and secrets work the same | repository review |

## The options

**A. Keep Canva nameservers and delegate only `cue` to Cloudflare.** **Not possible on Cloudflare Free:**
- A subdomain zone needs Enterprise.
- A CNAME setup needs Business ($200+/month).
- A Canva CNAME pointing at a Worker's address isn't served by Cloudflare unless the hostname is set up in the serving account. That again needs the zone on Cloudflare, or Cloudflare for SaaS with a second domain already on Cloudflare (a new purchase).

**B. Move DNS to Cloudflare, keep Canva as registrar and site host.** Possible on Free, but:
- **Canva states the website stops working** when the nameservers change. That alone fails the "no disruption" goal.
- **Email risk:** Cloudflare's import only finds common record names. It found 2 TXT records, so Zoho's DKIM key (a `…._domainkey` TXT record) and DMARC may be missing. Leaving them out would hurt email delivery.
- If DNSSEC is on at Canva, it must be turned off first or the domain stops resolving.
- The imported `_acme-challenge` CNAME is proxied. It would need to be *DNS only* for certificate checks.
- Rollback means Canva → Reconnect nameservers, then hours of propagation.

**C. Recommended: the Worker's own `workers.dev` address behind Cloudflare Access.**
- Cue lives at `https://menapoly-cue-cloud.<your-subdomain>.workers.dev`.
- **No DNS change, no nameserver change**: `menapoly-digital.com`, the Canva website and Zoho email are not touched at all.
- Free.
- The certificate is automatic (Cloudflare's own `workers.dev` certificate).
- It has the same Access protection: sign-in at Cloudflare's edge, plus the Worker's own check of the Access token and your email.
- `cue.menapoly-digital.com` can come later without rebuilding anything.

## Comparison

| | A: delegate `cue` only | B: Cloudflare DNS | **C: workers.dev + Access** |
|---|---|---|---|
| Website downtime risk | none | **high**: Canva says the site stops working | **none** (not touched) |
| Zoho email risk | none | **medium**: records missed by the import | **none** (not touched) |
| Monthly cost | Business plan $200+, or Enterprise | $0 | **$0** |
| Setup complexity | n/a on Free | high (full DNS copy, DNSSEC, verification) | **low** (no DNS) |
| Fits the existing workflow | n/a | yes (`custom-domain` target) | **yes** (`workers-dev` target, built and tested) |
| Cloudflare Access | yes | yes | **yes** (self-hosted app on the workers.dev hostname) |
| SSL certificate | yes | yes, after DNS-only fixes | **automatic** |
| Launch time | n/a | hours to 2 days (propagation, fixes) | **about 1 hour of clicks, no waiting** |
| Rollback | n/a | Reconnect Canva nameservers + propagation | **one workflow run** (`rollback` deletes the Worker) |

**Recommendation: C now. Choose the custom domain later.** When you want `cue.menapoly-digital.com`, the realistic
routes are:
- move the website off Canva, then move DNS (option B, done carefully with every Zoho record checked); or
- use Cloudflare for SaaS with a second domain.

Both are separate decisions.

## What changed in the repository (tested; nothing deployed)

| Area | Change |
|---|---|
| `.github/workflows/pilot.yml` | Pins `PILOT_TARGET: workers-dev`. Gate, branch lock, typed phrase, environment approval and private-repository guard are unchanged |
| Wrangler configuration | Committed `wrangler.jsonc` unchanged (custom domain kept for later). The workflow writes a temporary copy with `workers_dev: true`, no custom-domain route, and `preview_urls: false`. An offline `wrangler deploy --dry-run` of that copy passes |
| DNS provisioning | **None.** No DNS record is created for `workers-dev` |
| Preflight | Looks up the account's workers.dev subdomain and checks that exact hostname. It skips the `menapoly-digital.com` zone checks and never reads that zone. It still requires both Access apps (people app: email only; `/v1/worker`: Service Auth only), with no Bypass or Everyone rules and matching AUD and team domain. After deploy it probes the workers.dev address and removes the Worker if anything answers without sign-in |
| R2 CORS | Generated for the pilot's actual address instead of the custom domain |
| Rollback | Same `rollback` action. For workers.dev there's no DNS record to clean up |
| Environment secrets | Same names. The Cloudflare API token no longer needs any **Zone** permission (zone read, DNS read, Workers Routes) |
| Tests | 22 workflow and preflight tests, including a fail-closed preflight without Access or without a workers.dev subdomain, and proof that `menapoly-digital.com` is never read |

Not verified until you do it: Zero Trust accepting the workers.dev hostname as an Access application *before* the
Worker exists. Cloudflare's docs describe the hostname method but don't say whether the Worker must exist first. If the
dashboard refuses, stop: nothing is exposed (no Worker exists yet), and I'll add a step that uploads the Worker with no
address first.

## The Cloudflare zone you started

Leave it as it is: **don't click through activation and don't change nameservers.** While the nameservers stay with
Canva, the pending zone and its imported records (including the proxied `_acme-challenge`) have no effect on the
website or email. The `workers-dev` target never uses it.
