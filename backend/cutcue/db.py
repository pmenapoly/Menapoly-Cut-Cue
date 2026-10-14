"""SQLite persistence with ordered, versioned migrations.

SQLite is the local default. The schema sticks to portable SQL (TEXT/REAL/INTEGER,
JSON stored as TEXT) so a PostgreSQL migration only needs a new connection layer;
the FTS5 search table is the one SQLite-specific piece (swap for tsvector).
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

MIGRATIONS: list[str] = [
    # 1: core schema
    """
    CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at REAL NOT NULL,
        processing_mode TEXT NOT NULL DEFAULT 'local',
        cloud_approved INTEGER NOT NULL DEFAULT 0,
        budget_usd REAL NOT NULL,
        spent_usd REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        duration REAL,
        has_video INTEGER NOT NULL DEFAULT 0,
        has_audio INTEGER NOT NULL DEFAULT 0,
        width INTEGER, height INTEGER, fps REAL,
        probe_json TEXT,
        status TEXT NOT NULL,
        error TEXT,
        thumb_name TEXT,
        proxy_name TEXT,
        created_at REAL NOT NULL
    );
    CREATE INDEX assets_project ON assets(project_id);
    CREATE TABLE uploads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        received INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at REAL NOT NULL
    );
    CREATE TABLE transcript_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        start REAL NOT NULL,
        end REAL NOT NULL,
        text TEXT NOT NULL,
        words_json TEXT,
        source TEXT NOT NULL
    );
    CREATE INDEX segments_asset ON transcript_segments(asset_id, start);
    CREATE VIRTUAL TABLE segments_fts USING fts5(text, content='transcript_segments', content_rowid='id');
    CREATE TRIGGER segments_ai AFTER INSERT ON transcript_segments BEGIN
        INSERT INTO segments_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER segments_ad AFTER DELETE ON transcript_segments BEGIN
        INSERT INTO segments_fts(segments_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TABLE analyses (
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at REAL NOT NULL,
        PRIMARY KEY (asset_id, kind)
    );
    CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        message TEXT,
        payload_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        worker TEXT NOT NULL DEFAULT 'local',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    );
    CREATE INDEX jobs_project ON jobs(project_id, created_at);
    CREATE TABLE sequences (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        current_version_id TEXT,
        created_at REAL NOT NULL
    );
    CREATE TABLE timeline_versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        label TEXT NOT NULL,
        origin TEXT NOT NULL,
        parent_id TEXT,
        timeline_json TEXT NOT NULL,
        created_at REAL NOT NULL
    );
    CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        rationale TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        result_json TEXT,
        created_at REAL NOT NULL
    );
    CREATE TABLE chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        display TEXT,
        created_at REAL NOT NULL
    );
    CREATE TABLE renders (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sequence_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        job_id TEXT,
        quality TEXT NOT NULL,
        status TEXT NOT NULL,
        output_name TEXT,
        srt_name TEXT,
        wav_name TEXT,
        duration REAL,
        created_at REAL NOT NULL
    );
    """,
    # 2: wall-clock timing for jobs (measured transcription/render times)
    """
    ALTER TABLE jobs ADD COLUMN started_at REAL;
    ALTER TABLE jobs ADD COLUMN finished_at REAL;
    """,
    # 3: speakers, processed-audio re-import, render provenance, project-level data (brief requirements)
    """
    ALTER TABLE transcript_segments ADD COLUMN speaker TEXT;
    ALTER TABLE assets ADD COLUMN audio_override_id TEXT;
    ALTER TABLE assets ADD COLUMN audio_offset REAL;
    ALTER TABLE renders ADD COLUMN origin TEXT NOT NULL DEFAULT 'render';
    ALTER TABLE renders ADD COLUMN parent_render_id TEXT;
    ALTER TABLE renders ADD COLUMN audio_asset_id TEXT;
    ALTER TABLE renders ADD COLUMN info_json TEXT;
    CREATE TABLE project_data (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (project_id, kind)
    );
    """,
    # 4: export presets on renders
    """
    ALTER TABLE renders ADD COLUMN preset TEXT;
    """,
]


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def now() -> float:
    return time.time()


class Database:
    def __init__(self, path: Path):
        self.path = path
        self._local = threading.local()
        self._write_lock = threading.RLock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            self._local.conn = conn
        return conn

    def migrate(self) -> int:
        conn = self.conn()
        with self._write_lock:
            conn.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
            row = conn.execute("SELECT version FROM schema_version").fetchone()
            version = row[0] if row else 0
            if not row:
                conn.execute("INSERT INTO schema_version VALUES (0)")
            for number, sql in enumerate(MIGRATIONS[version:], start=version + 1):
                conn.executescript(f"BEGIN; {sql}; UPDATE schema_version SET version = {number}; COMMIT;")
            conn.commit()
            return len(MIGRATIONS)

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._write_lock:
            conn = self.conn()
            cur = conn.execute(sql, tuple(params))
            conn.commit()
            return cur

    def executemany(self, sql: str, rows: Iterable[Iterable[Any]]) -> None:
        with self._write_lock:
            conn = self.conn()
            conn.executemany(sql, [tuple(r) for r in rows])
            conn.commit()

    def one(self, sql: str, params: Iterable[Any] = ()) -> dict | None:
        row = self.conn().execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        return [dict(r) for r in self.conn().execute(sql, tuple(params)).fetchall()]

    def insert(self, table: str, values: dict) -> None:
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        self.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", values.values())

    def update(self, table: str, key: str, key_value: Any, values: dict) -> None:
        sets = ", ".join(f"{c} = ?" for c in values)
        self.execute(f"UPDATE {table} SET {sets} WHERE {key} = ?", [*values.values(), key_value])


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def loads(value: str | None, default: Any = None) -> Any:
    return json.loads(value) if value else default
