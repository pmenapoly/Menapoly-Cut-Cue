-- Browser-first pilot: project instructions (what you want from this project) and your note when you ask for changes.
ALTER TABLE projects ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE timeline_versions ADD COLUMN decision_note TEXT;
