# Cost estimate and budget controls

Nothing has been purchased. These figures come from Cloudflare's published list prices as I know them (mid-2026).
**Check cloudflare.com/plans and the R2, D1 and Queues pricing pages before you buy anything.**

## Monthly estimate (one owner, a few clients)

| Item | Needed? | Price | Expected usage | Estimate |
|---|---|---|---|---|
| Workers Paid plan | Yes (Queues need it) | $5/month, includes 10M requests and 30M CPU-ms | a few thousand requests/day | **$5.00** |
| D1 | Yes | included in Workers Paid (25B rows read, 50M rows written, 5 GB) | tiny | $0 |
| Queues | Yes | 1M operations/month included, then $0.40/M | hundreds of events | $0 |
| R2 Standard storage | Yes | first 10 GB free, then $0.015 per GB-month; **no egress fees** | 100 GB → $1.35; 500 GB → $7.35; 1 TB → $15.21 | **$1–15** |
| R2 operations | Yes | Class A 1M free then $4.50/M; Class B 10M free then $0.36/M | 10 GB upload ≈ 1,300 part PUTs | $0 |
| Cloudflare Access (Zero Trust Free) | Yes | free up to 50 users | 1–3 people | $0 |
| Email Routing `send_email` | Optional | free (verified destination addresses only) | a few emails/day | $0 |
| Domain | Probably already owned | ~$10–15/year if new | — | ~$1 |
| Mac worker | Yes | your electricity | — | — |
| Cloud render worker | **No** (off) | not built; would need explicit authorization per job | — | $0 |
| AI | Mac pipeline makes no paid calls | — | — | $0 |

**Typical total: about $6–12 per month** for a few hundred GB of footage. Storage is the only thing that grows; deleting
finished projects' sources keeps it down. The Settings page shows stored GB and the R2 estimate.

(The existing desktop editor's Claude features keep their own per-project budget, unchanged.)

## Budget controls in the product

- `CLOUD_RENDERING=disabled` in `wrangler.jsonc`. With that setting a cloud job can't be created (409).
- If it is ever enabled, a cloud job starts in `awaiting_authorization` and only the **owner** can release it by typing
  `I authorize this paid cloud job` and a dollar cap (≤ $100). Each authorization is recorded and audited.
- Per-project AI budget (`budget_usd`, default $5, owner-editable, 0–1000) and spent amount from the cost ledger. The
  agent receives the remaining budget with each lease. Costs are recorded only from real measured amounts; the Mac
  pipeline reports $0 because it makes no paid calls.
- Monthly dashboard: `GET /v1/costs?month=YYYY-MM` (Settings → Costs), by kind and by project, plus stored GB.
- Recommended outside the app: a Cloudflare billing notification at $10 and $25, and an R2 bucket lifecycle rule
  (e.g. abort incomplete multipart uploads after 2 days; the app's cron also does this).
