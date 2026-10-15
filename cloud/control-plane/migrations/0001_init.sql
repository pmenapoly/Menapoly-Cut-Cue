-- Menapoly Cue cloud control plane: durable metadata only. Media bytes live in private R2 (S3 API); never in D1.
-- Stable ids: <prefix>_<16 hex>. Times are unix seconds (REAL).

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client TEXT,
  budget_usd REAL NOT NULL DEFAULT 5,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  archived_at REAL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('source', 'output')),
  media_type TEXT NOT NULL,              -- video | audio | image | document | data
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,                           -- declared by the uploader; verified by the worker before use
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'failed')),
  source_job_id TEXT,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  verified_at REAL
);
CREATE INDEX assets_project ON assets(project_id, created_at);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  object_key TEXT NOT NULL,
  s3_upload_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  part_size INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'aborted', 'expired')),
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  completed_at REAL
);
CREATE INDEX upload_sessions_status ON upload_sessions(status, expires_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL CHECK (type IN ('transcribe', 'auto_edit', 'render')),
  target TEXT NOT NULL CHECK (target IN ('mac', 'cloud')),
  status TEXT NOT NULL CHECK (status IN ('awaiting_authorization', 'queued', 'leased', 'running', 'succeeded',
                                         'failed', 'dead', 'cancelled')),
  params_json TEXT NOT NULL,
  input_asset_ids_json TEXT NOT NULL,
  idempotency_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_worker_id TEXT,
  lease_token_hash TEXT,
  lease_expires_at REAL,
  stage TEXT,
  progress REAL,                         -- only what the worker measured (FFmpeg/Whisper position); NULL otherwise
  error TEXT,
  result_json TEXT,
  authorization_id TEXT,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  started_at REAL,
  finished_at REAL,
  UNIQUE (project_id, idempotency_key)
);
CREATE INDEX jobs_queue ON jobs(status, target, created_at);
CREATE INDEX jobs_project ON jobs(project_id, created_at);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  at REAL NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX job_events_job ON job_events(job_id, id);

CREATE TABLE timeline_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
  label TEXT NOT NULL,
  timeline_json TEXT NOT NULL,
  source_job_id TEXT,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  decided_by TEXT,
  decided_at REAL,
  UNIQUE (project_id, number)
);

CREATE TABLE review_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  allow_download INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL,
  revoked_at REAL
);

CREATE TABLE review_events (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES review_links(id),
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'approved', 'changes_requested')),
  author TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  at_seconds REAL,
  created_at REAL NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  href TEXT,
  source_key TEXT NOT NULL UNIQUE,
  created_at REAL NOT NULL,
  read_at REAL,
  emailed_at REAL
);

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  version TEXT,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_seen_at REAL,
  revoked_at REAL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at REAL NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  job_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('ai', 'cloud_render', 'storage')),
  usd REAL NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);
CREATE INDEX cost_ledger_month ON cost_ledger(created_at);

CREATE TABLE authorizations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  max_usd REAL NOT NULL,
  approved_by TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
