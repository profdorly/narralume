import { classifyStepError } from "@narralume/harness";
import {
  SettlementApplicationError,
  SettlementApplicationService,
  SettlementConflictError,
} from "@narralume/narrative";
import {
  SqliteBibleBackfillRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  type BibleBackfillItem,
  type BibleBackfillJob,
  type NarrativeDatabase,
} from "@narralume/persistence";

import {
  BibleBackfillService,
  currentBackfillItem,
  finalizeBackfillCancellation,
  isTerminalBackfillJob,
} from "./bible-backfill-service.js";
import {
  createManualSettlementRun,
  findActiveManualSettlementRun,
} from "./manual-settlement.js";
import type { RunCoordinator } from "./run-coordinator.js";
import { deterministicUuid } from "./request-idempotency.js";
import {
  committedChangeSetId,
  requireWritingAssignment,
  RunServiceError,
} from "./run-policy.js";

/** Run-policy flag read by the settlement worker (see settleChapter). */
export const BIBLE_BACKFILL_POLICY_FLAG = "referenceExistingStoryState";

/** Deterministic child-run id: one settlement run per (job, version, attempt). */
export function bibleBackfillRunId(
  jobId: string,
  versionId: string,
  attempt: number,
): string {
  return deterministicUuid(
    `bible-backfill-run\0${jobId}\0${versionId}\0${attempt}`,
  );
}

/**
 * 「从正文补全故事圣经」协调器：与 AutopilotCoordinator 同构的 wake/drain
 * 循环。每次推进在一个事务里完成一个持久化状态转移；逐章严格串行——
 * 第 N 章的结算 Run 只在第 N-1 章的变更集被裁定（或确认为空）之后才创建，
 * 因为结算校验引用的是当前正典的稳定 ID，时间线序号也在应用时分配。
 */
