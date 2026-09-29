import {
  BibleBackfillCreatedSchema,
  BibleBackfillDetailSchema,
  type BibleBackfillAction,
  type BibleBackfillActionRequest,
  type BibleBackfillCreatedDto,
  type BibleBackfillDetailDto,
  type BibleBackfillUsageDto,
  type CreateBibleBackfillRequest,
} from "@narralume/contracts";
import type {
  DocumentVersion,
  NarrativeRun,
  RunSnapshot,
} from "@narralume/domain";
import { classifyStepError } from "@narralume/harness";
import {
  SqliteBibleBackfillRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteCanonRepository,
  SqliteProjectRepository,
  SqliteRequestReplayRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  TERMINAL_BIBLE_BACKFILL_STATUSES,
  type BibleBackfillItem,
  type BibleBackfillItemPatch,
  type BibleBackfillItemSeed,
  type BibleBackfillJob,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { createManualSettlementRun } from "./manual-settlement-run.js";
import {
  deterministicRequestId,
  deterministicUuid,
  hashRequest,
} from "./request-idempotency.js";
import {
  committedChangeSetId,
  hasWritingAssignment,
  requireWritingAssignment,
} from "./run-policy.js";
import { ServiceError } from "./service-error.js";

export class BibleBackfillError extends ServiceError {
  constructor(
    code: string,
    message: string,
    statusCode: number,
    readonly details?: unknown,
  ) {
    super(code, message, statusCode);
    this.name = "BibleBackfillError";
  }
}

const SUMMARY_ID_SUFFIX = ":summary";
const APPLIED_CHANGE_SET_STATUSES: ReadonlySet<string> = new Set([
  "applied",
  "partially_applied",
]);

/** Project-wide settlement outcomes used to decide whether a chapter is settled. */
export interface SettlementIndex {
  /** Versions whose settlement change set was applied. */
  appliedVersionIds: ReadonlySet<string>;
  /** Latest change-set status per settlement run. */
  changeSetStatusByRunId: ReadonlyMap<string, string>;
}

/** Item states that no longer block the next chapter. */
export const RESOLVED_BIBLE_BACKFILL_ITEM_STATUSES = new Set([
  "applied",
  "rejected",
  "empty",
  "skipped",
]);

/** The item the job is working on: the first one not yet resolved. */
export function currentBackfillItem(
  items: readonly BibleBackfillItem[],
): BibleBackfillItem | null {
  return (
    items.find(
      (item) => !RESOLVED_BIBLE_BACKFILL_ITEM_STATUSES.has(item.status),
    ) ?? null
  );
}

export function isTerminalBackfillJob(job: BibleBackfillJob): boolean {
  return TERMINAL_BIBLE_BACKFILL_STATUSES.includes(job.status);
}

/** Result of an author control action on a backfill job. */
export interface BibleBackfillActionResult {
  detail: BibleBackfillDetailDto;
  /** A running child settlement that must be interrupted after commit. */
  interruptRunId: string | null;
  idempotentReplay: boolean;
}

/**
 * 「从正文补全故事圣经」任务的作者侧入口：建任务、读进度、暂停/继续/
 * 取消/跳过/重试。逐章推进由 BibleBackfillCoordinator 负责。
 */
export class BibleBackfillService {
  private readonly backfills: SqliteBibleBackfillRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly runs: SqliteRunRepository;
  private readonly requestReplays: SqliteRequestReplayRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly environment: Readonly<Record<string, string | undefined>>,
  ) {
    this.backfills = new SqliteBibleBackfillRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    const canon = new SqliteCanonRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      canon,
      this.story,
    );
    this.reviews = new SqliteReviewRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.requestReplays = new SqliteRequestReplayRepository(database);
  }

  create(
    projectId: string,
    input: CreateBibleBackfillRequest,
    now: string,
  ): BibleBackfillCreatedDto {
    this.requireProject(projectId);
    const requestHash = hashRequest(input);
    const jobId = deterministicRequestId(
      "bible-backfill",
      projectId,
      input.requestId,
    );
    return this.database.transaction(() => {
      const replay = this.backfills.getJob(jobId);
      if (replay) {
        if (
          replay.projectId !== projectId ||
          replay.requestHash !== requestHash
        ) {
          throw new BibleBackfillError(
            "bible_backfill.idempotency_conflict",
            "The same requestId was already used for a different Story Bible completion request",
            409,
          );
        }
        return BibleBackfillCreatedSchema.parse({
          ...this.detailOf(replay),
          idempotentReplay: true,
        });
      }
      const active = this.backfills.findActiveJob(projectId);
      if (active) {
        throw new BibleBackfillError(
          "bible_backfill.active",
          "This project is already completing its Story Bible from the manuscript",
          409,
          { jobId: active.id },
        );
      }
      requireWritingAssignment(this.database, this.environment);
      const items = this.materializeItems(projectId, input.chapterIds);
      const job = this.backfills.createJob({
        id: jobId,
        projectId,
        mode: input.mode,
        requestHash,
        items,
        now,
      });
      return BibleBackfillCreatedSchema.parse({
        ...this.detailOf(job),
        idempotentReplay: false,
      });
    });
  }

  /** The project's active job, otherwise its latest one; job is null when none exists. */
  current(projectId: string): BibleBackfillDetailDto {
    this.requireProject(projectId);
    const job = this.backfills.findCurrentJob(projectId);
    return job ? this.detailOf(job) : emptyDetail();
  }

  detail(projectId: string, jobId: string): BibleBackfillDetailDto {
    return this.detailOf(this.requireJob(projectId, jobId));
  }

  act(
    projectId: string,
    jobId: string,
    input: BibleBackfillActionRequest,
    now: string,
  ): BibleBackfillActionResult {
    this.requireProject(projectId);
    const scope = `bible-backfill:${jobId}:action`;
    const requestHash = hashRequest(input);
    return this.database.transaction(() => {
      const job = this.requireJob(projectId, jobId);
      const replay = this.requestReplays.get(scope, input.requestId);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new BibleBackfillError(
            "bible_backfill.idempotency_conflict",
            "The same requestId was already used for a different Story Bible completion action",
            409,
          );
        }
        return {
          detail: this.detailOf(job),
          interruptRunId: null,
          idempotentReplay: true,
        };
      }
      if (isTerminalBackfillJob(job)) {
        throw new BibleBackfillError(
          "bible_backfill.terminal",
          `The Story Bible completion has already ended (${job.status})`,
          409,
        );
      }
      let interruptRunId: string | null = null;
      switch (input.action) {
        case "pause":
          this.pause(job, now);
          break;
        case "resume":
          this.resume(job, now);
          break;
        case "cancel":
          interruptRunId = this.cancel(job, now);
          break;
        case "skip_item":
          this.skipItem(job, input.ordinal!, now);
          break;
        case "retry_item":
          this.retryItem(job, input.ordinal!, now);
          break;
      }
      this.requestReplays.insert({
        scope,
        requestId: input.requestId,
        requestHash,
        result: { action: input.action, ordinal: input.ordinal ?? null },
        createdAt: now,
      });
      return {
        detail: this.detailOf(this.backfills.requireJob(jobId)),
        interruptRunId,
        idempotentReplay: false,
      };
    });
  }

  /**
   * Whether a chapter version already went through settlement *and its
   * outcome was kept*: an applied change set produced from this version, or
   * a settlement summary for exactly this text (chapter commit and manual
   * settlement record `stateDelta.changes`; import summaries do not) whose
   * run's change set was applied — or that produced no change set at all
   * (an empty settlement). A rejected or still undecided change set leaves
   * the chapter unsettled, so a later completion reads it again.
   */
  isVersionSettled(
    projectId: string,
    outlineNodeId: string,
    version: DocumentVersion,
    index: SettlementIndex = this.settlementIndex(projectId),
  ): boolean {
    if (index.appliedVersionIds.has(version.id)) return true;
    const summary = this.state.latestSummary(
      projectId,
      "chapter",
      outlineNodeId,
    );
    if (
      summary?.sourceHash !== version.contentHash ||
      !Array.isArray(summary.stateDelta.changes)
    ) {
      return false;
    }
    // Settlement workers key the summary as `${runId}:summary`.
    const runId = summary.id.endsWith(SUMMARY_ID_SUFFIX)
      ? summary.id.slice(0, -SUMMARY_ID_SUFFIX.length)
      : null;
    const status = runId ? index.changeSetStatusByRunId.get(runId) : undefined;
    return status === undefined || APPLIED_CHANGE_SET_STATUSES.has(status);
  }

  detailOf(job: BibleBackfillJob): BibleBackfillDetailDto {
    const items = this.backfills.listItems(job.id);
    const current = isTerminalBackfillJob(job)
      ? null
      : currentBackfillItem(items);
    const counts = {
      total: items.length,
      pending: 0,
      settling: 0,
      awaitingDecision: 0,
      applied: 0,
      rejected: 0,
      empty: 0,
      failed: 0,
      skipped: 0,
    };
    for (const item of items) {
      const key =
        item.status === "awaiting_decision" ? "awaitingDecision" : item.status;
      counts[key] += 1;
    }
    return BibleBackfillDetailSchema.parse({
      job: {
        id: job.id,
        projectId: job.projectId,
        status: job.status,
        mode: job.mode,
        error: job.error,
        pauseRequested: job.pauseRequested,
        cancelRequested: job.cancelRequested,
        currentOrdinal: current?.ordinal ?? null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        version: job.version,
      },
      items: items.map((item) => ({
        ordinal: item.ordinal,
        outlineNodeId: item.outlineNodeId,
        documentId: item.documentId,
        versionId: item.versionId,
        title:
          this.story.getOutlineNode(job.projectId, item.outlineNodeId)?.title ??
          null,
        attempt: item.attempt,
        runId: item.runId,
        changeSetId: item.changeSetId,
        status: item.status,
        skipReason: item.skipReason,
        error: item.error,
        note: item.note,
        updatedAt: item.updatedAt,
      })),
      counts,
      usage: this.usageOf(job),
      availableActions: availableActions(job, items),
    });
  }

  /** Recorded usage of the job's settlement runs; cost only when priced. */
  private usageOf(job: BibleBackfillJob): BibleBackfillUsageDto {
    const usage = this.backfills.usageForJob(job.projectId, job.id);
    return {
      calls: usage.calls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd > 0 ? usage.costUsd : null,
    };
  }

  private materializeItems(
    projectId: string,
    chapterIds: readonly string[] | undefined,
  ): BibleBackfillItemSeed[] {
    const chapters = this.story
      .listOutline(projectId)
      .filter((node) => node.kind === "chapter");
    const requested = chapterIds ? new Set(chapterIds) : null;
    if (requested) {
      const known = new Set(chapters.map((node) => node.id));
      const invalid = [...requested].filter((id) => !known.has(id));
      if (invalid.length > 0) {
        throw new BibleBackfillError(
          "bible_backfill.chapter.invalid",
          "Some selected chapters do not exist in this project's outline",
          422,
          { chapterIds: invalid },
        );
      }
    }
    const settlementIndex = this.settlementIndex(projectId);
    const withoutManuscript: string[] = [];
    const items: BibleBackfillItemSeed[] = [];
    for (const node of chapters) {
      if (requested ? !requested.has(node.id) : node.status === "abandoned") {
        continue;
      }
      const document = this.documents.getByOutlineNodeId(projectId, node.id);
      const version =
        document?.kind === "chapter" &&
        !document.archivedAt &&
        document.currentVersionId
          ? this.documents.getVersion(
              projectId,
              document.id,
              document.currentVersionId,
            )
          : null;
      if (!document || !version) {
        withoutManuscript.push(node.id);
        continue;
      }
      items.push({
        outlineNodeId: node.id,
        documentId: document.id,
        versionId: version.id,
        skipReason: this.isVersionSettled(
          projectId,
          node.id,
          version,
          settlementIndex,
        )
          ? "already_settled"
          : null,
      });
    }
    if (requested && withoutManuscript.length > 0) {
      throw new BibleBackfillError(
        "bible_backfill.chapter.no_manuscript",
        "Some selected chapters have no committed manuscript to settle",
        422,
        { chapterIds: withoutManuscript },
      );
    }
    if (items.length === 0) {
      throw new BibleBackfillError(
        "bible_backfill.no_chapters",
        "There is no chapter manuscript to complete the Story Bible from",
        422,
      );
    }
    return items;
  }

  /**
   * One pass over the project's change sets: which versions had their
   * settlement applied, and each settlement run's change-set status.
   */
  private settlementIndex(projectId: string): SettlementIndex {
    const appliedVersionIds = new Set<string>();
    const changeSetStatusByRunId = new Map<string, string>();
    for (const changeSet of this.reviews.listCanonChangeSets(projectId)) {
      // Listed newest first: keep each run's latest change set.
      if (!changeSetStatusByRunId.has(changeSet.runId)) {
        changeSetStatusByRunId.set(changeSet.runId, changeSet.status);
      }
      if (!APPLIED_CHANGE_SET_STATUSES.has(changeSet.status)) continue;
      const run = this.runs.getRun(changeSet.runId);
      if (!run) continue;
      if (
        run.recipe === "manual-settlement" &&
        typeof run.policy.documentVersionId === "string"
      ) {
        appliedVersionIds.add(run.policy.documentVersionId);
      } else if (run.recipe === "chapter-production") {
        const commit = this.runs
          .getSnapshot(run.id)
          .steps.find(
            (step) =>
              step.kind === "chapter.commit" && step.status === "succeeded",
          );
        const versionId = commit?.outputArtifact?.versionId;
        if (typeof versionId === "string") appliedVersionIds.add(versionId);
      }
    }
    return { appliedVersionIds, changeSetStatusByRunId };
  }

  private pause(job: BibleBackfillJob, now: string): void {
    if (job.status === "paused") return;
    if (!["running", "awaiting_decision"].includes(job.status)) {
      throw notAvailable("pause", job);
    }
    this.backfills.requestControl(job.id, "pause", now);
    const child = this.activeChild(job);
    if (
      child &&
      ["pending", "running", "failed_recoverable"].includes(child.status)
    ) {
      // The coordinator parks the job once the child run has paused.
      if (!child.pauseRequested) this.runs.requestPause(child.id, now);
      return;
    }
    this.backfills.setJobStatus(job.id, "paused", now);
  }

  private resume(job: BibleBackfillJob, now: string): void {
    if (!["paused", "awaiting_user"].includes(job.status)) {
      throw notAvailable("resume", job);
    }
    const current = currentBackfillItem(this.backfills.listItems(job.id));
    if (current?.status === "failed") {
      throw new BibleBackfillError(
        "bible_backfill.item.failed",
        "Retry or skip the chapter that failed before resuming",
        409,
        { ordinal: current.ordinal },
      );
    }
    requireWritingAssignment(this.database, this.environment);
    const child = this.activeChild(job);
    if (child && ["paused", "awaiting_user"].includes(child.status)) {
      this.runs.resume(child.id, now);
    }
    this.backfills.setJobStatus(job.id, "running", now);
  }

  /**
   * Returns a running child run to interrupt once the transaction commits.
   * Only a settlement run this job created is cancelled; a Studio settlement
   * it adopted keeps running and is detached (finalizeBackfillCancellation).
   */
  private cancel(job: BibleBackfillJob, now: string): string | null {
    this.backfills.requestControl(job.id, "cancel", now);
    const child = this.activeChild(job);
    if (child && isOwnBackfillRun(child, job.id)) {
      if (child.status === "running") {
        if (!child.cancelRequested) this.runs.requestCancel(child.id, now);
        return child.id;
      }
      this.runs.setRunStatus(
        child.id,
        "cancelled",
        now,
        "bible_backfill_cancelled",
      );
    }
    finalizeBackfillCancellation(this.database, this.environment, job.id, now);
    return null;
  }

  private skipItem(job: BibleBackfillJob, ordinal: number, now: string): void {
    const item = this.requireItem(job, ordinal);
    if (item.status === "settling") {
      throw new BibleBackfillError(
        "bible_backfill.item.busy",
        "This chapter is being settled right now; pause the completion first",
        409,
        { ordinal },
      );
    }
    if (!["pending", "failed", "awaiting_decision"].includes(item.status)) {
      throw new BibleBackfillError(
        "bible_backfill.item.not_skippable",
        `This chapter is already ${item.status} and cannot be skipped`,
        409,
        { ordinal },
      );
    }
    this.backfills.updateItem(
      job.id,
      ordinal,
      { status: "skipped", skipReason: "author_skipped" },
      now,
    );
    if (["awaiting_user", "awaiting_decision"].includes(job.status)) {
      this.backfills.setJobStatus(job.id, "running", now);
    }
  }

  private retryItem(job: BibleBackfillJob, ordinal: number, now: string): void {
    const item = this.requireItem(job, ordinal);
    if (item.status !== "failed") {
      throw new BibleBackfillError(
        "bible_backfill.item.not_failed",
        "Only a chapter whose settlement failed can be retried",
        409,
        { ordinal },
      );
    }
    requireWritingAssignment(this.database, this.environment);
    this.backfills.updateItem(
      job.id,
      ordinal,
      {
        status: "pending",
        attempt: item.attempt + 1,
        runId: null,
        changeSetId: null,
        error: null,
      },
      now,
    );
    if (job.status === "awaiting_user") {
      this.backfills.setJobStatus(job.id, "running", now);
    }
  }

  private activeChild(job: BibleBackfillJob) {
    const settling = this.backfills
      .listItems(job.id)
      .find((item) => item.status === "settling" && item.runId);
    const child = settling?.runId ? this.runs.getRun(settling.runId) : null;
    return child && !["completed", "failed", "cancelled"].includes(child.status)
      ? child
      : null;
  }

  private requireItem(job: BibleBackfillJob, ordinal: number) {
    const item = this.backfills
      .listItems(job.id)
      .find((candidate) => candidate.ordinal === ordinal);
    if (!item) {
      throw new BibleBackfillError(
        "bible_backfill.item.not_found",
        "This chapter is not part of the Story Bible completion",
        404,
        { ordinal },
      );
    }
    return item;
  }

  private requireJob(projectId: string, jobId: string): BibleBackfillJob {
    const job = this.backfills.getJob(jobId);
    if (!job || job.projectId !== projectId) {
      throw new BibleBackfillError(
        "bible_backfill.not_found",
        "Story Bible completion not found",
        404,
      );
    }
    return job;
  }

  private requireProject(projectId: string): void {
    if (!this.projects.get(projectId)) {
      throw new BibleBackfillError(
        "project.not_found",
        "Project not found",
        404,
      );
    }
  }
}

