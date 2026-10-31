/**
 * "Fill in the story bible from the manuscript" jobs: run the manual settlement
 * pipeline chapter by chapter, in chapter order.
 * Each project has at most one unfinished job at a time (partial unique index);
 * items run strictly in ordinal order, and chapter identity (outline node,
 * document, version) is snapshotted when the job is created and re-checked when
 * the item is processed.
 * note_json records what happened to an item: retargeted to a new version,
 * reused an existing settlement, detached on cancel.
 */
export const migration046 = {
  version: 46,
  name: "bible-backfill",
  sql: `
    CREATE TABLE bible_backfill_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN (
        'running','paused','awaiting_decision','awaiting_user','completed','cancelled'
      )),
      mode TEXT NOT NULL CHECK (mode IN ('review_each','auto_apply_stop_on_conflict')),
      request_hash TEXT NOT NULL CHECK (length(request_hash) > 0),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0,1)),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
    ) STRICT;

    CREATE UNIQUE INDEX bible_backfill_jobs_one_active_idx
      ON bible_backfill_jobs(project_id)
      WHERE status NOT IN ('completed','cancelled');
    CREATE INDEX bible_backfill_jobs_project_idx
      ON bible_backfill_jobs(project_id, created_at DESC);
    CREATE INDEX bible_backfill_jobs_poll_idx
      ON bible_backfill_jobs(status, cancel_requested, updated_at);

    CREATE TABLE bible_backfill_items (
      job_id TEXT NOT NULL REFERENCES bible_backfill_jobs(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      outline_node_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      change_set_id TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'pending','settling','awaiting_decision','applied','rejected','empty','failed','skipped'
      )),
      skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN ('already_settled','author_skipped')),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      note_json TEXT CHECK (note_json IS NULL OR json_valid(note_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, ordinal),
      CHECK ((status = 'skipped') = (skip_reason IS NOT NULL))
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX bible_backfill_items_run_idx ON bible_backfill_items(run_id);

    CREATE TRIGGER "bible-backfill-jobs-project-write-guard-insert"
    BEFORE INSERT ON bible_backfill_jobs BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects WHERE id = NEW.project_id AND deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "bible-backfill-jobs-project-write-guard-update"
    BEFORE UPDATE ON bible_backfill_jobs BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM projects WHERE id = NEW.project_id AND deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "bible-backfill-items-project-write-guard-insert"
    BEFORE INSERT ON bible_backfill_items BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM bible_backfill_jobs job
        JOIN projects project ON project.id = job.project_id
        WHERE job.id = NEW.job_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "bible-backfill-items-project-write-guard-update"
    BEFORE UPDATE ON bible_backfill_items BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM bible_backfill_jobs job
        JOIN projects project ON project.id = job.project_id
        WHERE job.id = NEW.job_id AND project.deleted_at IS NOT NULL
      );
    END;
  `,
} as const;
