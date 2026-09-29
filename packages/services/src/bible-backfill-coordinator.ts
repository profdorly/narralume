import type { BibleBackfillSectionPendingItemDto } from "@narralume/contracts";
import type { NarrativeRun } from "@narralume/domain";
import {
  CanonCandidateError,
  CanonCandidateService,
  SettlementApplicationError,
  SettlementApplicationService,
  SettlementConflictError,
  type SettlementChangedRecord,
} from "@narralume/narrative";
import {
  SqliteBibleBackfillRepository,
  SqliteDeliveryRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  type BibleBackfillItem,
  type BibleBackfillJob,
  type BibleBackfillSection,
  type NarrativeDatabase,
} from "@narralume/persistence";

import {
  BibleBackfillSectionGate,
  bibleBackfillSectionInstruction,
  bibleBackfillSectionRequestId,
  stagedCandidateSetId,
} from "./bible-backfill-sections.js";
import {
  BibleBackfillService,
  childFailureError,
  currentBackfillItem,
  currentBackfillSection,
  finalizeBackfillCancellation,
  isOwnBackfillRun,
  isTerminalBackfillJob,
  settlementRunOutcome,
  type SettlementRunOutcome,
} from "./bible-backfill-service.js";
import {
  CanonCandidateRouteError,
  createCanonSpreadCandidateRun,
} from "./canon-candidate-run.js";
import { createManualSettlementRun } from "./manual-settlement-run.js";
import { isImportDerivedSource } from "./import-provenance.js";
import type { RunCoordinator } from "./run-coordinator.js";
import { deterministicUuid } from "./request-idempotency.js";
import {
  committedChangeSetId,
  requireWritingAssignment,
  RunServiceError,
} from "./run-policy.js";

/** Run-policy flag read by the settlement worker (see settleChapter). */
export const BIBLE_BACKFILL_POLICY_FLAG = "referenceExistingStoryState";

/**
 * Run-policy flag telling the settlement worker that this chapter's current
 * text was settled before and is being read again (see settleChapter).
 */
export const BIBLE_BACKFILL_REREAD_POLICY_FLAG = "bibleBackfillReread";

/**
 * Import candidate kind that creates each kind of changed record, for the
 * kinds whose rows keep the creating import candidate as their source id.
 * Imports create no facts.
 */
const IMPORT_CANDIDATE_KINDS: Partial<
  Record<SettlementChangedRecord["kind"], string>
> = {
  relationship: "relationship",
  timeline: "timeline",
  foreshadow: "foreshadow",
};

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
 * 逐章结束后进入分部阶段：按计划逐个分部发起 Canon Spread 候选 Run，
 * 自动模式只应用来源安全的条目，其余留给作者在故事圣经里审阅；
 * 分部失败不阻塞任务，作者可以 retry_section 重跑。
 */