/** Settlement runs this job created itself (as opposed to adopted Studio runs). */
export function isOwnBackfillRun(run: NarrativeRun, jobId: string): boolean {
  return run.policy.bibleBackfillJobId === jobId;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** What a settlement run produced, as far as the job is concerned. */
export type SettlementRunOutcome =
  | { kind: "in_progress" }
  | { kind: "empty" }
  | { kind: "failed" }
  | { kind: "cancelled" }
  /** status is null when the recorded change set no longer exists. */
  | { kind: "change_set"; changeSetId: string; status: string | null };

export function settlementRunOutcome(
  database: NarrativeDatabase,
  projectId: string,
  run: NarrativeRun,
): SettlementRunOutcome {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { kind: "in_progress" };
  if (run.status === "failed") return { kind: "failed" };
  if (run.status === "cancelled") return { kind: "cancelled" };
  const changeSetId = committedChangeSetId(
    new SqliteRunRepository(database).getSnapshot(run.id),
  );
  if (!changeSetId) return { kind: "empty" };
  const changeSet = new SqliteReviewRepository(database).getCanonChangeSet(
    projectId,
    changeSetId,
  );
  return { kind: "change_set", changeSetId, status: changeSet?.status ?? null };
}

/** The item error recorded for a failed settlement run. */
export function childFailureError(
  snapshot: RunSnapshot,
): Record<string, unknown> & { code: string } {
  const failedStep = [...snapshot.steps]
    .reverse()
    .find((step) => step.status === "failed");
  const classification = classifyStepError(failedStep?.error ?? null);
  return {
    code: classification.kind === "fatal" ? "child.fatal" : "child.failed",
    message: failedStep?.error?.message ?? "The settlement run failed",
    category: classification.category,
    runId: snapshot.run.id,
    stepId: failedStep?.id ?? null,
  };
}

const CANCELLED_ITEM_ERROR = {
  code: "bible_backfill.cancelled",
  message: "The Story Bible completion was cancelled",
} as const;

/**
 * Ends the job as cancelled; `error` records why when that was not the
 * author's cancel alone. A chapter still settling keeps its real outcome:
 * a finished run's change set stays awaiting a decision (reviewable in
 * Studio), is applied/rejected, or the chapter had no changes; a failed run
 * keeps its failure; only a run that was actually cancelled reads as
 * cancelled. A Studio settlement the job adopted and that is still running
 * is detached — it continues in Studio and the chapter returns to pending.
 * A chapter edited during the job whose settlement the job took over
 * (retargetBackfillChapter) but never started is handed back to the writing
 * path, which starts the settlement its commit would have started.
 * Returns the ids of settlement runs created for that hand-back.
 */
export function finalizeBackfillCancellation(
  database: NarrativeDatabase,
  environment: Readonly<Record<string, string | undefined>>,
  jobId: string,
  now: string,
  error: Readonly<Record<string, unknown>> | null = null,
): string[] {
  const backfills = new SqliteBibleBackfillRepository(database);
  const runs = new SqliteRunRepository(database);
  const job = backfills.requireJob(jobId);
  for (const item of backfills.listItems(jobId)) {
    if (item.status !== "settling") continue;
    const run = item.runId ? runs.getRun(item.runId) : null;
    const outcome = run
      ? settlementRunOutcome(database, job.projectId, run)
      : null;
    if (
      run &&
      outcome?.kind === "in_progress" &&
      !isOwnBackfillRun(run, jobId)
    ) {
      backfills.updateItem(
        jobId,
        item.ordinal,
        {
          status: "pending",
          runId: null,
          changeSetId: null,
          note: {
            ...item.note,
            code: "bible_backfill.item.detached",
            detachedRunId: run.id,
          },
        },
        now,
      );
      continue;
    }
    backfills.updateItem(
      jobId,
      item.ordinal,
      cancelledItemOutcome(database, outcome, run),
      now,
    );
  }
  const handedBack = handBackRetargetedChapters(
    database,
    environment,
    job,
    now,
  );
  backfills.setJobStatus(jobId, "cancelled", now, error);
  return handedBack;
}

/**
 * Chapters committed during the job and left pending: without the job their
 * commit would have started a writing-path settlement, so start it now —
 * under the writing path's own rule (nothing without a writing model) and
 * only when no settlement of that text exists yet.
 */
function handBackRetargetedChapters(
  database: NarrativeDatabase,
  environment: Readonly<Record<string, string | undefined>>,
  job: BibleBackfillJob,
  now: string,
): string[] {
  const backfills = new SqliteBibleBackfillRepository(database);
  const runs = new SqliteRunRepository(database);
  const documents = new SqliteDocumentRepository(database);
  const created: string[] = [];
  for (const item of backfills.listItems(job.id)) {
    if (
      item.status !== "pending" ||
      typeof item.note?.retargetedFromVersionId !== "string" ||
      runs.listRunsForDocumentVersion(
        job.projectId,
        "manual-settlement",
        item.versionId,
      ).length > 0 ||
      !hasWritingAssignment(database, environment)
    ) {
      continue;
    }
    const document = documents.get(job.projectId, item.documentId);
    if (
      document?.kind !== "chapter" ||
      document.outlineNodeId !== item.outlineNodeId ||
      document.currentVersionId !== item.versionId
    ) {
      continue;
    }
    const run = createManualSettlementRun({
      database,
      environment,
      runId: deterministicUuid(
        `bible-backfill-hand-back\0${job.id}\0${item.versionId}`,
      ),
      projectId: job.projectId,
      document,
      versionId: item.versionId,
      origin: { surface: "writing", documentId: document.id },
      now,
    });
    backfills.updateItem(
      job.id,
      item.ordinal,
      {
        note: {
          ...item.note,
          code: "bible_backfill.item.handed_back",
          handedBackRunId: run.id,
        },
      },
      now,
    );
    created.push(run.id);
  }
  return created;
}

function cancelledItemOutcome(
  database: NarrativeDatabase,
  outcome: SettlementRunOutcome | null,
  run: NarrativeRun | null,
): BibleBackfillItemPatch {
  switch (outcome?.kind) {
    case "empty":
      return { status: "empty", changeSetId: null };
    case "change_set":
      if (outcome.status === "candidate") {
        return {
          status: "awaiting_decision",
          changeSetId: outcome.changeSetId,
        };
      }
      if (outcome.status === "rejected") {
        return { status: "rejected", changeSetId: outcome.changeSetId };
      }
      if (outcome.status !== null) {
        return { status: "applied", changeSetId: outcome.changeSetId };
      }
      return { status: "failed", error: { ...CANCELLED_ITEM_ERROR } };
    case "failed":
      return {
        status: "failed",
        error: childFailureError(
          new SqliteRunRepository(database).getSnapshot(run!.id),
        ),
      };
    default:
      return { status: "failed", error: { ...CANCELLED_ITEM_ERROR } };
  }
}

/** Outcome of routing a chapter commit to an active Story Bible completion. */
export interface BackfillRetarget {
  /** The job settles this version itself; start no separate settlement. */
  handled: boolean;
  /** A superseded running child run to interrupt once the commit lands. */
  interruptRunId: string | null;
}

const RETARGETABLE_ITEM_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "settling",
  "awaiting_decision",
]);

