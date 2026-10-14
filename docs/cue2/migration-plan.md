# Database migration plan

Cut Cue uses ordered, append-only SQL migrations in `backend/cutcue/db.py` (`MIGRATIONS`), applied at startup inside a
transaction and recorded in `schema_version`. Old entries are never edited.

## Migration 5 (this release) — additive only

| Change | Why |
|---|---|
| `clients` table; `projects.client_id` (FK, `ON DELETE SET NULL`), `projects.stage` (default `draft`), `projects.archived_at` | client association, workflow stage, archive instead of delete |
| `review_links` (token **hash** only), `review_events` | client review links and timecoded feedback |
| `notifications` with `UNIQUE(source_key)` | in-app notification center, dedupe |
| `cue_actions` | approval-gated actions (proposed → running → executed/failed, or rejected) |
| `ask_messages`, `app_kv` | Ask Cue history and global AI spend |
| `library_items` | brand kits and templates |
| `upload_links` | private phone/text upload links |
| `text_senders`, `text_messages` with `UNIQUE(provider, provider_id)` | Cue Text consent records, audit history, dedupe |

Existing rows are untouched: existing projects get `stage='draft'` (moved to `editing` automatically when media is
transcribed or a final render finishes) and no client.

## Upgrading an existing install

1. Stop the app. Back up `data/` (the SQLite file `data/cutcue.sqlite3` plus media). `cp -a data data.bak-$(date +%F)`.
2. `git checkout menapoly-cue-2.0 && make setup && make start`. Migration 5 runs automatically on first start.
3. Verify: `sqlite3 data/cutcue.sqlite3 'select version from schema_version'` → `5`.

Rollback: stop the app, restore the `data.bak-*` copy, check out the previous commit. (SQLite `DROP COLUMN` is not
used for downgrade; restoring the backup is the supported path.) `test_migrations.py` upgrades a v1 database to the
latest version with data preserved.

## Future (not built)

- Relay connector tables (`remote_publications`: render_id ↔ Relay version id) when publishing to Cloudflare is added.
- Multi-user: not planned for this local app; Relay owns roles.
