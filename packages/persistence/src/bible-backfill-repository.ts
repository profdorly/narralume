import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export type BibleBackfillJobStatus =
  | "running"
  | "paused"
  | "awaiting_decision"
  | "awaiting_user"
  | "completed"
  | "cancelled";
export type BibleBackfillMode = "review_each" | "auto_apply_stop_on_conflict";
export type BibleBackfillItemStatus =
  | "pending"
  | "settling"
  | "awaiting_decision"
  | "applied"
  | "rejected"
  | "empty"
  | "failed"
  | "skipped";
export type BibleBackfillSkipReason = "already_settled" | "author_skipped";
export type BibleBackfillPhase = "chapters" | "sections" | "done";
/** A Canon Spread a job can generate as a section (see CanonSpreadSchema). */
export type BibleBackfillSpread =
  | "intent"
  | "outline"
  | "entities"
  | "facts"
  | "relations"
  | "timeline"
  | "foreshadows";
export type BibleBackfillSectionStatus =
  | "pending"
  | "generating"
  | "applied"
  | "partially_applied"
  | "needs_review"
  | "failed"
  | "skipped";

export const TERMINAL_BIBLE_BACKFILL_STATUSES: readonly BibleBackfillJobStatus[] =
  ["completed", "cancelled"];

export interface BibleBackfillJob {
  id: string;
  projectId: string;
  status: BibleBackfillJobStatus;
  mode: BibleBackfillMode;
  phase: BibleBackfillPhase;
  /** Chapters whose current text was already settled are settled again. */
  rereadSettled: boolean;
  requestHash: string;
  error: Record<string, unknown> | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface BibleBackfillItem {
  jobId: string;
  ordinal: number;
  outlineNodeId: string;
  documentId: string;
  versionId: string;
  attempt: number;
  runId: string | null;
  changeSetId: string | null;
  status: BibleBackfillItemStatus;
  skipReason: BibleBackfillSkipReason | null;
  error: Record<string, unknown> | null;
  /**
   * What happened to the chapter besides its status (`code` plus fields):
   * re-targeted to a newer version, an existing settlement adopted, or a
   * Studio settlement detached on cancel. Never cleared by a status change.
   */
  note: Record<string, unknown> | null;
  updatedAt: string;
}

/** One section of a job's plan, generated after the chapter pass. */
export interface BibleBackfillSection {
  jobId: string;
  ordinal: number;
  spread: BibleBackfillSpread;
  status: BibleBackfillSectionStatus;
  attempt: number;
  runId: string | null;
  candidateSetId: string | null;
  appliedCount: number;
  pendingCount: number;
  /** Auto mode: the candidate items left for the author and why. */
  pendingItems: Record<string, unknown>[];
  error: Record<string, unknown> | null;
  updatedAt: string;
}

export type BibleBackfillSectionPatch = Partial<
  Pick<
    BibleBackfillSection,
    | "status"
    | "attempt"
    | "runId"
    | "candidateSetId"
    | "appliedCount"
    | "pendingCount"
    | "pendingItems"
    | "error"
  >
>;

export interface BibleBackfillItemSeed {
  outlineNodeId: string;
  documentId: string;
  versionId: string;
  skipReason: BibleBackfillSkipReason | null;
}

/** Summed recorded model usage of a job's settlement runs. */
export interface BibleBackfillUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type BibleBackfillItemPatch = Partial<
  Pick<
    BibleBackfillItem,
    | "status"
    | "versionId"
    | "attempt"
    | "runId"
    | "changeSetId"
    | "skipReason"
    | "error"
    | "note"
  >
>;

export class SqliteBibleBackfillRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  /**
   * Creates the job, its ordered chapter items and its ordered sections in
   * one transaction. A job with nothing to settle and no section completes
   * on creation.
   */
  createJob(input: {
    id: string;
    projectId: string;
    mode: BibleBackfillMode;
    requestHash: string;
    items: readonly BibleBackfillItemSeed[];
    /** Sections to generate after the chapter pass, in run order. */
    sections?: readonly BibleBackfillSpread[];
    rereadSettled?: boolean;
    now: string;
  }): BibleBackfillJob {
    const sections = input.sections ?? [];
    return this.database.transaction(() => {
      const status: BibleBackfillJobStatus =
        sections.length > 0 ||
        input.items.some((item) => item.skipReason === null)
          ? "running"
          : "completed";
      this.database.raw
        .prepare(
          `INSERT INTO bible_backfill_jobs(
             id, project_id, status, mode, request_hash, error_json,
             pause_requested, cancel_requested, created_at, updated_at, version,
             phase, reread_settled
           ) VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, 0, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          status,
          input.mode,
          input.requestHash,
          input.now,
          input.now,
          status === "completed" ? "done" : "chapters",
          input.rereadSettled ? 1 : 0,
        );
      const insertSection = this.database.raw.prepare(
        `INSERT INTO bible_backfill_sections(
           job_id, ordinal, spread, status, attempt, run_id, candidate_set_id,
           applied_count, pending_count, pending_items_json, error_json, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, 0, 0, '[]', NULL, ?)`,
      );
      sections.forEach((spread, ordinal) => {
        insertSection.run(input.id, ordinal, spread, input.now);
      });
      const insertItem = this.database.raw.prepare(
        `INSERT INTO bible_backfill_items(
           job_id, ordinal, outline_node_id, document_id, version_id, attempt,
           run_id, change_set_id, status, skip_reason, error_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, NULL, ?)`,
      );
      input.items.forEach((item, ordinal) => {
        insertItem.run(
          input.id,
          ordinal,
          item.outlineNodeId,
          item.documentId,
          item.versionId,
          item.skipReason ? "skipped" : "pending",
          item.skipReason,
          input.now,
        );
      });
      return this.requireJob(input.id);
    });
  }

  getJob(id: string): BibleBackfillJob | null {
    const row = this.database.raw
      .prepare("SELECT * FROM bible_backfill_jobs WHERE id = ?")
      .get(id) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  requireJob(id: string): BibleBackfillJob {
    const job = this.getJob(id);
    if (!job) throw new PersistenceNotFoundError("bible_backfill", id);
    return job;
  }

  /** The project's single non-terminal job, if any. */
  findActiveJob(projectId: string): BibleBackfillJob | null {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM bible_backfill_jobs
         WHERE project_id = ? AND status NOT IN ('completed','cancelled')
         LIMIT 1`,
      )
      .get(projectId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  /** The active job, otherwise the most recently created one. */
  findCurrentJob(projectId: string): BibleBackfillJob | null {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM bible_backfill_jobs WHERE project_id = ?
         ORDER BY CASE WHEN status IN ('completed','cancelled') THEN 1 ELSE 0 END,
                  created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(projectId) as JobRow | undefined;
    return row ? mapJob(row) : null;
  }

  /**
   * Jobs the coordinator may be able to advance: running jobs, jobs waiting
   * for a change-set decision (the decision may have landed while nothing
   * was listening), and parked jobs with a pending cancel request.
   */
  listActionableJobs(): BibleBackfillJob[] {
    const rows = this.database.raw
      .prepare(
        `SELECT job.* FROM bible_backfill_jobs job
         JOIN projects project ON project.id = job.project_id
         WHERE project.deleted_at IS NULL AND (
           job.status IN ('running','awaiting_decision')
           OR (job.cancel_requested = 1 AND job.status IN ('paused','awaiting_user'))
         )
         ORDER BY job.created_at, job.id`,
      )
      .all() as unknown as JobRow[];
    return rows.map(mapJob);
  }

  listItems(jobId: string): BibleBackfillItem[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM bible_backfill_items WHERE job_id = ? ORDER BY ordinal",
      )
      .all(jobId) as unknown as ItemRow[];
    return rows.map(mapItem);
  }

  requireItem(jobId: string, ordinal: number): BibleBackfillItem {
    const row = this.database.raw
      .prepare(
        "SELECT * FROM bible_backfill_items WHERE job_id = ? AND ordinal = ?",
      )
      .get(jobId, ordinal) as ItemRow | undefined;
    if (!row) {
      throw new PersistenceNotFoundError(
        "bible_backfill.item",
        `${jobId}#${ordinal}`,
      );
    }
    return mapItem(row);
  }

  findItemByRunId(runId: string): BibleBackfillItem | null {
    const row = this.database.raw
      .prepare("SELECT * FROM bible_backfill_items WHERE run_id = ? LIMIT 1")
      .get(runId) as ItemRow | undefined;
    return row ? mapItem(row) : null;
  }

  listSections(jobId: string): BibleBackfillSection[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM bible_backfill_sections WHERE job_id = ? ORDER BY ordinal",
      )
      .all(jobId) as unknown as SectionRow[];
    return rows.map(mapSection);
  }

  requireSection(jobId: string, ordinal: number): BibleBackfillSection {
    const row = this.database.raw
      .prepare(
        "SELECT * FROM bible_backfill_sections WHERE job_id = ? AND ordinal = ?",
      )
      .get(jobId, ordinal) as SectionRow | undefined;
    if (!row) {
      throw new PersistenceNotFoundError(
        "bible_backfill.section",
        `${jobId}#${ordinal}`,
      );
    }
    return mapSection(row);
  }

  updateSection(
    jobId: string,
    ordinal: number,
    patch: BibleBackfillSectionPatch,
    now: string,
  ): BibleBackfillSection {
    const current = this.requireSection(jobId, ordinal);
    const next = { ...current, ...patch };
    this.database.raw
      .prepare(
        `UPDATE bible_backfill_sections SET
           status = ?, attempt = ?, run_id = ?, candidate_set_id = ?,
           applied_count = ?, pending_count = ?, pending_items_json = ?,
           error_json = ?, updated_at = ?
         WHERE job_id = ? AND ordinal = ?`,
      )
      .run(
        next.status,
        next.attempt,
        next.runId,
        next.candidateSetId,
        next.appliedCount,
        next.pendingCount,
        JSON.stringify(next.pendingItems),
        next.error ? JSON.stringify(next.error) : null,
        now,
        jobId,
        ordinal,
      );
    this.touchJob(jobId, now);
    return this.requireSection(jobId, ordinal);
  }

  setJobPhase(
    id: string,
    phase: BibleBackfillPhase,
    now: string,
  ): BibleBackfillJob {
    const result = this.database.raw
      .prepare(
        `UPDATE bible_backfill_jobs SET phase = ?, updated_at = ?,
           version = version + 1
         WHERE id = ?`,
      )
      .run(phase, now, id);
    if (result.changes !== 1) {
      throw new PersistenceNotFoundError("bible_backfill", id);
    }
    return this.requireJob(id);
  }

  /**
   * Change sets the project's Story Bible completions applied from chapter
   * settlements (their own or adopted ones), across every job.
   */
  listAppliedChapterChangeSetIds(projectId: string): string[] {
    const rows = this.database.raw
      .prepare(
        `SELECT DISTINCT item.change_set_id AS id
         FROM bible_backfill_items item
         JOIN bible_backfill_jobs job ON job.id = item.job_id
         WHERE job.project_id = ? AND item.status = 'applied'
           AND item.change_set_id IS NOT NULL`,
      )
      .all(projectId) as unknown as Array<{ id: string }>;
    return rows.map(({ id }) => id);
  }

  /** Candidate sets generated by the project's completions' sections. */
  listSectionCandidateSetIds(projectId: string): string[] {
    const rows = this.database.raw
      .prepare(
        `SELECT DISTINCT section.candidate_set_id AS id
         FROM bible_backfill_sections section
         JOIN bible_backfill_jobs job ON job.id = section.job_id
         WHERE job.project_id = ? AND section.candidate_set_id IS NOT NULL`,
      )
      .all(projectId) as unknown as Array<{ id: string }>;
    return rows.map(({ id }) => id);
  }

  /**
   * Summed recorded usage of the settlement and section runs this job
   * created (every attempt carries `policy.bibleBackfillJobId`) plus runs its
   * items adopted.
   */
  usageForJob(projectId: string, jobId: string): BibleBackfillUsage {
    const row = this.database.raw
      .prepare(
        `SELECT
           COALESCE(SUM(json_extract(budget_used_json, '$.calls')), 0) AS calls,
           COALESCE(SUM(json_extract(budget_used_json, '$.inputTokens')), 0) AS input_tokens,
           COALESCE(SUM(json_extract(budget_used_json, '$.outputTokens')), 0) AS output_tokens,
           COALESCE(SUM(json_extract(budget_used_json, '$.costUsd')), 0) AS cost_usd
         FROM runs
         WHERE project_id = ? AND (
           json_extract(policy_json, '$.bibleBackfillJobId') = ?
           OR id IN (
             SELECT run_id FROM bible_backfill_items
             WHERE job_id = ? AND run_id IS NOT NULL
           )
         )`,
      )
      .get(projectId, jobId, jobId) as UsageRow;
    return {
      calls: Number(row.calls),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costUsd: Number(row.cost_usd),
    };
  }

  updateItem(
    jobId: string,
    ordinal: number,
    patch: BibleBackfillItemPatch,
    now: string,
  ): BibleBackfillItem {
    const current = this.requireItem(jobId, ordinal);
    const next = { ...current, ...patch };
    this.database.raw
      .prepare(
        `UPDATE bible_backfill_items SET
           status = ?, version_id = ?, attempt = ?, run_id = ?, change_set_id = ?,
           skip_reason = ?, error_json = ?, note_json = ?, updated_at = ?
         WHERE job_id = ? AND ordinal = ?`,
      )
      .run(
        next.status,
        next.versionId,
        next.attempt,
        next.runId,
        next.changeSetId,
        next.skipReason,
        next.error ? JSON.stringify(next.error) : null,
        next.note ? JSON.stringify(next.note) : null,
        now,
        jobId,
        ordinal,
      );
    this.touchJob(jobId, now);
    return this.requireItem(jobId, ordinal);
  }

  /**
   * Sets the job status and its error record (null clears it). Parking in
   * paused clears the pause request; terminal states clear both requests
   * and end the job's phase (done).
   */
  setJobStatus(
    id: string,
    status: BibleBackfillJobStatus,
    now: string,
    error: Readonly<Record<string, unknown>> | null = null,
  ): BibleBackfillJob {
    const terminal = TERMINAL_BIBLE_BACKFILL_STATUSES.includes(status);
    const result = this.database.raw
      .prepare(
        `UPDATE bible_backfill_jobs SET status = ?, error_json = ?,
           pause_requested = CASE WHEN ? THEN 0 ELSE pause_requested END,
           cancel_requested = CASE WHEN ? THEN 0 ELSE cancel_requested END,
           phase = CASE WHEN ? THEN 'done' ELSE phase END,
           updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(
        status,
        error ? JSON.stringify(error) : null,
        status === "paused" || status === "running" || terminal ? 1 : 0,
        terminal ? 1 : 0,
        terminal ? 1 : 0,
        now,
        id,
      );
    if (result.changes !== 1) {
      throw new PersistenceNotFoundError("bible_backfill", id);
    }
    return this.requireJob(id);
  }

  requestControl(
    id: string,
    control: "pause" | "cancel",
    now: string,
  ): BibleBackfillJob {
    const column = control === "pause" ? "pause_requested" : "cancel_requested";
    const result = this.database.raw
      .prepare(
        `UPDATE bible_backfill_jobs SET ${column} = 1, updated_at = ?,
           version = version + 1
         WHERE id = ? AND status NOT IN ('completed','cancelled')`,
      )
      .run(now, id);
    if (result.changes !== 1) {
      throw new PersistenceNotFoundError("bible_backfill", id);
    }
    return this.requireJob(id);
  }

  /** Cancels every non-terminal job of a project (used before recycling it). */
  cancelActiveJobs(projectId: string, now: string): number {
    return Number(
      this.database.raw
        .prepare(
          `UPDATE bible_backfill_jobs SET status = 'cancelled', phase = 'done',
             pause_requested = 0, cancel_requested = 0,
             updated_at = ?, version = version + 1
           WHERE project_id = ? AND status NOT IN ('completed','cancelled')`,
        )
        .run(now, projectId).changes,
    );
  }

  private touchJob(id: string, now: string): void {
    this.database.raw
      .prepare(
        `UPDATE bible_backfill_jobs SET updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(now, id);
  }
}

interface JobRow {
  id: string;
  project_id: string;
  status: BibleBackfillJobStatus;
  mode: BibleBackfillMode;
  phase: BibleBackfillPhase;
  reread_settled: number;
  request_hash: string;
  error_json: string | null;
  pause_requested: number;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
  version: number;
}

interface UsageRow {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface SectionRow {
  job_id: string;
  ordinal: number;
  spread: BibleBackfillSpread;
  status: BibleBackfillSectionStatus;
  attempt: number;
  run_id: string | null;
  candidate_set_id: string | null;
  applied_count: number;
  pending_count: number;
  pending_items_json: string;
  error_json: string | null;
  updated_at: string;
}

interface ItemRow {
  job_id: string;
  ordinal: number;
  outline_node_id: string;
  document_id: string;
  version_id: string;
  attempt: number;
  run_id: string | null;
  change_set_id: string | null;
  status: BibleBackfillItemStatus;
  skip_reason: BibleBackfillSkipReason | null;
  error_json: string | null;
  note_json: string | null;
  updated_at: string;
}

function mapJob(row: JobRow): BibleBackfillJob {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    mode: row.mode,
    phase: row.phase,
    rereadSettled: row.reread_settled === 1,
    requestHash: row.request_hash,
    error: parseRecord(row.error_json),
    pauseRequested: row.pause_requested === 1,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapItem(row: ItemRow): BibleBackfillItem {
  return {
    jobId: row.job_id,
    ordinal: row.ordinal,
    outlineNodeId: row.outline_node_id,
    documentId: row.document_id,
    versionId: row.version_id,
    attempt: row.attempt,
    runId: row.run_id,
    changeSetId: row.change_set_id,
    status: row.status,
    skipReason: row.skip_reason,
    error: parseRecord(row.error_json),
    note: parseRecord(row.note_json),
    updatedAt: row.updated_at,
  };
}

function mapSection(row: SectionRow): BibleBackfillSection {
  const pendingItems = JSON.parse(row.pending_items_json) as unknown;
  return {
    jobId: row.job_id,
    ordinal: row.ordinal,
    spread: row.spread,
    status: row.status,
    attempt: row.attempt,
    runId: row.run_id,
    candidateSetId: row.candidate_set_id,
    appliedCount: row.applied_count,
    pendingCount: row.pending_count,
    pendingItems: Array.isArray(pendingItems)
      ? pendingItems.filter(
          (entry): entry is Record<string, unknown> =>
            Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
        )
      : [],
    error: parseRecord(row.error_json),
    updatedAt: row.updated_at,
  };
}

function parseRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}