/**
 * A chapter version committed while the project's active completion still
 * has to settle that chapter (its item is pending, settling, or awaiting a
 * decision on a still undecided change set) is settled by the job — once, at
 * the new version — instead of by a second writing-path settlement. The item
 * is re-targeted: a superseded run the job created is cancelled, a Studio run
 * it adopted is detached (it keeps running), a superseded undecided change
 * set stays reviewable in Studio, and all of it is recorded on the item note.
 * A stop that concerned the superseded text is lifted so the job reads the
 * new version; a pause stays in place.
 */
export function retargetBackfillChapter(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    documentId: string;
    outlineNodeId: string;
    versionId: string;
    now: string;
  },
): BackfillRetarget {
  const notHandled = { handled: false, interruptRunId: null };
  const backfills = new SqliteBibleBackfillRepository(database);
  const job = backfills.findActiveJob(input.projectId);
  if (!job || job.cancelRequested) return notHandled;
  const items = backfills.listItems(job.id);
  const item = items.find(
    (candidate) =>
      candidate.documentId === input.documentId &&
      candidate.outlineNodeId === input.outlineNodeId &&
      RETARGETABLE_ITEM_STATUSES.has(candidate.status),
  );
  if (!item) return notHandled;
  if (item.versionId === input.versionId) {
    return { handled: true, interruptRunId: null };
  }
  const runs = new SqliteRunRepository(database);
  const { now } = input;
  const note: Record<string, unknown> = {
    ...withoutSupersededFields(item.note),
    code: "bible_backfill.item.retargeted",
    retargetedFromVersionId: item.versionId,
  };
  let interruptRunId: string | null = null;
  const run = item.runId ? runs.getRun(item.runId) : null;
  if (item.status === "awaiting_decision") {
    const changeSet = item.changeSetId
      ? new SqliteReviewRepository(database).getCanonChangeSet(
          job.projectId,
          item.changeSetId,
        )
      : null;
    // Already decided: the job records that decision; the new text is
    // settled like any later edit.
    if (changeSet && changeSet.status !== "candidate") return notHandled;
    if (run) {
      note.supersededRunId = run.id;
      note.supersededRunAction = "finished";
    }
    if (changeSet) note.supersededChangeSetId = changeSet.id;
  } else if (item.status === "settling" && run) {
    note.supersededRunId = run.id;
    const outcome = settlementRunOutcome(database, job.projectId, run);
    if (outcome.kind === "in_progress") {
      if (isOwnBackfillRun(run, job.id)) {
        if (run.status === "running") {
          if (!run.cancelRequested) runs.requestCancel(run.id, now);
          interruptRunId = run.id;
        } else {
          runs.setRunStatus(
            run.id,
            "cancelled",
            now,
            "bible_backfill_retargeted",
          );
        }
        note.supersededRunAction = "cancelled";
      } else {
        note.supersededRunAction = "detached";
      }
    } else {
      note.supersededRunAction = "finished";
      if (outcome.kind === "change_set" && outcome.status === "candidate") {
        note.supersededChangeSetId = outcome.changeSetId;
      }
    }
  }
  backfills.updateItem(
    job.id,
    item.ordinal,
    {
      status: "pending",
      versionId: input.versionId,
      runId: null,
      changeSetId: null,
      error: null,
      note,
    },
    now,
  );
  if (
    currentBackfillItem(items)?.ordinal === item.ordinal &&
    (job.status === "awaiting_decision" ||
      (job.status === "awaiting_user" && job.error?.ordinal === item.ordinal))
  ) {
    backfills.setJobStatus(job.id, "running", now);
  }
  return { handled: true, interruptRunId };
}

