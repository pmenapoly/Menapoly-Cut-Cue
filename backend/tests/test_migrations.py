import sqlite3

from cutcue import db as dbmod


def test_upgrade_from_v1_adds_job_timing(tmp_path):
    path = tmp_path / "old.sqlite3"
    conn = sqlite3.connect(path)
    conn.executescript(f"CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1);"
                       f"{dbmod.MIGRATIONS[0]}")
    conn.execute("INSERT INTO projects (id, name, created_at, budget_usd) VALUES ('prj_0000000000000000', 'Old', 0, 5)")
    conn.commit()
    conn.close()
    database = dbmod.Database(path)
    assert database.one("SELECT version FROM schema_version")["version"] == len(dbmod.MIGRATIONS)
    cols = {r["name"] for r in database.all("PRAGMA table_info(jobs)")}
    assert {"started_at", "finished_at"} <= cols
    assert database.one("SELECT name FROM projects")["name"] == "Old"


def test_job_timing_recorded(client, services, fixture_dir):
    from conftest import upload, wait_jobs

    pid = client.post("/api/projects", json={"name": "Timing"}).json()["id"]
    upload(client, pid, fixture_dir / "market-mocha-interview.mp4", chunk=8 * 1024 * 1024)
    wait_jobs(services)
    for job in services.list_jobs(pid):
        assert job["started_at"] and job["finished_at"] >= job["started_at"]