export class BibleBackfillCoordinator {
  private readonly backfills: SqliteBibleBackfillRepository;
  private readonly runs: SqliteRunRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly service: BibleBackfillService;
  private readonly settlementApplication: SettlementApplicationService;
  readonly #controller = new AbortController();
  #draining: Promise<void> | null = null;
  #wakeAgain = false;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly runCoordinator: RunCoordinator,
    private readonly options: {
      environment: Readonly<Record<string, string | undefined>>;
      /** Wake the run worker after creating/controlling child runs. */
      autoRunWorker: boolean;
      onChange?: (job: BibleBackfillJob, action: string) => void;
      onError?: (error: unknown) => void;
      now?: () => Date;
    },
  ) {
    this.backfills = new SqliteBibleBackfillRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.service = new BibleBackfillService(database, options.environment);
    this.settlementApplication = new SettlementApplicationService(database);
  }

  wake(): void {
    if (this.#controller.signal.aborted) return;
    if (this.#draining) {
      this.#wakeAgain = true;
      return;
    }
    this.#draining = this.drain().finally(() => {
      this.#draining = null;
      if (this.#wakeAgain) {
        this.#wakeAgain = false;
        this.wake();
      }
    });
  }

  async stop(): Promise<void> {
    this.#controller.abort("server_stopping");
    await this.#draining;
  }

  /**
   * One durable transition for one job; false when nothing could change.
   * An unexpected error rolls the transition back and stops only this job
   * (see stopOnUnexpectedError); it never escapes to the caller.
   */
  async advanceJob(jobId: string): Promise<boolean> {
    if (this.#controller.signal.aborted) return false;
    try {
      return this.database.transaction(() => this.advanceJobState(jobId));
    } catch (error) {
      if (this.#controller.signal.aborted) return false;
      return this.stopOnUnexpectedError(jobId, error);
    }
  }

  private async drain(): Promise<void> {
    // Jobs that could not even be stopped are left for the next wake so they
    // cannot starve the others.
    const stuck = new Set<string>();
    try {
      while (!this.#controller.signal.aborted) {
        let progressed = false;
        for (const job of this.backfills.listActionableJobs()) {
          if (this.#controller.signal.aborted) return;
          if (stuck.has(job.id)) continue;
          let advanced: boolean;
          try {
            advanced = await this.advanceJob(job.id);
          } catch (error) {
            stuck.add(job.id);
            if (!this.#controller.signal.aborted) {
              this.options.onError?.(error);
            }
            continue;
          }
          if (advanced) {
            progressed = true;
            break;
          }
        }
        if (!progressed) return;
      }
    } catch (error) {
      // Listing the jobs itself failed; the next wake starts over.
      if (!this.#controller.signal.aborted) this.options.onError?.(error);
    }
  }

  /**
   * Parks the job for the author after an error nothing else handled (for
   * example an entity deleted between park and resume), so it neither spins
   * as `running` nor blocks other projects' jobs. Resume retries the same
   * transition; when a cancel was pending the cancellation is completed.
   * Throws only when the job cannot be written at all.
   */
  private stopOnUnexpectedError(jobId: string, error: unknown): boolean {
    this.options.onError?.(error);
    return this.database.transaction(() => {
      const job = this.backfills.getJob(jobId);
      if (!job || isTerminalBackfillJob(job)) return false;
      const now = this.now();
      const item = currentBackfillItem(this.backfills.listItems(job.id));
      const record = {
        code: "bible_backfill.unexpected",
        message: unexpectedErrorMessage(error),
        ...(item ? { ordinal: item.ordinal } : {}),
      };
      if (job.cancelRequested) {
        finalizeBackfillCancellation(this.backfills, job.id, now, record);
        return this.changed(job.id, "job.cancelled");
      }
      this.backfills.setJobStatus(job.id, "awaiting_user", now, record);
      return this.changed(job.id, "job.awaiting_user");
    });
  }

  private advanceJobState(jobId: string): boolean {
    const job = this.backfills.requireJob(jobId);
    if (isTerminalBackfillJob(job)) return false;
    if (!this.projects.get(job.projectId)) return false;
    const now = this.now();
    const items = this.backfills.listItems(job.id);
    const item = currentBackfillItem(items);
    const child =
      item?.status === "settling" && item.runId
        ? this.runs.getRun(item.runId)
        : null;
    const childActive =
      child !== null &&
      !["completed", "failed", "cancelled"].includes(child.status);

    if (job.cancelRequested) {
      if (childActive) {
        if (child.status === "running") {
          if (child.cancelRequested) return false;
          this.runs.requestCancel(child.id, now);
          this.database.afterCommit(() =>
            this.runCoordinator.interrupt(child.id, "bible_backfill_cancelled"),
          );
          this.wakeRunWorker();
          return this.changed(job.id, "child.cancel_requested");
        }
        this.runs.setRunStatus(
          child.id,
          "cancelled",
          now,
          "bible_backfill_cancelled",
        );
      }
      finalizeBackfillCancellation(this.backfills, job.id, now);
      return this.changed(job.id, "job.cancelled");
    }

    if (["paused", "awaiting_user"].includes(job.status)) return false;

    if (job.pauseRequested) {
      if (
        childActive &&
        ["pending", "running", "failed_recoverable"].includes(child.status)
      ) {
        if (child.pauseRequested) return false;
        this.runs.requestPause(child.id, now);
        this.wakeRunWorker();
        return this.changed(job.id, "child.pause_requested");
      }
      this.backfills.setJobStatus(job.id, "paused", now);
      return this.changed(job.id, "job.paused");
    }

    if (!item) {
      this.backfills.setJobStatus(job.id, "completed", now);
      return this.changed(job.id, "job.completed");
    }

    switch (item.status) {
      case "pending":
        return this.startItem(job, item, now);
      case "settling":
        return this.reconcileChild(job, item, now);
      case "awaiting_decision":
        return this.reconcileDecision(job, item, now);
      case "failed":
        return this.park(job, now, {
          code: "bible_backfill.item.failed",
          ordinal: item.ordinal,
          itemError: item.error,
        });
      default:
        return false;
    }
  }

  private startItem(
    job: BibleBackfillJob,
    item: BibleBackfillItem,
    now: string,
  ): boolean {
    const document = this.documents.get(job.projectId, item.documentId);
    if (
      !document ||
      document.kind !== "chapter" ||
      document.outlineNodeId !== item.outlineNodeId ||
      !document.currentVersionId
    ) {
      return this.failItem(job, item, now, {
        code: "bible_backfill.chapter.changed",
        message:
          "The chapter manuscript no longer matches the outline chapter it was queued for",
      });
    }
    let versionId = item.versionId;
    if (document.currentVersionId !== item.versionId) {
      // The author revised the chapter after the job was created: settle the
      // current text, unless that version has been settled already.
      const version = this.documents.getVersion(
        job.projectId,
        document.id,
        document.currentVersionId,
      );
      if (!version) {
        return this.failItem(job, item, now, {
          code: "document.version.not_found",
          message: "The chapter's current manuscript version does not exist",
        });
      }
      versionId = version.id;
      if (
        this.service.isVersionSettled(
          job.projectId,
          item.outlineNodeId,
          version,
        )
      ) {
        this.backfills.updateItem(
          job.id,
          item.ordinal,
          { versionId, status: "skipped", skipReason: "already_settled" },
          now,
        );
        return this.changed(job.id, "item.skipped");
      }
    }
    try {
      requireWritingAssignment(this.database, this.options.environment);
    } catch (error) {
      if (!(error instanceof RunServiceError)) throw error;
      return this.park(job, now, {
        code: error.code,
        message: error.message,
        ordinal: item.ordinal,
      });
    }
    // A writing-path settlement of the same version already in flight is
    // adopted instead of settling the same text twice.
    const existing = findActiveManualSettlementRun(
      this.database,
      job.projectId,
      versionId,
    );
    const runId =
      existing?.id ?? bibleBackfillRunId(job.id, versionId, item.attempt);
    if (!existing && !this.runs.getRun(runId)) {
      createManualSettlementRun({
        database: this.database,
        environment: this.options.environment,
        runId,
        projectId: job.projectId,
        document,
        versionId,
        origin: { surface: "bible-backfill", documentId: document.id },
        policy: {
          bibleBackfillJobId: job.id,
          bibleBackfillOrdinal: item.ordinal,
          [BIBLE_BACKFILL_POLICY_FLAG]: true,
        },
        now,
      });
    }
    this.backfills.updateItem(
      job.id,
      item.ordinal,
      { versionId, status: "settling", runId, changeSetId: null, error: null },
      now,
    );
    this.wakeRunWorker();
    return this.changed(job.id, "item.settling");
  }

  private reconcileChild(
    job: BibleBackfillJob,
    item: BibleBackfillItem,
    now: string,
  ): boolean {
    if (!item.runId) {
      return this.failItem(job, item, now, {
        code: "bible_backfill.run.missing",
        message: "The chapter's settlement run no longer exists",
      });
    }
    const snapshot = this.runs.getRun(item.runId)
      ? this.runs.getSnapshot(item.runId)
      : null;
    if (!snapshot) {
      return this.failItem(job, item, now, {
        code: "bible_backfill.run.missing",
        message: "The chapter's settlement run no longer exists",
      });
    }
    const child = snapshot.run;
    if (["pending", "running", "failed_recoverable"].includes(child.status)) {
      this.wakeRunWorker();
      return false;
    }
    if (child.status === "paused") {
      this.backfills.setJobStatus(job.id, "paused", now);
      return this.changed(job.id, "child.paused");
    }
    if (child.status === "awaiting_user") {
      return this.park(job, now, {
        code: "child.awaiting_user",
        runId: child.id,
        ordinal: item.ordinal,
      });
    }
    if (child.status === "cancelled") {
      return this.failItem(job, item, now, {
        code: "run.cancelled",
        message: "The chapter's settlement run was cancelled",
        runId: child.id,
      });
    }
    if (child.status === "failed") {
      const failedStep = [...snapshot.steps]
        .reverse()
        .find((step) => step.status === "failed");
      const classification = classifyStepError(failedStep?.error ?? null);
      return this.failItem(job, item, now, {
        code: classification.kind === "fatal" ? "child.fatal" : "child.failed",
        message: failedStep?.error?.message ?? "The settlement run failed",
        category: classification.category,
        runId: child.id,
        stepId: failedStep?.id ?? null,
      });
    }
    // completed: an empty settlement records no change set and moves on.
    const changeSetId = committedChangeSetId(snapshot);
    if (!changeSetId) {
      this.backfills.updateItem(
        job.id,
        item.ordinal,
        { status: "empty", changeSetId: null },
        now,
      );
      return this.changed(job.id, "item.empty");
    }
    this.backfills.updateItem(
      job.id,
      item.ordinal,
      { status: "awaiting_decision", changeSetId },
      now,
    );
    return this.changed(job.id, "item.change_set_ready");
  }

  private reconcileDecision(
    job: BibleBackfillJob,
    item: BibleBackfillItem,
    now: string,
  ): boolean {
    const changeSet = item.changeSetId
      ? this.reviews.getCanonChangeSet(job.projectId, item.changeSetId)
      : null;
    if (!changeSet) {
      return this.failItem(job, item, now, {
        code: "canon_change_set.not_found",
        message: "The chapter's change set no longer exists",
      });
    }
    if (
      ["applied", "partially_applied", "rejected"].includes(changeSet.status)
    ) {
      this.backfills.updateItem(
        job.id,
        item.ordinal,
        { status: changeSet.status === "rejected" ? "rejected" : "applied" },
        now,
      );
      if (job.status !== "running") {
        this.backfills.setJobStatus(job.id, "running", now);
      }
      return this.changed(job.id, `item.${changeSet.status}`);
    }
    if (job.mode === "review_each") {
      if (job.status === "awaiting_decision") return false;
      this.backfills.setJobStatus(job.id, "awaiting_decision", now);
      return this.changed(job.id, "job.awaiting_decision");
    }
    try {
      this.settlementApplication.apply({
        projectId: job.projectId,
        changeSetId: changeSet.id,
        conflictPolicy: "reject",
        now,
      });
    } catch (error) {
      if (error instanceof SettlementConflictError) {
        return this.park(job, now, {
          code: error.code,
          message: error.message,
          ordinal: item.ordinal,
          changeSetId: changeSet.id,
          conflicts: error.conflicts,
          forceAllowed: error.conflicts.every((conflict) =>
            ["target_locked", "status_changed"].includes(conflict.reason),
          ),
        });
      }
      if (error instanceof SettlementApplicationError) {
        return this.park(job, now, {
          code: error.code,
          message: error.message,
          ordinal: item.ordinal,
          changeSetId: changeSet.id,
        });
      }
      throw error;
    }
    this.backfills.updateItem(job.id, item.ordinal, { status: "applied" }, now);
    return this.changed(job.id, "item.applied");
  }

  private failItem(
    job: BibleBackfillJob,
    item: BibleBackfillItem,
    now: string,
    error: Record<string, unknown> & { code: string },
  ): boolean {
    this.backfills.updateItem(
      job.id,
      item.ordinal,
      { status: "failed", error },
      now,
    );
    this.backfills.setJobStatus(job.id, "awaiting_user", now, {
      ...error,
      ordinal: item.ordinal,
    });
    return this.changed(job.id, "item.failed");
  }

  /** Stops the job for the author; resume/skip/retry continues it. */
  private park(
    job: BibleBackfillJob,
    now: string,
    error: Record<string, unknown> & { code: string },
  ): boolean {
    if (job.status === "awaiting_user") return false;
    this.backfills.setJobStatus(job.id, "awaiting_user", now, error);
    return this.changed(job.id, "job.awaiting_user");
  }

  private wakeRunWorker(): void {
    if (this.options.autoRunWorker) {
      this.database.afterCommit(() => this.runCoordinator.wake());
    }
  }

  private changed(jobId: string, action: string): true {
    const job = this.backfills.requireJob(jobId);
    this.database.afterCommit(() => this.options.onChange?.(job, action));
    return true;
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

/** A bounded, author-facing description of an unexpected error. */
function unexpectedErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return (message.trim() || "Unexpected error").slice(0, 500);
}
