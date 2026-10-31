import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export interface RunTextStream {
  runId: string;
  stepId: string;
  attempt: number;
  content: string;
  status: "streaming" | "completed" | "interrupted";
  updatedAt: string;
}

/* Streamed model text arrives in many small deltas. Writing each one used to
   rewrite the whole growing row (content || delta), so a chapter cost writes
   quadratic in its length. Deltas are now buffered per step and written at
   most once per flush interval or every FLUSH_CHARS, and before any read,
   status change or discard. The buffer is shared by every repository on the
   same database, so readers in this process always see the full text. A crash
   loses at most one flush interval of text, which the interrupted-run
   recovery already tolerates. */
const FLUSH_CHARS = 16_000;
let flushMs = 1_000;

/**
 * How long deltas may wait before they are written. The browser kernel uses
 * a shorter interval: closing the tab terminates its worker at once, so
 * whatever is still buffered is lost.
 */
export function setRunStreamFlushInterval(ms: number): void {
  flushMs = Math.max(0, ms);
}

interface PendingText {
  runId: string;
  stepId: string;
  attempt: number;
  text: string;
  now: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingByDatabase = new WeakMap<
  NarrativeDatabase,
  Map<string, PendingText>
>();

export class SqliteRunStreamRepository {
  private readonly pending: Map<string, PendingText>;

  constructor(private readonly database: NarrativeDatabase) {
    let pending = pendingByDatabase.get(database);
    if (!pending) {
      pending = new Map();
      pendingByDatabase.set(database, pending);
    }
    this.pending = pending;
  }

  appendText(runId: string, stepId: string, text: string, now: string): void {
    if (!text) return;
    const key = `${runId}\0${stepId}`;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = {
        runId,
        stepId,
        attempt: this.requireStep(runId, stepId).attempt,
        text: "",
        now,
        startedAt: Date.now(),
        timer: null,
      };
      this.pending.set(key, entry);
    }
    entry.text += text;
    entry.now = now;
    if (
      entry.text.length >= FLUSH_CHARS ||
      Date.now() - entry.startedAt >= flushMs
    ) {
      this.flushEntry(key);
      return;
    }
    if (!entry.timer) {
      const timer = setTimeout(() => {
        // A timer has no caller to fail: a write error here (project purged,
        // disk full, database closed) must not end the process. The text of
        // that flush is dropped; the step itself goes on and records its
        // final output as usual.
        try {
          this.flushEntry(key);
        } catch (error) {
          console.warn(
            "[run-stream] buffered text could not be written",
            error,
          );
        }
      }, flushMs);
      (timer as { unref?: () => void }).unref?.();
      entry.timer = timer;
    }
  }

  /** Writes every buffered delta. Readers and status changes call it. */
  flush(): void {
    for (const key of [...this.pending.keys()]) this.flushEntry(key);
  }

  private flushEntry(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    this.database.raw
      .prepare(
        `INSERT INTO run_stream_attempts(
           run_id, step_id, attempt, content, status, updated_at
         ) VALUES (?, ?, ?, ?, 'streaming', ?)
         ON CONFLICT(step_id, attempt) DO UPDATE SET
           content = run_stream_attempts.content || excluded.content,
           status = 'streaming',
           updated_at = excluded.updated_at`,
      )
      .run(entry.runId, entry.stepId, entry.attempt, entry.text, entry.now);
  }

  markStatus(
    runId: string,
    stepId: string,
    status: RunTextStream["status"],
    now: string,
  ): void {
    this.flush();
    const step = this.requireStep(runId, stepId);
    this.database.raw
      .prepare(
        `UPDATE run_stream_attempts SET status = ?, updated_at = ?
         WHERE run_id = ? AND step_id = ? AND attempt = ?`,
      )
      .run(status, now, runId, stepId, step.attempt);
  }

  interruptOrphaned(now = new Date().toISOString()): number {
    this.flush();
    return Number(
      this.database.raw
        .prepare(
          `UPDATE run_stream_attempts SET status = 'interrupted', updated_at = ?
           WHERE status = 'streaming'`,
        )
        .run(now).changes,
    );
  }

  listForRun(runId: string): RunTextStream[] {
    this.flush();
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM run_stream_attempts
         WHERE run_id = ? ORDER BY step_id, attempt`,
      )
      .all(runId) as unknown as RunTextStreamRow[];
    return rows.map(mapRow);
  }

  get(runId: string, stepId: string, attempt: number): RunTextStream | null {
    this.flush();
    const row = this.database.raw
      .prepare(
        `SELECT * FROM run_stream_attempts
         WHERE run_id = ? AND step_id = ? AND attempt = ?`,
      )
      .get(runId, stepId, attempt) as RunTextStreamRow | undefined;
    return row ? mapRow(row) : null;
  }

  discard(runId: string, stepId: string, attempt: number): boolean {
    this.flush();
    return (
      this.database.raw
        .prepare(
          `DELETE FROM run_stream_attempts
           WHERE run_id = ? AND step_id = ? AND attempt = ?`,
        )
        .run(runId, stepId, attempt).changes === 1
    );
  }

  private requireStep(runId: string, stepId: string): { attempt: number } {
    const row = this.database.raw
      .prepare("SELECT attempt FROM run_steps WHERE run_id = ? AND id = ?")
      .get(runId, stepId) as { attempt: number } | undefined;
    if (!row || row.attempt < 1)
      throw new PersistenceNotFoundError("running-step", stepId);
    return row;
  }
}

interface RunTextStreamRow {
  run_id: string;
  step_id: string;
  attempt: number;
  content: string;
  status: RunTextStream["status"];
  updated_at: string;
}

function mapRow(row: RunTextStreamRow): RunTextStream {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    content: row.content,
    status: row.status,
    updatedAt: row.updated_at,
  };
}
