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
import type { DocumentVersion } from "@narralume/domain";
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
  type BibleBackfillItemSeed,
  type BibleBackfillJob,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { deterministicRequestId, hashRequest } from "./request-idempotency.js";
import { requireWritingAssignment } from "./run-policy.js";
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

  /** Returns a running child run to interrupt once the transaction commits. */
  private cancel(job: BibleBackfillJob, now: string): string | null {
    this.backfills.requestControl(job.id, "cancel", now);
    const child = this.activeChild(job);
    if (child?.status === "running") {
      if (!child.cancelRequested) this.runs.requestCancel(child.id, now);
      return child.id;
    }
    if (child) {
      this.runs.setRunStatus(
        child.id,
        "cancelled",
        now,
        "bible_backfill_cancelled",
      );
    }
    finalizeBackfillCancellation(this.backfills, job.id, now);
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

/**
 * Marks an interrupted chapter as failed(cancelled) and ends the job;
 * `error` records why the job ended when that was not the author's cancel alone.
 */
export function finalizeBackfillCancellation(
  backfills: SqliteBibleBackfillRepository,
  jobId: string,
  now: string,
  error: Readonly<Record<string, unknown>> | null = null,
): void {
  for (const item of backfills.listItems(jobId)) {
    if (item.status === "settling") {
      backfills.updateItem(
        jobId,
        item.ordinal,
        {
          status: "failed",
          error: {
            code: "bible_backfill.cancelled",
            message: "The Story Bible completion was cancelled",
          },
        },
        now,
      );
    }
  }
  backfills.setJobStatus(jobId, "cancelled", now, error);
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
