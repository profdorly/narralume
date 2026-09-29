/**
 * 「从正文补全故事圣经」任务的分部阶段：逐章结算之后，按计划从全书生成故事圣经
 * 各分部（作者意图、实体、大纲……）的候选并按来源安全地自动应用。
 * phase 记录任务所处阶段；reread_settled 表示已结算过的章节也重读一遍；
 * bible_backfill_sections 按 ordinal 保存每个分部的候选 Run、候选集与结果。
 * 已有任务没有分部：已结束的记为 done，未结束的仍处于 chapters，逐章结束后直接完成。
 */
export const migration048 = {
  version: 48,
  name: "bible-backfill-sections",
  sql: `
    ALTER TABLE bible_backfill_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'chapters'
      CHECK (phase IN ('chapters','sections','done'));
    ALTER TABLE bible_backfill_jobs ADD COLUMN reread_settled INTEGER NOT NULL DEFAULT 0
      CHECK (reread_settled IN (0,1));
    UPDATE bible_backfill_jobs SET phase = 'done'
      WHERE status IN ('completed','cancelled');

    CREATE TABLE bible_backfill_sections (
      job_id TEXT NOT NULL REFERENCES bible_backfill_jobs(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      spread TEXT NOT NULL CHECK (spread IN (
        'intent','outline','entities','facts','relations','timeline','foreshadows'
      )),
      status TEXT NOT NULL CHECK (status IN (
        'pending','generating','applied','partially_applied','needs_review','failed','skipped'
      )),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      candidate_set_id TEXT,
      applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
      pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
      pending_items_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(pending_items_json) AND json_type(pending_items_json) = 'array'),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(job_id, ordinal),
      UNIQUE(job_id, spread)
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX bible_backfill_sections_run_idx ON bible_backfill_sections(run_id);

    CREATE TRIGGER "bible-backfill-sections-project-write-guard-insert"
    BEFORE INSERT ON bible_backfill_sections BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM bible_backfill_jobs job
        JOIN projects project ON project.id = job.project_id
        WHERE job.id = NEW.job_id AND project.deleted_at IS NOT NULL
      );
    END;
    CREATE TRIGGER "bible-backfill-sections-project-write-guard-update"
    BEFORE UPDATE ON bible_backfill_sections BEGIN
      SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
        SELECT 1 FROM bible_backfill_jobs job
        JOIN projects project ON project.id = job.project_id
        WHERE job.id = NEW.job_id AND project.deleted_at IS NOT NULL
      );
    END;
  `,
} as const;
