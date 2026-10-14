"""Backup and restore for a Menapoly Cut Cue / Cue 2.0 data folder.

Backup (safe while the app runs):
- the SQLite database is copied with SQLite's online backup API (a consistent snapshot, WAL included);
- media (uploads, derived files, renders) are copied file by file unless ``include_media=False``;
- ``manifest.json`` records the schema version, row counts and a SHA-256 for every file, so a restore can prove the
  backup is complete and unmodified.

Restore (app must be stopped): verifies every checksum first, then moves the current data folder aside
(``<data>.pre-restore-<time>``) instead of deleting it, and copies the backup in. Nothing is ever overwritten in place.

CLI: ``python -m cutcue.backup create [--no-media] [--out DIR]`` · ``verify DIR`` · ``restore DIR [--data DIR]``
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

DB_NAME = "cutcue.sqlite3"
COUNTED = ("projects", "assets", "sequences", "timeline_versions", "renders", "proposals", "review_links", "notifications",
           "cue_actions", "relay_publications")


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _counts(db: Path) -> dict:
    conn = sqlite3.connect(db)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        out = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in COUNTED if t in tables}
        out["schema_version"] = conn.execute("SELECT version FROM schema_version").fetchone()[0]
        return out
    finally:
        conn.close()


def create_backup(data_dir: Path, out_dir: Path | None = None, include_media: bool = True) -> Path:
    data_dir = Path(data_dir).resolve()
    src_db = data_dir / DB_NAME
    if not src_db.is_file():
        raise FileNotFoundError(f"No database at {src_db}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = Path(out_dir or data_dir.parent / "backups").resolve() / f"cutcue-backup-{stamp}"
    if dest == data_dir or data_dir in dest.parents:
        raise ValueError("Put backups outside the data folder (they would be backed up into themselves).")
    dest.mkdir(parents=True, exist_ok=False)
    source = sqlite3.connect(src_db)
    target = sqlite3.connect(dest / DB_NAME)
    try:
        source.backup(target)  # consistent snapshot even while the app writes
    finally:
        target.close()
        source.close()
    files = {DB_NAME: {"size": (dest / DB_NAME).stat().st_size, "sha256": _sha(dest / DB_NAME)}}
    if include_media and (data_dir / "projects").is_dir():
        for f in sorted((data_dir / "projects").rglob("*")):
            if not f.is_file() or f.suffix == ".part":  # unfinished uploads are not worth restoring
                continue
            rel = f.relative_to(data_dir)
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest / rel)
            files[str(rel)] = {"size": f.stat().st_size, "sha256": _sha(dest / rel)}
    manifest = {"format": 1, "created_at": time.time(), "source": str(data_dir), "include_media": include_media,
                "counts": _counts(dest / DB_NAME), "files": files}
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=1))
    return dest


def verify_backup(backup_dir: Path) -> dict:
    backup_dir = Path(backup_dir)
    manifest = json.loads((backup_dir / "manifest.json").read_text())
    problems = []
    for rel, meta in manifest["files"].items():
        f = backup_dir / rel
        if not f.is_file():
            problems.append(f"missing: {rel}")
        elif f.stat().st_size != meta["size"] or _sha(f) != meta["sha256"]:
            problems.append(f"changed: {rel}")
    conn = sqlite3.connect(backup_dir / DB_NAME)
    try:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            problems.append("database integrity check failed")
    finally:
        conn.close()
    return {"ok": not problems, "problems": problems, "counts": manifest["counts"], "files": len(manifest["files"]),
            "include_media": manifest["include_media"]}


def restore_backup(backup_dir: Path, data_dir: Path) -> dict:
    """Restore into data_dir. The app must be stopped. The current data folder is moved aside, never deleted."""
    check = verify_backup(backup_dir)
    if not check["ok"]:
        raise ValueError("Backup failed verification: " + "; ".join(check["problems"][:5]))
    data_dir = Path(data_dir).resolve()
    moved = None
    if data_dir.exists() and any(data_dir.iterdir()):
        moved = data_dir.with_name(f"{data_dir.name}.pre-restore-{time.strftime('%Y%m%d-%H%M%S')}")
        data_dir.rename(moved)
    data_dir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((Path(backup_dir) / "manifest.json").read_text())
    for rel in manifest["files"]:
        (data_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(Path(backup_dir) / rel, data_dir / rel)
    restored = _counts(data_dir / DB_NAME)
    if restored != manifest["counts"]:
        raise ValueError(f"Restored row counts differ from the backup: {restored} vs {manifest['counts']}")
    return {"restored_to": str(data_dir), "previous_data_moved_to": str(moved) if moved else None, "counts": restored}


def main(argv: list[str] | None = None) -> int:
    from .config import load_settings

    settings = load_settings()
    ap = argparse.ArgumentParser(prog="python -m cutcue.backup", description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create", help="back up the data folder (safe while running)")
    c.add_argument("--out", type=Path)
    c.add_argument("--no-media", action="store_true", help="database only")
    v = sub.add_parser("verify", help="check a backup's checksums and database integrity")
    v.add_argument("backup", type=Path)
    r = sub.add_parser("restore", help="restore a backup (stop the app first)")
    r.add_argument("backup", type=Path)
    r.add_argument("--data", type=Path, default=settings.data_dir)
    r.add_argument("--yes", action="store_true", help="confirm: the current data folder will be moved aside")
    args = ap.parse_args(argv)
    if args.cmd == "create":
        dest = create_backup(settings.data_dir, args.out, include_media=not args.no_media)
        print(json.dumps({"backup": str(dest), **verify_backup(dest)}, indent=1))
    elif args.cmd == "verify":
        result = verify_backup(args.backup)
        print(json.dumps(result, indent=1))
        return 0 if result["ok"] else 1
    else:
        if not args.yes:
            print(f"This moves {args.data} aside and restores {args.backup}. Stop the app, then re-run with --yes.")
            return 2
        print(json.dumps(restore_backup(args.backup, args.data), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