const SUPERSEDED_NOTE_FIELDS = [
  "supersededRunId",
  "supersededRunAction",
  "supersededChangeSetId",
] as const;

/** A note without what an earlier re-target superseded. */
function withoutSupersededFields(
  note: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(note ?? {}).filter(
      ([key]) => !(SUPERSEDED_NOTE_FIELDS as readonly string[]).includes(key),
    ),
  );
}

function availableActions(
  job: BibleBackfillJob,
  items: readonly BibleBackfillItem[],
): BibleBackfillAction[] {
  if (isTerminalBackfillJob(job)) return [];
  const current = currentBackfillItem(items);
  const actions: BibleBackfillAction[] = [];
  if (["running", "awaiting_decision"].includes(job.status)) {
    if (!job.pauseRequested) actions.push("pause");
  }
  if (
    ["paused", "awaiting_user"].includes(job.status) &&
    current?.status !== "failed"
  ) {
    actions.push("resume");
  }
  if (!job.cancelRequested) actions.push("cancel");
  if (
    items.some((item) =>
      ["pending", "failed", "awaiting_decision"].includes(item.status),
    )
  ) {
    actions.push("skip_item");
  }
  if (items.some((item) => item.status === "failed")) {
    actions.push("retry_item");
  }
  return actions;
}

function notAvailable(action: string, job: BibleBackfillJob) {
  return new BibleBackfillError(
    "bible_backfill.action.not_available",
    `Cannot ${action} the Story Bible completion while it is ${job.status}`,
    409,
  );
}

function emptyDetail(): BibleBackfillDetailDto {
  return BibleBackfillDetailSchema.parse({
    job: null,
    items: [],
    counts: {
      total: 0,
      pending: 0,
      settling: 0,
      awaitingDecision: 0,
      applied: 0,
      rejected: 0,
      empty: 0,
      failed: 0,
      skipped: 0,
    },
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    availableActions: [],
  });
}
