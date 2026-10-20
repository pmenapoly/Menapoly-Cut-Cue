-- Ask Cue proposals. Ask Cue can only propose; an action runs only when the owner approves it (POST /v1/actions/:id/approve).
CREATE TABLE cue_actions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('create_project', 'create_job', 'archive_project')),
  params_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'failed')),
  result_json TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  decided_by TEXT,
  decided_at REAL
);
CREATE INDEX cue_actions_status ON cue_actions(status, created_at);
