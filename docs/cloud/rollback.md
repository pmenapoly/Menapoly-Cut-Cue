# Rollback

The cloud layer is additive: the desktop editor (`python -m cutcue`) and its data don't depend on it, and the agent
uses its own data directory. Rolling back the cloud never touches local projects.

| Situation | Action |
|---|---|
| Bad Worker deploy | `npx wrangler deployments list`, then `npx wrangler rollback <deployment-id>` (instant; D1/R2 untouched) |
| Stop all remote access now | Zero Trust → Access → the app → policy to *Block* (or delete the custom-domain route). Review links stop too. |
| Lost/stolen Mac or leaked worker token | Settings → Mac workers → Remove (token dead immediately; its jobs requeue) |
| Leaked review link | Project → Review links → Turn off |
| Stop the Mac worker | `scripts/install_agent_launchd.sh --remove` (or `launchctl bootout gui/$(id -u)/com.menapoly.cue.agent`) |
| Bad D1 migration | Migrations only add. Use D1 Time Travel: `npx wrangler d1 time-travel restore menapoly-cue-cloud --timestamp=<before>` |
| Leaked R2 keys | Revoke the R2 API token in the dashboard, create a new one, `wrangler secret put S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` |
| Remove the cloud layer entirely | Delete the Worker, Access app, queues; export anything you need from R2 (`rclone`/`wrangler r2 object get`), then delete the bucket and D1 database |

Backups: D1 has Time Travel (30 days on paid plans); `npx wrangler d1 export menapoly-cue-cloud --remote --output
cue-cloud.sql` makes a portable copy. R2 objects keep their SHA-256 in D1, so a copy can be verified. The local editor
keeps its own checksummed backups (`make backup`).
