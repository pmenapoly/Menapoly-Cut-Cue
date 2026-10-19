# Expected monthly charges (pilot)

Prices from Cloudflare's published pricing pages, checked 2026-10-19 (sources at the end). Cloudflare can change
prices; the checkout screen is authoritative. Sales tax/VAT is added where it applies.

## What you'd be billed

| Line | Billed? | Exact price | Pilot usage | Expected charge |
|---|---|---|---|---|
| **Workers Paid plan** | yes, if you choose it (see options below) | **$5.00 / month** flat per account; includes 10 million requests and 30 million CPU-ms; then $0.30 per extra million requests and $0.02 per extra million CPU-ms | a few thousand requests a day; static files don't count as Worker requests | **$5.00** |
| D1 (database) | included | Paid: first 25 billion rows read, 50 million rows written and 5 GB storage per month included; then $0.001 per million rows read, $1.00 per million rows written, $0.75 per GB-month | well under 1 million rows/month, < 50 MB | **$0.00** |
| Queues | included | Paid: first 1 million operations/month included; then $0.40 per million (an operation is each 64 KB written, read or deleted) | ~3 operations per event, a few hundred events | **$0.00** |
| Cron trigger | included | no separate charge | every 5 minutes | **$0.00** |
| R2 storage (Standard) | only above 10 GB | first **10 GB-month free**, then **$0.015 per GB-month** | your footage + exports | see table below |
| R2 operations | only above free tier | Class A (writes, multipart parts, lists): 1 million/month free, then $4.50 per million. Class B (reads, HEAD): 10 million/month free, then $0.36 per million | a 1 GB upload ≈ 65 Class A operations; a download ≈ 1 Class B | **$0.00** |
| R2 egress (downloads) | never | **$0**: R2 has no egress fees | | **$0.00** |
| Cloudflare Access (Zero Trust Free) | no | free for up to 50 users | 1 person + 1 service token | **$0.00** |
| DNS / certificate for `cue.` | no | included with the zone | | **$0.00** |
| Domain renewal | already yours | your registrar's yearly price | unchanged | — |
| SMS, cloud rendering, paid AI | **off** | not used | | **$0.00** |

### Storage (the only line that grows)

| Footage kept in the pilot | R2 charge per month |
|---|---|
| up to 10 GB | $0.00 |
| 25 GB | $0.23 |
| 50 GB | $0.60 |
| 100 GB | $1.35 |
| 250 GB | $3.60 |
| 500 GB | $7.35 |

(GB-month = average stored per day over the month. A 4K phone video is ~0.4 GB per minute; 1080p ~0.13 GB per minute.)

### Total

- **Workers Paid:** **$5.00/month + $0.015 per GB above 10 GB**. Typical pilot with ≤ 50 GB: **$5.00–$5.60/month**,
  plus tax.
- **Workers Free (see below):** **$0.00 + the same storage**. Typical pilot: **$0.00–$0.60/month**.

## Option: do you need Workers Paid for the pilot?

D1, Queues (10,000 operations/day) and cron are also available on the Workers **Free** plan. Free limits that matter
for this app are 100,000 requests/day (far above pilot use) and **10 ms CPU per request**. Most requests use well under
that (the heaviest is verifying the Access signature), but **I haven't measured CPU time on Cloudflare**. On Free, a
request over the limit fails with an error rather than being charged.

- **Recommended: Workers Paid ($5/month).** It gives CPU headroom and 1M queue operations, and nobody has to worry
  about limits during the pilot.
- **Alternative: start on Free ($0).** Switch to Paid if the dashboard shows CPU-limit errors. Nothing in the code
  changes either way.

Either way, set a billing notification (Billing → Notifications) at **$10** so any surprise is visible.

## Budget controls inside the app

Cloud processing is disabled in configuration, so a cloud job can't even be created. The Mac pipeline makes no paid
AI calls (recorded cost $0). Settings → Costs shows stored GB and the R2 estimate each month.

## Sources

- [Cloudflare Workers pricing (preview copy of the official page)](https://6e8c1c3a.previews.developers.cloudflare.com/workers/platform/pricing/index.md)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare plans](https://www.cloudflare.com/plans/) (Zero Trust Free: up to 50 users)
