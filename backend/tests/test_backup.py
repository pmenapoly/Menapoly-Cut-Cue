"""Backup and restore: consistent snapshot while running, checksum verification, tamper detection, restore that
moves the old data aside, and a restored data folder that a fresh app serves identically."""
import json
import sqlite3

import pytest
from conftest import upload, wait_jobs

from cutcue.backup import create_backup, restore_backup, verify_backup


def test_backup_restore_roundtrip(client, services, settings, fixture_dir, tmp_path):
    pid = client.post("/api/cue/projects", json={"name": "Backup me", "client": "Acme"}).json()["id"]
    video = upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    wait_jobs(services)
    seq = client.post(f"/api/projects/{pid}/sequences", json={"name": "Main", "timeline": {
        "clips": [{"asset_id": video["id"], "start": 0, "end": 4}]}}).json()
    rid = client.post(f"/api/projects/{pid}/renders", json={"version_id": seq["current_version_id"]}).json()["id"]
    wait_jobs(services)

    dest = create_backup(settings.data_dir, tmp_path / "backups")  # while the app is running
    check = verify_backup(dest)
    assert check["ok"] and check["counts"]["projects"] == 1 and check["counts"]["renders"] == 1 and check["files"] > 3
    assert check["counts"]["schema_version"] == services.db.one("SELECT version FROM schema_version")["version"]

    # Tampering is detected.
    manifest = json.loads((dest / "manifest.json").read_text())
    media = next(k for k in manifest["files"] if k.endswith(".mp4") and "/renders/" in k)
    original = (dest / media).read_bytes()
    (dest / media).write_bytes(original[:-10] + b"x" * 10)
    assert not verify_backup(dest)["ok"]
    with pytest.raises(ValueError, match="verification"):
        restore_backup(dest, tmp_path / "restored")
    (dest / media).write_bytes(original)

    # Restore into a folder that already has data: the old folder is moved aside, not deleted.
    target = tmp_path / "restored"
    target.mkdir()
    (target / "keep.txt").write_text("previous data")
    result = restore_backup(dest, target)
    assert result["counts"] == check["counts"]
    assert (tmp_path / result["previous_data_moved_to"].split("/")[-1] / "keep.txt").read_text() == "previous data"

    # A fresh app on the restored folder serves the same project, edit and playable render.
    from fastapi.testclient import TestClient

    from cutcue.config import Settings
    from cutcue.main import create_app
    from cutcue.services import Services

    s2 = Settings(data_dir=target, transcriber="fixture")
    with TestClient(create_app(s2, Services(s2))) as c2:
        card = c2.get(f"/api/cue/projects/{pid}").json()
        assert card["project"]["client_name"] == "Acme" and card["renders"][0]["id"] == rid
        mp4 = c2.get(f"/api/projects/{pid}/renders/{rid}/mp4")
        assert mp4.status_code == 200 and mp4.content == services.render_file(pid, rid, "mp4").read_bytes()


def test_database_only_backup_and_guards(settings, services, tmp_path):
    services.create_project("Only DB")
    dest = create_backup(settings.data_dir, tmp_path / "b", include_media=False)
    assert list(json.loads((dest / "manifest.json").read_text())["files"]) == ["cutcue.sqlite3"]
    conn = sqlite3.connect(dest / "cutcue.sqlite3")
    assert conn.execute("SELECT name FROM projects").fetchone()[0] == "Only DB"
    conn.close()
    with pytest.raises(ValueError, match="outside the data folder"):
        create_backup(settings.data_dir, settings.data_dir / "nested")