export class BibleBackfillCoordinator {
  private readonly backfills: SqliteBibleBackfillRepository;
  private readonly runs: SqliteRunRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly deliveries: SqliteDeliveryRepository;
  private readonly service: BibleBackfillService;
  private readonly settlementApplication: SettlementApplicationService;
  private readonly candidates: CanonCandidateService;
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
    this.deliveries = new SqliteDeliveryRepository(database);
    this.service = new BibleBackfillService(database, options.environment);
    this.settlementApplication = new SettlementApplicationService(database);
    this.candidates = new CanonCandidateService(database, () =>
      this.options.now ? this.options.now() : new Date(),
    );
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
      const section =
        job.phase === "sections"
          ? currentBackfillSection(this.backfills.listSections(job.id))
          : null;
      const record = {
        code: "bible_backfill.unexpected",
        message: unexpectedErrorMessage(error),
        ...(item ? { ordinal: item.ordinal } : {}),
        ...(section ? { sectionOrdinal: section.ordinal } : {}),
      };
      if (job.cancelRequested) {
        this.finalizeCancellation(job.id, now, record);
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
    const sections = this.backfills.listSections(job.id);
    const generating = sections.find(
      (section) => section.status === "generating" && section.runId,
    );
    // The job's one child run: the chapter being settled or the section
    // being generated.
    const childRunId =
      item?.status === "settling" && item.runId
        ? item.runId
        : (generating?.runId ?? null);
    const child = childRunId ? this.runs.getRun(childRunId) : null;
    const childActive =
      child !== null &&
      !["completed", "failed", "cancelled"].includes(child.status);

    if (job.cancelRequested) {
      // Only a run this job created is cancelled; an adopted Studio
      // settlement is detached by finalizeBackfillCancellation.
      if (childActive && isOwnBackfillRun(child, job.id)) {
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
      this.finalizeCancellation(job.id, now);
      return this.changed(job.id, "job.cancelled");
    }

    if (["paused", "awaiting_user"].includes(job.status)) return false;

    if (job.pauseRequested) {
      // Only a run this job created is paused; an adopted Studio settlement
      // keeps running (see BibleBackfillService.pause).
      if (
        childActive &&
        isOwnBackfillRun(child, job.id) &&
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

    if (!item) return this.advanceSections(job, sections, now);

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
    const versionId = version.id;
    // The author revised the chapter after it was queued: the job settles the
    // current text instead, and says so on the item.
    let note = item.note;
    if (versionId !== item.versionId) {
      note = {
        ...note,
        code: "bible_backfill.item.retargeted",
        retargetedFromVersionId: item.versionId,
      };
    }
    // A settlement of exactly this text that already exists — in flight,
    // still undecided, applied, or empty — is adopted instead of settling
    // the same text twice. A re-read only adopts one still in flight or
    // undecided: an applied or empty one is what it reads again.
    const adopted = this.existingSettlement(job, versionId);
    if (adopted) {
      const { run, adoption } = adopted;
      const { status, changeSetId } = adoption;
      const adoptedNote = {
        ...note,
        code: "bible_backfill.item.adopted",
        adoptedRunId: run.id,
        adoptedChangeSetId: changeSetId,
        adoptedOutcome: adoption.outcome,
      };
      this.backfills.updateItem(
        job.id,
        item.ordinal,
        {
          versionId,
          status,
          runId: run.id,
          changeSetId,
          error: null,
          note: adoptedNote,
        },
        now,
      );
      if (status === "settling") this.wakeRunWorker();
      return this.changed(job.id, `item.adopted.${adoption.outcome}`);
    }
    const settled = this.service.isVersionSettled(
      job.projectId,
      item.outlineNodeId,
      version,
    );
    if (settled && !job.rereadSettled) {
      this.backfills.updateItem(
        job.id,
        item.ordinal,
        { versionId, status: "skipped", skipReason: "already_settled", note },
        now,
      );
      return this.changed(job.id, "item.skipped");
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
    const runId = bibleBackfillRunId(job.id, versionId, item.attempt);
    if (!this.runs.getRun(runId)) {
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
          ...(settled ? { [BIBLE_BACKFILL_REREAD_POLICY_FLAG]: true } : {}),
        },
        now,
      });
    }
    this.backfills.updateItem(
      job.id,
      item.ordinal,
      {
        versionId,
        status: "settling",
        runId,
        changeSetId: null,
        error: null,
        note,
      },
      now,
    );
    this.wakeRunWorker();
    return this.changed(job.id, "item.settling");
  }

  /**
   * The settlement of one version worth adopting, from any origin: an applied
   * change set wins (the text's changes were kept once already); otherwise
   * the newest run still in flight, with an undecided change set, or that
   * found nothing. Rejected, failed and cancelled settlements are passed
   * over, so such a text is settled again.
   */
  private existingSettlement(
    job: BibleBackfillJob,
    versionId: string,
  ): { run: NarrativeRun; adoption: Adoption } | null {
    const candidates = this.runs
      .listRunsForDocumentVersion(job.projectId, "manual-settlement", versionId)
      // This job's own runs are its attempts, not settlements to adopt.
      .filter((run) => !isOwnBackfillRun(run, job.id))
      .map((run) => ({
        run,
        adoption: adoptionOf(
          settlementRunOutcome(this.database, job.projectId, run),
        ),
      }))
      .filter(
        ({ adoption }) =>
          !job.rereadSettled ||
          adoption?.outcome === "in_progress" ||
          adoption?.outcome === "candidate",
      );
    const found =
      candidates.find(({ adoption }) => adoption?.outcome === "applied") ??
      candidates.find(
        ({ adoption }) => adoption !== null && adoption.outcome !== "applied",
      );
    return found?.adoption
      ? { run: found.run, adoption: found.adoption }
      : null;
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
      return this.failItem(job, item, now, childFailureError(snapshot));
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
    // Auto mode only adds to what this job and the import produced: a change
    // that would withdraw, supersede, end, change, anchor, develop or resolve
    // anything else (for example a fact or an event the author entered), or
    // reopen a finished foreshadow, waits for the author.
    const reviewTargets = this.recordsNeedingReview(job, changeSet.id);
    if (reviewTargets.length > 0) {
      return this.park(job, now, {
        code: "bible_backfill.review_required",
        message:
          "This chapter would change existing Story Bible records that this completion did not create, or reopen a finished foreshadow; review it before continuing",
        ordinal: item.ordinal,
        changeSetId: changeSet.id,
        targets: reviewTargets.map((target) => ({
          path: target.path,
          kind: target.kind,
          action: target.action,
          id: target.id,
          label: target.label,
          ...(target.reopens ? { reopens: true } : {}),
        })),
      });
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

  /**
   * The section phase, once every chapter is resolved: generate the plan's
   * sections one at a time in order, then complete. A failed section does
   * not stop the job.
   */
  private advanceSections(
    job: BibleBackfillJob,
    sections: readonly BibleBackfillSection[],
    now: string,
  ): boolean {
    const section = currentBackfillSection(sections);
    if (!section) {
      this.backfills.setJobStatus(job.id, "completed", now);
      return this.changed(job.id, "job.completed");
    }
    if (job.phase !== "sections") {
      this.backfills.setJobPhase(job.id, "sections", now);
      return this.changed(job.id, "job.sections");
    }
    return section.status === "generating"
      ? this.reconcileSection(job, section, now)
      : this.startSection(job, section, now);
  }

  private startSection(
    job: BibleBackfillJob,
    section: BibleBackfillSection,
    now: string,
  ): boolean {
    const project = this.projects.get(job.projectId)!;
    let runId: string;
    try {
      runId = createCanonSpreadCandidateRun(
        this.database,
        this.options.environment,
        {
          projectId: job.projectId,
          spread: section.spread,
          requestId: bibleBackfillSectionRequestId(
            job.id,
            section.spread,
            section.attempt,
          ),
          instruction: bibleBackfillSectionInstruction(
            section.spread,
            project.language,
          ),
          origin: { surface: "bible-backfill", documentId: null },
          policy: {
            bibleBackfillJobId: job.id,
            bibleBackfillSectionOrdinal: section.ordinal,
          },
          now,
        },
      ).runId;
    } catch (error) {
      if (error instanceof RunServiceError) {
        // No writing model: stop for the author like a chapter would.
        return this.park(job, now, {
          code: error.code,
          message: error.message,
          sectionOrdinal: section.ordinal,
        });
      }
      if (error instanceof CanonCandidateRouteError) {
        // For example the author is generating the same section in the
        // Bible right now: this section fails and can be retried.
        return this.failSection(job, section, now, {
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    this.backfills.updateSection(
      job.id,
      section.ordinal,
      { status: "generating", runId, candidateSetId: null, error: null },
      now,
    );
    this.wakeRunWorker();
    return this.changed(job.id, "section.generating");
  }

  private reconcileSection(
    job: BibleBackfillJob,
    section: BibleBackfillSection,
    now: string,
  ): boolean {
    const snapshot =
      section.runId && this.runs.getRun(section.runId)
        ? this.runs.getSnapshot(section.runId)
        : null;
    if (!snapshot) {
      return this.failSection(job, section, now, {
        code: "bible_backfill.run.missing",
        message: "The section's candidate run no longer exists",
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
        sectionOrdinal: section.ordinal,
      });
    }
    if (child.status === "cancelled") {
      return this.failSection(job, section, now, {
        code: "run.cancelled",
        message: "The section's candidate run was cancelled",
        runId: child.id,
      });
    }
    if (child.status === "failed") {
      return this.failSection(job, section, now, childFailureError(snapshot));
    }
    const candidateSetId = stagedCandidateSetId(snapshot);
    const staged =
      candidateSetId &&
      this.reviews.getCanonChangeSet(job.projectId, candidateSetId)
        ? this.candidateSetOf(job, candidateSetId)
        : null;
    if (!candidateSetId || !staged) {
      return this.failSection(job, section, now, {
        code: "bible_backfill.section.candidate_missing",
        message:
          "The section's candidate run finished without a readable candidate set",
        runId: child.id,
      });
    }
    const pendingItems =
      job.mode === "review_each"
        ? []
        : this.applySafeSectionItems(job, section, candidateSetId);
    const candidateSet = this.candidates.get(job.projectId, candidateSetId);
    const appliedCount = candidateSet.items.filter(
      (item) => item.decision?.action === "apply",
    ).length;
    const pendingCount = candidateSet.items.filter(
      (item) => !item.decision,
    ).length;
    const status =
      pendingCount === 0
        ? "applied"
        : appliedCount > 0
          ? "partially_applied"
          : "needs_review";
    this.backfills.updateSection(
      job.id,
      section.ordinal,
      {
        status,
        candidateSetId,
        appliedCount,
        pendingCount,
        pendingItems: pendingItems.filter(
          (entry) =>
            !candidateSet.items.find((item) => item.id === entry.itemId)
              ?.decision,
        ),
      },
      now,
    );
    return this.changed(job.id, `section.${status}`);
  }

  /**
   * Auto mode: applies, through the Bible's own item decision, every
   * undecided item BibleBackfillSectionGate allows; returns the items left
   * for the author and why. An item whose application fails stays pending
   * with its error; it never stops the job.
   */
  private applySafeSectionItems(
    job: BibleBackfillJob,
    section: BibleBackfillSection,
    candidateSetId: string,
  ): BibleBackfillSectionPendingItemDto[] {
    const gate = new BibleBackfillSectionGate(this.database, job.projectId);
    const pending: BibleBackfillSectionPendingItemDto[] = [];
    const candidateSet = this.candidates.get(job.projectId, candidateSetId);
    for (const item of candidateSet.items) {
      if (item.decision) continue;
      const identity = {
        itemId: item.id,
        title: item.title,
        operation: item.operation,
        targetId: item.targetId,
      };
      const reason = gate.reviewReason(section.spread, item);
      if (reason) {
        pending.push({ ...identity, ...reason });
        continue;
      }
      try {
        this.candidates.decideItem({
          projectId: job.projectId,
          changeSetId: candidateSetId,
          itemId: item.id,
          action: "apply",
          confirmLocked: false,
        });
      } catch (error) {
        if (this.#controller.signal.aborted) throw error;
        pending.push({
          ...identity,
          reason: "apply_failed",
          code: errorCode(error),
          message: unexpectedErrorMessage(error),
        });
      }
    }
    return pending;
  }

  /** The candidate set, or null when it is not a Canon Spread candidate set. */
  private candidateSetOf(job: BibleBackfillJob, candidateSetId: string) {
    try {
      return this.candidates.get(job.projectId, candidateSetId);
    } catch (error) {
      if (error instanceof CanonCandidateError) return null;
      throw error;
    }
  }

  /** Records a section's failure and moves on; retry_section runs it again. */
  private failSection(
    job: BibleBackfillJob,
    section: BibleBackfillSection,
    now: string,
    error: Record<string, unknown> & { code: string },
  ): boolean {
    this.backfills.updateSection(
      job.id,
      section.ordinal,
      { status: "failed", error },
      now,
    );
    return this.changed(job.id, "section.failed");
  }

  /**
   * Existing records the change set would withdraw, supersede, end, change,
   * anchor, develop or resolve that were created neither by change sets this
   * project's Story Bible completions applied (this job's earlier chapters,
   * or an earlier completion's, so a re-read may correct them) nor by the
   * manuscript import. Import
   * provenance is the record's source id naming an applied import candidate
   * of the same kind in this project: relationships and timeline events
   * always keep it, foreshadows since migration 047 (older imported ones have
   * none and count as the author's).
   * Imports create no facts. Reopening a resolved or abandoned foreshadow
   * always needs review, even one the import or this job created: its status
   * there is the author's call.
   */
  private recordsNeedingReview(
    job: BibleBackfillJob,
    changeSetId: string,
  ): SettlementChangedRecord[] {
    const jobChangeSets = new Set(
      this.backfills.listAppliedChapterChangeSetIds(job.projectId),
    );
    return this.settlementApplication
      .changedExistingRecords(job.projectId, changeSetId)
      .filter(
        (target) =>
          target.reopens === true ||
          (!(
            target.createdByChangeSetId &&
            jobChangeSets.has(target.createdByChangeSetId)
          ) &&
            !this.isImportDerived(job.projectId, target)),
      );
  }

  /** Whether the record was created by applying this project's manuscript import. */
  private isImportDerived(
    projectId: string,
    target: SettlementChangedRecord,
  ): boolean {
    const candidateKind = IMPORT_CANDIDATE_KINDS[target.kind];
    return (
      candidateKind !== undefined &&
      isImportDerivedSource(
        this.deliveries,
        projectId,
        candidateKind,
        target.sourceId,
      )
    );
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

  private finalizeCancellation(
    jobId: string,
    now: string,
    error: Readonly<Record<string, unknown>> | null = null,
  ): void {
    const handedBack = finalizeBackfillCancellation(
      this.database,
      this.options.environment,
      jobId,
      now,
      error,
    );
    if (handedBack.length > 0) this.wakeRunWorker();
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

/** How an adopted settlement maps onto the item; null when not adoptable. */
interface Adoption {
  outcome: "in_progress" | "candidate" | "applied" | "empty";
  status: "settling" | "awaiting_decision" | "applied" | "empty";
  changeSetId: string | null;
}

function adoptionOf(outcome: SettlementRunOutcome): Adoption | null {
  switch (outcome.kind) {
    case "in_progress":
      return { outcome: "in_progress", status: "settling", changeSetId: null };
    case "empty":
      return { outcome: "empty", status: "empty", changeSetId: null };
    case "change_set":
      if (outcome.status === "candidate") {
        return {
          outcome: "candidate",
          status: "awaiting_decision",
          changeSetId: outcome.changeSetId,
        };
      }
      if (
        outcome.status === "applied" ||
        outcome.status === "partially_applied"
      ) {
        return {
          outcome: "applied",
          status: "applied",
          changeSetId: outcome.changeSetId,
        };
      }
      return null;
    default:
      // Rejected, failed, cancelled or missing: settle the text again.
      return null;
  }
}

/** The machine-readable code of an error, when it carries one. */
function errorCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : null;
  return typeof code === "string" && code
    ? code
    : "canon_candidate.item.apply_failed";
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
