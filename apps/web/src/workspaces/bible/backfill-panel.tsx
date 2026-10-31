/* "Fill in the story bible from the manuscript": runs the manual settlement
   pipeline chapter by chapter in reading order. The panel sits at the top of
   the story bible page and handles start confirmation, progress, per-chapter
   decisions, stop handling, and guidance on the next step after completion. */

import "../../styles/bible-backfill.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  BookOpenCheck,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleMinus,
  CircleX,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n, type MessageKey } from "../../i18n";
import {
  actOnBibleBackfill,
  ApiError,
  getCanonChangeSets,
  getCurrentBibleBackfill,
  knownApiErrorMessage,
  startBibleBackfill,
  startCanonCandidate,
  type BibleBackfillAction,
  type BibleBackfillCreatedDto,
  type BibleBackfillDetailDto,
  type BibleBackfillItemDto,
  type BibleBackfillJobDto,
  type BibleBackfillMode,
  type BibleBackfillUsageDto,
  type StoryBible,
} from "../../lib/api";
import { formatCount } from "../../lib/fmt";
import { projectWorkspacePath } from "../../lib/project-route";
import { eventAwareInterval, useServerEvents } from "../../lib/sse";
import {
  CanonChangeSetReview,
  parseSettlementConflicts,
  SettlementConflictNote,
} from "../shared/canon-change-review";
import type { BibleEditorSection } from "./editor";

const ACTIVE_STATUSES = new Set([
  "running",
  "paused",
  "awaiting_decision",
  "awaiting_user",
]);
const SKIPPABLE_ITEM_STATUSES = new Set([
  "pending",
  "failed",
  "awaiting_decision",
]);
const POLL_INTERVAL_MS = 2_500;
/**
 * After completion, guide the author to each panel's AI candidate panel to fill
 * in the macro parts.
 */
const NEXT_SECTIONS: BibleEditorSection[] = ["intent", "outline", "entities"];
/**
 * Macro panels for which AI generates suggestions after all chapters are read,
 * started one by one in this order.
 */
const GENERATED_SECTIONS = ["intent", "entities", "outline"] as const;
type GeneratedSection = (typeof GENERATED_SECTIONS)[number];
/**
 * Chapter states that allow "re-read": chapters already read (or that failed to
 * read, or were rejected).
 */
const REREADABLE_ITEM_STATUSES = new Set([
  "applied",
  "empty",
  "rejected",
  "skipped",
  "failed",
]);

/* A job started with "then generate macro panels" checked is remembered on this
   device; when the job completes the panel starts the generation once from that
   flag, taking the flag first to avoid starting twice. */
const SECTIONS_MARKER_PREFIX = "lapis:bible-backfill:sections:";
function rememberSectionsAfter(jobId: string) {
  try {
    window.localStorage.setItem(SECTIONS_MARKER_PREFIX + jobId, "1");
  } catch {
    /* When storage is unavailable, fall back to the manual button. */
  }
}
function takeSectionsMarker(jobId: string): boolean {
  try {
    const key = SECTIONS_MARKER_PREFIX + jobId;
    const had = window.localStorage.getItem(key) !== null;
    window.localStorage.removeItem(key);
    return had;
  } catch {
    return false;
  }
}

function bibleBackfillQueryKey(projectId: string) {
  return ["project", projectId, "bible-backfill", "current"] as const;
}

interface BibleBackfillPanelProps {
  projectId: string;
  bible: StoryBible;
  /**
   * Entered from the entry shown after an import finishes: expand and focus the
   * panel.
   */
  focus?: boolean;
  onOpenCandidateDesk: (section: BibleEditorSection) => void;
}

export function BibleBackfillPanel({
  projectId,
  bible,
  focus = false,
  onOpenCandidateDesk,
}: BibleBackfillPanelProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const titleId = useId();
  const bodyId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queryKey = bibleBackfillQueryKey(projectId);
  /* Poll only while reading is in progress (running, including a chapter being
     settled); when paused, waiting for review or waiting for handling, progress
     does not change by itself, so SSE and refreshes after actions are enough.
     */
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getCurrentBibleBackfill(projectId, signal),
    refetchInterval: (current) =>
      current.state.data?.job?.status === "running" ? eventAwareInterval(POLL_INTERVAL_MS) : false,
  });
  const detail = query.data;
  const job = detail?.job ?? null;
  const items = useMemo(
    () => [...(detail?.items ?? [])].sort((a, b) => a.ordinal - b.ordinal),
    [detail?.items],
  );
  const active = Boolean(job && ACTIVE_STATUSES.has(job.status));
  const chapterManuscripts = bible.documents.filter(
    (document) =>
      document.kind === "chapter" &&
      !document.archivedAt &&
      document.currentVersionId,
  ).length;
  const singleManuscript =
    chapterManuscripts === 0 &&
    bible.documents.some(
      (document) => document.kind === "manuscript" && !document.archivedAt,
    );

  /* Expansion: a manual toggle by the author wins; otherwise expand
     automatically for the focus entry, while in progress (and staying expanded
     after it ends), or when there is chapter text that has never been filled
     in. */
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const [sawActive, setSawActive] = useState(false);
  if (active && !sawActive) setSawActive(true);
  const expanded =
    expandedChoice ??
    (focus ||
      active ||
      sawActive ||
      (query.isSuccess && !job && chapterManuscripts > 0));
  const setExpanded = (value: boolean) => setExpandedChoice(value);
  useEffect(() => {
    if (!focus) return;
    headingRef.current?.scrollIntoView?.({ block: "start" });
    headingRef.current?.focus();
  }, [focus]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
  };
  const refreshBible = () => {
    void queryClient.invalidateQueries({
      queryKey: ["project", projectId, "bible"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["project", projectId, "story-bible"],
    });
  };
  const watchedRunIds = new Set(
    items
      .filter((item) => item.runId && item.status === "settling")
      .map((item) => item.runId!),
  );
  useServerEvents({
    onBibleBackfillStatus: (event) => {
      if (event.projectId === projectId) refresh();
    },
    onRunStatus: (runId) => {
      if (watchedRunIds.has(runId)) refresh();
    },
    onRunEvent: (runId) => {
      if (watchedRunIds.has(runId)) refresh();
    },
  });
  /* When the accepted count or the job status changes, story bible content may
     have been written; refresh the reading view. */
  const contentSignal = job
    ? `${job.id}:${job.status}:${detail?.counts.applied ?? 0}`
    : null;
  const previousSignal = useRef<string | null>(null);
  useEffect(() => {
    if (
      previousSignal.current !== null &&
      contentSignal !== previousSignal.current
    )
      refreshBible();
    previousSignal.current = contentSignal;
  }, [contentSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mode, setMode] = useState<BibleBackfillMode>(
    "auto_apply_stop_on_conflict",
  );
  const [withSections, setWithSections] = useState(true);
  const startRequestRef = useRef<{
    mode: BibleBackfillMode;
    requestId: string;
  } | null>(null);
  const startMutation = useMutation({
    mutationFn: (selectedMode: BibleBackfillMode) => {
      if (startRequestRef.current?.mode !== selectedMode) {
        startRequestRef.current = {
          mode: selectedMode,
          requestId: crypto.randomUUID(),
        };
      }
      return startBibleBackfill(projectId, {
        requestId: startRequestRef.current.requestId,
        mode: selectedMode,
      });
    },
    onSuccess: (created) => {
      startRequestRef.current = null;
      setConfirmOpen(false);
      setExpanded(true);
      if (withSections && !created.idempotentReplay)
        rememberSectionsAfter(created.job.id);
      queryClient.setQueryData(queryKey, toDetail(created));
      refresh();
    },
    onError: (error) => {
      setConfirmOpen(false);
      if (error instanceof ApiError && error.code === "bible_backfill.active")
        refresh();
    },
  });

  /* Macro panels (author intent, entities, outline): start the existing AI
     candidate generation one by one; results stay as candidates for review in
     each panel. A generation already running for the same panel counts as
     started. */
  const sectionsMutation = useMutation({
    mutationFn: async (): Promise<GeneratedSection[]> => {
      const failed: GeneratedSection[] = [];
      for (const section of GENERATED_SECTIONS) {
        try {
          await startCanonCandidate(projectId, section, {
            requestId: crypto.randomUUID(),
            instruction: t(`bible.backfill.next.instruction.${section}`),
          });
        } catch (error) {
          if (
            !(
              error instanceof ApiError &&
              error.code === "canon_candidate.active_run_exists"
            )
          )
            failed.push(section);
        }
      }
      return failed;
    },
  });
  const jobId = job?.id ?? null;
  const jobStatus = job?.status ?? null;
  useEffect(() => {
    if (!jobId) return;
    if (jobStatus === "completed") {
      if (takeSectionsMarker(jobId)) sectionsMutation.mutate();
    } else if (jobStatus === "cancelled") {
      takeSectionsMarker(jobId);
    }
  }, [jobId, jobStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Re-read a single chapter: create a new fill-in with that chapter as its
  only item; it is read even if already settled, to fill gaps and fix mistakes.
  */
  const [rereadTarget, setRereadTarget] = useState<{
    item: BibleBackfillItemDto;
    title: string;
  } | null>(null);
  const [rereadReview, setRereadReview] = useState(true);
  const rereadMutation = useMutation({
    mutationFn: (item: BibleBackfillItemDto) =>
      startBibleBackfill(projectId, {
        requestId: crypto.randomUUID(),
        mode: rereadReview ? "review_each" : "auto_apply_stop_on_conflict",
        chapterIds: [item.outlineNodeId],
        rereadSettled: true,
      }),
    onSuccess: (created) => {
      setRereadTarget(null);
      setExpanded(true);
      queryClient.setQueryData(queryKey, toDetail(created));
      refresh();
    },
    onError: (error) => {
      setRereadTarget(null);
      if (error instanceof ApiError && error.code === "bible_backfill.active")
        refresh();
    },
  });

  const [cancelOpen, setCancelOpen] = useState(false);
  const actionMutation = useMutation({
    mutationFn: (input: {
      jobId: string;
      action: BibleBackfillAction;
      ordinal?: number;
    }) =>
      actOnBibleBackfill(projectId, input.jobId, {
        requestId: crypto.randomUUID(),
        action: input.action,
        ...(input.ordinal !== undefined ? { ordinal: input.ordinal } : {}),
      }),
    onSuccess: (result) => {
      setCancelOpen(false);
      queryClient.setQueryData(queryKey, toDetail(result));
      refresh();
    },
    onError: () => {
      setCancelOpen(false);
      refresh();
    },
  });
  const act = (action: BibleBackfillAction, ordinal?: number) => {
    if (!job) return;
    actionMutation.mutate({
      jobId: job.id,
      action,
      ...(ordinal !== undefined ? { ordinal } : {}),
    });
  };

  const current = job ? currentItem(job, items) : null;
  const position = current ? items.indexOf(current) + 1 : 0;
  const total = detail?.counts.total ?? items.length;
  const done = detail
    ? detail.counts.total -
      detail.counts.pending -
      detail.counts.settling -
      detail.counts.awaitingDecision
    : 0;
  const currentTitle = current
    ? (current.title ?? t("bible.backfill.progress.untitled", { number: position }))
    : "";

  const summary = !job
    ? t("bible.backfill.summary.notStarted")
    : job.status === "running"
      ? t("bible.backfill.summary.running", {
          current: Math.max(position, Math.min(done + 1, total)),
          total,
        })
      : job.status === "paused"
        ? t("bible.backfill.summary.paused", { done, total })
        : job.status === "awaiting_decision"
          ? t("bible.backfill.summary.awaitingDecision", { current: position })
          : job.status === "awaiting_user"
            ? t("bible.backfill.summary.awaitingUser")
            : job.status === "completed"
              ? t("bible.backfill.summary.completed", { total })
              : t("bible.backfill.summary.cancelled", { done, total });

  const showStartError =
    startMutation.isError && !(job && ACTIVE_STATUSES.has(job.status));
  const showRereadError =
    rereadMutation.isError && !(job && ACTIVE_STATUSES.has(job.status));

  return (
    <section
      className="bible-backfill"
      aria-labelledby={titleId}
      data-status={job?.status ?? "idle"}
    >
      <header className="bible-backfill__head">
        <span className="bible-backfill__seal" aria-hidden="true">
          <BookOpenCheck size={16} strokeWidth={1.45} />
        </span>
        <div className="bible-backfill__heading">
          <p className="bible-backfill__eyebrow mono">
            {t("bible.backfill.eyebrow")}
          </p>
          <h2 id={titleId} ref={headingRef} tabIndex={-1}>
            {t("bible.backfill.title")}
          </h2>
          <p className="bible-backfill__summary" role="status">
            {query.isPending ? null : summary}
          </p>
        </div>
        <button
          type="button"
          className="btn bible-backfill__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t("bible.backfill.hide") : t("bible.backfill.show")}
          {expanded ? (
            <ChevronUp size={13} aria-hidden="true" />
          ) : (
            <ChevronDown size={13} aria-hidden="true" />
          )}
        </button>
      </header>

      <div id={bodyId} className="bible-backfill__body" hidden={!expanded}>
        {expanded ? (
          <>
          {query.isPending ? (
            <Skeleton lines={2} />
          ) : query.isError ? (
            <ErrorNote error={query.error} title={t("bible.backfill.errors.load")} />
          ) : !job ? (
            <IdleState
              chapterManuscripts={chapterManuscripts}
              singleManuscript={singleManuscript}
              pending={startMutation.isPending}
              onStart={() => setConfirmOpen(true)}
            />
          ) : active ? (
            <ActiveState
              projectId={projectId}
              bible={bible}
              detail={detail!}
              job={job}
              items={items}
              current={current}
              position={position}
              total={total}
              done={done}
              currentTitle={currentTitle}
              actionPending={actionMutation.isPending}
              actionError={actionMutation.isError ? actionMutation.error : null}
              onAct={act}
              onCancel={() => setCancelOpen(true)}
              onDecided={() => {
                refresh();
                refreshBible();
              }}
            />
          ) : (
            <FinishedState
              projectId={projectId}
              detail={detail!}
              job={job}
              items={items}
              pending={startMutation.isPending || rereadMutation.isPending}
              sections={{
                pending: sectionsMutation.isPending,
                started: sectionsMutation.isSuccess,
                failed:
                  sectionsMutation.isError ||
                  (sectionsMutation.data?.length ?? 0) > 0,
              }}
              onGenerateSections={() => sectionsMutation.mutate()}
              onStartAgain={() => setConfirmOpen(true)}
              onOpenCandidateDesk={onOpenCandidateDesk}
              onReread={(item, title) => {
                setRereadReview(true);
                setRereadTarget({ item, title });
              }}
            />
          )}
          {showStartError ? (
            <StartError error={startMutation.error} />
          ) : null}
          {showRereadError ? (
            <StartError error={rereadMutation.error} />
          ) : null}
          </>
        ) : null}
      </div>

      {confirmOpen ? (
        <ConfirmDialog
          title={t("bible.backfill.confirm.title")}
          confirmLabel={t("bible.backfill.confirm.submit")}
          pending={startMutation.isPending}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => startMutation.mutate(mode)}
        >
          <fieldset className="bible-backfill__modes">
            <legend>{t("bible.backfill.confirm.modeLegend")}</legend>
            <label>
              <input
                type="radio"
                name="bible-backfill-mode"
                value="auto_apply_stop_on_conflict"
                checked={mode === "auto_apply_stop_on_conflict"}
                onChange={() => setMode("auto_apply_stop_on_conflict")}
              />
              <span>
                <strong>{t("bible.backfill.confirm.autoApply")}</strong>
                <small>{t("bible.backfill.confirm.autoApplyHint")}</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="bible-backfill-mode"
                value="review_each"
                checked={mode === "review_each"}
                onChange={() => setMode("review_each")}
              />
              <span>
                <strong>{t("bible.backfill.confirm.reviewEach")}</strong>
                <small>{t("bible.backfill.confirm.reviewEachHint")}</small>
              </span>
            </label>
          </fieldset>
          <label className="bible-backfill__sections-option">
            <input
              type="checkbox"
              checked={withSections}
              onChange={(event) => setWithSections(event.target.checked)}
            />
            <span>{t("bible.backfill.confirm.withSections")}</span>
          </label>
          <p>
            {chapterManuscripts > 0
              ? t("bible.backfill.confirm.scopeCount", {
                  count: chapterManuscripts,
                })
              : t("bible.backfill.confirm.scopeAll")}
          </p>
          <p className="bible-backfill__cost">
            {t("bible.backfill.confirm.cost")}
          </p>
        </ConfirmDialog>
      ) : null}
      {cancelOpen && job ? (
        <ConfirmDialog
          title={t("bible.backfill.cancelDialog.title")}
          confirmLabel={t("bible.backfill.cancelDialog.confirm")}
          danger
          pending={actionMutation.isPending}
          onCancel={() => setCancelOpen(false)}
          onConfirm={() => act("cancel")}
        >
          <p>{t("bible.backfill.cancelDialog.body")}</p>
        </ConfirmDialog>
      ) : null}
      {rereadTarget ? (
        <ConfirmDialog
          title={t("bible.backfill.reread.title", { title: rereadTarget.title })}
          confirmLabel={t("bible.backfill.reread.submit")}
          pending={rereadMutation.isPending}
          onCancel={() => setRereadTarget(null)}
          onConfirm={() => rereadMutation.mutate(rereadTarget.item)}
        >
          <p>{t("bible.backfill.reread.body")}</p>
          <label className="bible-backfill__sections-option">
            <input
              type="checkbox"
              checked={rereadReview}
              onChange={(event) => setRereadReview(event.target.checked)}
            />
            <span>{t("bible.backfill.reread.review")}</span>
          </label>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

/* ---- Not started -------------------------------------------------------- */

function IdleState({
  chapterManuscripts,
  singleManuscript,
  pending,
  onStart,
}: {
  chapterManuscripts: number;
  singleManuscript: boolean;
  pending: boolean;
  onStart: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="bible-backfill__idle">
      <p className="bible-backfill__intro">{t("bible.backfill.intro")}</p>
      <p className="bible-backfill__scope">
        {singleManuscript
          ? t("bible.backfill.singleManuscript")
          : chapterManuscripts > 0
            ? t("bible.backfill.chaptersFound", { count: chapterManuscripts })
            : t("bible.backfill.chaptersUnknown")}
      </p>
      <div className="bible-backfill__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={pending}
          onClick={onStart}
        >
          <Sparkles size={13} aria-hidden="true" />
          {pending ? t("bible.backfill.starting") : t("bible.backfill.start")}
        </button>
      </div>
    </div>
  );
}

function StartError({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (error instanceof ApiError && error.code === "bible_backfill.no_chapters") {
    return (
      <div className="error-note" role="alert">
        <p className="error-note__title">
          {t("bible.backfill.errors.noChaptersTitle")}
        </p>
        <p className="error-note__message">
          {t("bible.backfill.errors.noChaptersBody")}
        </p>
      </div>
    );
  }
  return (
    <div className="bible-backfill__error">
      <ErrorNote error={error} title={t("bible.backfill.errors.start")} />
      {error instanceof ApiError && error.code.startsWith("model.") ? (
        <Link to="/settings">{t("bible.backfill.errors.openSettings")}</Link>
      ) : null}
    </div>
  );
}

/* ---- In progress -------------------------------------------------------- */

function ActiveState({
  projectId,
  bible,
  detail,
  job,
  items,
  current,
  position,
  total,
  done,
  currentTitle,
  actionPending,
  actionError,
  onAct,
  onCancel,
  onDecided,
}: {
  projectId: string;
  bible: StoryBible;
  detail: BibleBackfillDetailDto;
  job: BibleBackfillJobDto;
  items: BibleBackfillItemDto[];
  current: BibleBackfillItemDto | null;
  position: number;
  total: number;
  done: number;
  currentTitle: string;
  actionPending: boolean;
  actionError: unknown;
  onAct: (action: BibleBackfillAction, ordinal?: number) => void;
  onCancel: () => void;
  onDecided: () => void;
}) {
  const { t } = useI18n();
  const can = (action: BibleBackfillAction) =>
    detail.availableActions.includes(action);
  const canSkipCurrent = Boolean(
    current && can("skip_item") && SKIPPABLE_ITEM_STATUSES.has(current.status),
  );
  const entityNames = useMemo(
    () => new Map(bible.entities.map((entity) => [entity.id, entity.name])),
    [bible.entities],
  );
  const conflict =
    job.status === "awaiting_user" && job.error?.code === "settlement.conflict"
      ? parseSettlementConflicts(errorPayload(job.error))
      : null;
  const review =
    job.status === "awaiting_user" &&
    job.error?.code === "bible_backfill.review_required"
      ? reviewTargets(job.error)
      : null;
  const conflictChangeSetId =
    conflict || review ? stringField(job.error, "changeSetId") : null;
  const reviewChangeSetId =
    job.status === "awaiting_decision"
      ? (current?.changeSetId ?? null)
      : conflictChangeSetId;
  /* A stop for a conflict or pending review requires deciding this chapter's
     change set first (it continues automatically after the decision), so
     "Continue" would only stop again and is hidden; "Continue" shows only when
     the change set was decided elsewhere, no longer exists, or failed to load.
     */
  const stopChangeSets = useQuery({
    queryKey: ["project", projectId, "canon-change-sets"],
    queryFn: ({ signal }) => getCanonChangeSets(projectId, signal),
    enabled: Boolean(conflictChangeSetId),
  });
  const decisionPending = Boolean(
    conflictChangeSetId &&
      (stopChangeSets.isPending ||
        stopChangeSets.data?.find((set) => set.id === conflictChangeSetId)
          ?.status === "candidate"),
  );
  const canResume = can("resume") && !decisionPending;

  return (
    <div className="bible-backfill__active">
      <div className="bible-backfill__progress">
        <div
          className="bible-backfill__bar"
          role="progressbar"
          aria-label={t("bible.backfill.progress.label")}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        <p className="mono">
          {t("bible.backfill.progress.count", { done, total })}
        </p>
      </div>
      <UsageLine usage={detail.usage} />

      {job.status === "running" && (job.cancelRequested || job.pauseRequested || current) ? (
        <p className="bible-backfill__note">
          {job.cancelRequested ? (
            t("bible.backfill.progress.cancelling")
          ) : job.pauseRequested ? (
            t("bible.backfill.progress.pausing")
          ) : (
            <>
              <LoaderCircle
                className="bible-backfill__spin"
                size={13}
                aria-hidden="true"
              />
              {t("bible.backfill.progress.settling", {
                current: position,
                total,
                title: currentTitle,
              })}
            </>
          )}
        </p>
      ) : null}
      {job.status === "paused" ? (
        <p className="bible-backfill__note">
          {t("bible.backfill.progress.paused")}
        </p>
      ) : null}

      {job.status === "awaiting_decision" ? (
        <div className="bible-backfill__stage" data-tone="review">
          <h3>
            {t("bible.backfill.decision.title", {
              current: position,
              total,
              title: currentTitle,
            })}
          </h3>
          <p>{t("bible.backfill.decision.intro")}</p>
          <ChangeSetSlot
            projectId={projectId}
            changeSetId={reviewChangeSetId}
            entityNames={entityNames}
            labels={{
              apply: t("bible.backfill.decision.apply"),
              defer: t("bible.backfill.decision.reject"),
              forceApply: t("bible.backfill.decision.force"),
            }}
            disabled={actionPending}
            onDecided={onDecided}
          />
          {canSkipCurrent && current ? (
            <>
              <div className="bible-backfill__actions">
                <button
                  type="button"
                  className="btn"
                  disabled={actionPending}
                  onClick={() => onAct("skip_item", current.ordinal)}
                >
                  <SkipForward size={12} aria-hidden="true" />
                  {t("bible.backfill.actions.skip")}
                </button>
              </div>
              <SkipHint item={current} />
            </>
          ) : null}
        </div>
      ) : null}

      {job.status === "awaiting_user" ? (
        <AttentionState
          projectId={projectId}
          job={job}
          current={current}
          position={position}
          conflict={conflict}
          review={review}
          conflictChangeSetId={conflictChangeSetId}
          entityNames={entityNames}
          canRetry={Boolean(
            current && current.status === "failed" && can("retry_item"),
          )}
          canSkip={canSkipCurrent}
          canResume={can("resume")}
          actionPending={actionPending}
          onAct={onAct}
          onDecided={() => {
            onDecided();
            if (can("resume")) onAct("resume");
          }}
        />
      ) : null}

      <div className="bible-backfill__actions">
        {can("pause") ? (
          <button
            type="button"
            className="btn"
            disabled={actionPending}
            onClick={() => onAct("pause")}
          >
            <Pause size={12} aria-hidden="true" />
            {t("bible.backfill.actions.pause")}
          </button>
        ) : null}
        {canResume ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={actionPending}
            onClick={() => onAct("resume")}
          >
            <Play size={12} aria-hidden="true" />
            {t("bible.backfill.actions.resume")}
          </button>
        ) : null}
        {can("cancel") ? (
          <button
            type="button"
            className="btn"
            disabled={actionPending}
            onClick={onCancel}
          >
            {t("bible.backfill.actions.cancel")}
          </button>
        ) : null}
      </div>
      {can("resume") && decisionPending ? (
        <p className="bible-backfill__detail">
          {t("bible.backfill.attention.decideToContinue")}
        </p>
      ) : null}
      {actionError ? (
        <ErrorNote error={actionError} title={t("bible.backfill.errors.action")} />
      ) : null}

      <ItemList items={items} current={current} />
    </div>
  );
}

/**
 * Load and show the current chapter's change set; decisions go through the
 * existing story change decision endpoint.
 */
function ChangeSetSlot({
  projectId,
  changeSetId,
  entityNames,
  labels,
  forceAllowed,
  disabled,
  onDecided,
}: {
  projectId: string;
  changeSetId: string | null;
  entityNames: Map<string, string>;
  labels: { apply: string; defer: string; forceApply: string };
  forceAllowed?: boolean;
  disabled: boolean;
  onDecided: () => void;
}) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["project", projectId, "canon-change-sets"],
    queryFn: ({ signal }) => getCanonChangeSets(projectId, signal),
    enabled: Boolean(changeSetId),
  });
  const changeSet = changeSetId
    ? query.data?.find((set) => set.id === changeSetId)
    : undefined;
  /* The cache may come from the writing desk and predate this chapter's change
     set: load once more when it is missing. */
  const refetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (
      !changeSetId ||
      !query.isSuccess ||
      changeSet ||
      query.isFetching ||
      refetchedFor.current === changeSetId
    )
      return;
    refetchedFor.current = changeSetId;
    void query.refetch();
  }, [changeSetId, changeSet, query]);

  if (!changeSetId) return null;
  if (query.isPending || (!changeSet && query.isFetching))
    return <p className="bible-backfill__note">{t("bible.backfill.decision.loading")}</p>;
  if (query.isError)
    return <ErrorNote error={query.error} title={t("studio.errors.canonLoad")} />;
  if (!changeSet)
    return <p className="bible-backfill__note">{t("bible.backfill.decision.missing")}</p>;
  return (
    <div className="bible-backfill__review">
      <CanonChangeSetReview
        projectId={projectId}
        sets={[changeSet]}
        entityNames={entityNames}
        labels={labels}
        {...(forceAllowed !== undefined ? { forceAllowed } : {})}
        disabled={disabled}
        onDecided={onDecided}
      />
    </div>
  );
}

function AttentionState({
  projectId,
  job,
  current,
  position,
  conflict,
  review,
  conflictChangeSetId,
  entityNames,
  canRetry,
  canSkip,
  canResume,
  actionPending,
  onAct,
  onDecided,
}: {
  projectId: string;
  job: BibleBackfillJobDto;
  current: BibleBackfillItemDto | null;
  position: number;
  conflict: ReturnType<typeof parseSettlementConflicts>;
  /** Records a review_required stop lists; null for any other stop. */
  review: ReviewTarget[] | null;
  conflictChangeSetId: string | null;
  entityNames: Map<string, string>;
  canRetry: boolean;
  canSkip: boolean;
  canResume: boolean;
  actionPending: boolean;
  onAct: (action: BibleBackfillAction, ordinal?: number) => void;
  onDecided: () => void;
}) {
  const { t } = useI18n();
  const error = job.error ?? current?.error ?? null;
  const itemFailed = current?.status === "failed";
  const runId =
    stringField(error, "runId") ??
    stringField(current?.error ?? null, "runId") ??
    current?.runId ??
    null;
  const reason = error ? stopReason(error, t) : null;

  const title = conflict
    ? t("bible.backfill.attention.conflictTitle", { current: position })
    : review
      ? t("bible.backfill.attention.reviewTitle", { current: position })
      : itemFailed
      ? t("bible.backfill.attention.failedTitle", { current: position })
      : t("bible.backfill.attention.stoppedTitle");

  return (
    <div className="bible-backfill__stage" data-tone="attention">
      <h3>
        <CircleAlert size={14} aria-hidden="true" />
        {title}
      </h3>
      {conflict ? (
        <>
          <p>{t("bible.backfill.attention.conflictIntro")}</p>
          <SettlementConflictNote conflict={conflict} />
          <ChangeSetSlot
            projectId={projectId}
            changeSetId={conflictChangeSetId}
            entityNames={entityNames}
            labels={{
              apply: t("bible.backfill.attention.apply"),
              defer: t("bible.backfill.attention.reject"),
              forceApply: t("bible.backfill.attention.force"),
            }}
            forceAllowed={conflict.forceAllowed && canResume}
            disabled={actionPending}
            onDecided={onDecided}
          />
        </>
      ) : review ? (
        <>
          <p>{t("bible.backfill.attention.reviewIntro")}</p>
          {review.length > 0 ? (
            <ul
              className="bible-backfill__review-targets"
              aria-label={t("bible.backfill.attention.reviewTargetsLabel")}
            >
              {review.map((target) => (
                <li key={target.path}>
                  <strong>{t(reviewActionKey(target))}</strong>
                  {target.label ? ` · ${target.label}` : null}
                </li>
              ))}
            </ul>
          ) : null}
          <ChangeSetSlot
            projectId={projectId}
            changeSetId={conflictChangeSetId}
            entityNames={entityNames}
            labels={{
              apply: t("bible.backfill.attention.apply"),
              defer: t("bible.backfill.attention.reject"),
              forceApply: t("bible.backfill.attention.force"),
            }}
            forceAllowed={false}
            disabled={actionPending}
            onDecided={onDecided}
          />
        </>
      ) : (
        <>
          {itemFailed ? <p>{t("bible.backfill.attention.failedIntro")}</p> : null}
          {reason ? <StopReasonText reason={reason} /> : null}
          {error?.code.startsWith("model.") ? (
            <Link to="/settings">{t("bible.backfill.errors.openSettings")}</Link>
          ) : null}
        </>
      )}
      <div className="bible-backfill__actions">
        {canRetry && current ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={actionPending}
            onClick={() => onAct("retry_item", current.ordinal)}
          >
            <RotateCcw size={12} aria-hidden="true" />
            {t("bible.backfill.actions.retry")}
          </button>
        ) : null}
        {canSkip && current ? (
          <button
            type="button"
            className="btn"
            disabled={actionPending}
            onClick={() => onAct("skip_item", current.ordinal)}
          >
            <SkipForward size={12} aria-hidden="true" />
            {t("bible.backfill.actions.skip")}
          </button>
        ) : null}
        {runId ? (
          <Link
            className="bible-backfill__run-link"
            to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(runId)}`}
          >
            {t("bible.backfill.actions.viewRun")}
            <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      {canSkip && current ? <SkipHint item={current} /> : null}
    </div>
  );
}

/**
 * Skipping a chapter pending decision does not decide it: the change set stays
 * reviewable at the writing desk.
 */
function SkipHint({ item }: { item: BibleBackfillItemDto }) {
  const { t } = useI18n();
  if (item.status !== "awaiting_decision" || !item.changeSetId) return null;
  return (
    <p className="bible-backfill__detail">{t("bible.backfill.decision.skipHint")}</p>
  );
}

/* ---- Finished ----------------------------------------------------------- */

function FinishedState({
  projectId,
  detail,
  job,
  items: jobItems,
  pending,
  sections,
  onGenerateSections,
  onStartAgain,
  onOpenCandidateDesk,
  onReread,
}: {
  projectId: string;
  detail: BibleBackfillDetailDto;
  job: BibleBackfillJobDto;
  items: BibleBackfillItemDto[];
  pending: boolean;
  sections: { pending: boolean; started: boolean; failed: boolean };
  onGenerateSections: () => void;
  onStartAgain: () => void;
  onOpenCandidateDesk: (section: BibleEditorSection) => void;
  onReread: (item: BibleBackfillItemDto, title: string) => void;
}) {
  const { t } = useI18n();
  /* Chapters left for review at the writing desk may since have been decided
     there: when the change set list is already in the cache, show its current
     state, without sending a separate request for it. */
  const cachedChangeSets = useQuery({
    queryKey: ["project", projectId, "canon-change-sets"],
    queryFn: ({ signal }) => getCanonChangeSets(projectId, signal),
    enabled: false,
  }).data;
  const { items, counts: jobCounts } = useMemo(
    () => withStudioDecisions(jobItems, detail.counts, cachedChangeSets),
    [jobItems, detail.counts, cachedChangeSets],
  );
  const title =
    job.status === "completed"
      ? t("bible.backfill.finished.completedTitle")
      : t("bible.backfill.finished.cancelledTitle");
  const counts: Array<{ key: MessageKey; value: number }> = [
    { key: "bible.backfill.finished.counts.total", value: jobCounts.total },
    { key: "bible.backfill.finished.counts.applied", value: jobCounts.applied },
    { key: "bible.backfill.finished.counts.rejected", value: jobCounts.rejected },
    { key: "bible.backfill.finished.counts.empty", value: jobCounts.empty },
    { key: "bible.backfill.finished.counts.skipped", value: jobCounts.skipped },
    { key: "bible.backfill.finished.counts.failed", value: jobCounts.failed },
    ...(jobCounts.awaitingDecision > 0
      ? [
          {
            key: "bible.backfill.finished.counts.awaitingDecision" as const,
            value: jobCounts.awaitingDecision,
          },
        ]
      : []),
  ];
  /* If an unexpected error occurs while cancelling, the job ends as cancelled
     and records the reason. */
  const reason = job.status === "cancelled" && job.error ? stopReason(job.error, t) : null;
  return (
    <div className="bible-backfill__finished">
      <h3>
        {job.status === "completed" ? (
          <CircleCheck size={14} aria-hidden="true" />
        ) : (
          <CircleAlert size={14} aria-hidden="true" />
        )}
        {title}
      </h3>
      <dl
        className="bible-backfill__counts"
        aria-label={t("bible.backfill.finished.countsLabel")}
      >
        {counts.map((entry) => (
          <div key={entry.key}>
            <dt>{t(entry.key)}</dt>
            <dd className="mono">{entry.value}</dd>
          </div>
        ))}
      </dl>
      <UsageLine usage={detail.usage} final />
      {/* Timeline events extracted at import that no chapter anchored during the
         fill-in: tell the author explicitly how many remain. */}
      {detail.unanchoredImportedEvents > 0 ? (
        <p className="bible-backfill__note">
          <CircleAlert size={13} aria-hidden="true" />
          {t("bible.backfill.finished.unanchoredEvents", {
            count: detail.unanchoredImportedEvents,
          })}
        </p>
      ) : null}
      {reason ? <StopReasonText reason={reason} /> : null}
      {job.status === "completed" ? (
        <div className="bible-backfill__next">
          <h4>{t("bible.backfill.next.title")}</h4>
          <p role="status">
            {sections.started
              ? t("bible.backfill.next.started")
              : t("bible.backfill.next.body")}
          </p>
          {sections.failed ? (
            <p className="bible-backfill__note">
              <CircleAlert size={13} aria-hidden="true" />
              {t("bible.backfill.next.failed")}
            </p>
          ) : null}
          {!sections.started || sections.failed ? (
            <div className="bible-backfill__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={sections.pending}
                onClick={onGenerateSections}
              >
                <Sparkles size={12} aria-hidden="true" />
                {sections.pending
                  ? t("bible.backfill.next.generating")
                  : t("bible.backfill.next.generate")}
              </button>
            </div>
          ) : null}
          <div className="bible-backfill__actions">
            {NEXT_SECTIONS.map((section) => (
              <button
                key={section}
                type="button"
                className="btn"
                onClick={() => onOpenCandidateDesk(section)}
              >
                <Sparkles size={12} aria-hidden="true" />
                {t("bible.backfill.next.open", {
                  name: t(`bible.tabs.${section}`),
                })}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="bible-backfill__actions">
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={onStartAgain}
        >
          <Sparkles size={12} aria-hidden="true" />
          {pending ? t("bible.backfill.starting") : t("bible.backfill.startAgain")}
        </button>
      </div>
      {items.length > 0 ? (
        <ItemList items={items} current={null} collapsed onReread={onReread} />
      ) : null}
    </div>
  );
}

/* ---- Chapter list ------------------------------------------------------- */

function ItemList({
  items,
  current,
  collapsed = false,
  onReread,
}: {
  items: BibleBackfillItemDto[];
  current: BibleBackfillItemDto | null;
  collapsed?: boolean;
  onReread?: (item: BibleBackfillItemDto, title: string) => void;
}) {
  const { t } = useI18n();
  const list = (
    <ol className="bible-backfill__items" aria-label={t("bible.backfill.progress.listLabel")}>
      {items.map((item, index) => {
        const title =
          item.title ?? t("bible.backfill.progress.untitled", { number: index + 1 });
        const status = itemStatusLabel(item, t);
        return (
          <li
            key={item.ordinal}
            data-status={item.status}
            aria-current={item === current ? "step" : undefined}
          >
            <ItemStatusIcon status={item.status} />
            <span className="bible-backfill__item-title">{title}</span>
            <span className="bible-backfill__item-status">{status}</span>
            {onReread && REREADABLE_ITEM_STATUSES.has(item.status) ? (
              <button
                type="button"
                className="btn bible-backfill__item-action"
                aria-label={t("bible.backfill.reread.actionLabel", { title })}
                onClick={() => onReread(item, title)}
              >
                <RotateCcw size={11} aria-hidden="true" />
                {t("bible.backfill.reread.action")}
              </button>
            ) : null}
            <ItemNote item={item} />
          </li>
        );
      })}
    </ol>
  );
  if (!collapsed) return list;
  return (
    <details className="bible-backfill__items-details">
      <summary>
        {t("bible.backfill.progress.listLabel")} · {items.length}
      </summary>
      {list}
    </details>
  );
}

/**
 * What happened to an item (retargeted to a new version, reused an existing
 * settlement, detached on cancel), one sentence each.
 */
function ItemNote({ item }: { item: BibleBackfillItemDto }) {
  const { t } = useI18n();
  const lines = itemNoteKeys(item).map((key) => t(key));
  if (lines.length === 0) return null;
  return <span className="bible-backfill__item-note">{lines.join(" ")}</span>;
}

function itemNoteKeys(item: BibleBackfillItemDto): MessageKey[] {
  const note = item.note;
  if (!note) return [];
  const keys: MessageKey[] = [];
  if (note.reread === true) keys.push("bible.backfill.itemNote.reread");
  if (
    typeof note.retargetedFromVersionId === "string" &&
    (note.code === "bible_backfill.item.retargeted" ||
      note.code === "bible_backfill.item.adopted")
  ) {
    keys.push("bible.backfill.itemNote.retargeted");
    if (typeof note.supersededChangeSetId === "string")
      keys.push("bible.backfill.itemNote.supersededChangeSet");
    if (note.supersededRunAction === "detached")
      keys.push("bible.backfill.itemNote.supersededRunDetached");
  }
  if (note.code === "bible_backfill.item.adopted") {
    const adopted: Record<string, MessageKey> = {
      in_progress: "bible.backfill.itemNote.adoptedInProgress",
      candidate: "bible.backfill.itemNote.adoptedCandidate",
      applied: "bible.backfill.itemNote.adoptedApplied",
      empty: "bible.backfill.itemNote.adoptedEmpty",
    };
    const key =
      typeof note.adoptedOutcome === "string" ? adopted[note.adoptedOutcome] : undefined;
    if (key) keys.push(key);
  }
  if (note.code === "bible_backfill.item.detached")
    keys.push("bible.backfill.itemNote.detached");
  if (note.code === "bible_backfill.item.handed_back")
    keys.push("bible.backfill.itemNote.handedBack");
  return keys;
}

function ItemStatusIcon({ status }: { status: BibleBackfillItemDto["status"] }) {
  const props = { size: 12, "aria-hidden": true } as const;
  switch (status) {
    case "settling":
      return <LoaderCircle className="bible-backfill__spin" {...props} />;
    case "awaiting_decision":
      return <CircleDot {...props} />;
    case "applied":
      return <CircleCheck {...props} />;
    case "failed":
      return <CircleX {...props} />;
    case "rejected":
    case "empty":
    case "skipped":
      return <CircleMinus {...props} />;
    default:
      return <CircleDashed {...props} />;
  }
}

function itemStatusLabel(
  item: BibleBackfillItemDto,
  t: (key: MessageKey) => string,
): string {
  if (item.status === "skipped" && item.skipReason === "already_settled")
    return t("bible.backfill.itemStatus.alreadySettled");
  const keys: Record<BibleBackfillItemDto["status"], MessageKey> = {
    pending: "bible.backfill.itemStatus.pending",
    settling: "bible.backfill.itemStatus.settling",
    awaiting_decision: "bible.backfill.itemStatus.awaitingDecision",
    applied: "bible.backfill.itemStatus.applied",
    rejected: "bible.backfill.itemStatus.rejected",
    empty: "bible.backfill.itemStatus.empty",
    failed: "bible.backfill.itemStatus.failed",
    skipped: "bible.backfill.itemStatus.skipped",
  };
  return t(keys[item.status]);
}

/* ---- Utilities ---------------------------------------------------------- */

/**
 * Chapters still pending decision in a finished job, recorded as accepted or
 * rejected according to the change set's current state.
 */
function withStudioDecisions(
  items: BibleBackfillItemDto[],
  counts: BibleBackfillDetailDto["counts"],
  changeSets: ReadonlyArray<{ id: string; status: string }> | undefined,
): { items: BibleBackfillItemDto[]; counts: BibleBackfillDetailDto["counts"] } {
  if (!changeSets) return { items, counts };
  const statusById = new Map(changeSets.map((set) => [set.id, set.status]));
  let applied = 0;
  let rejected = 0;
  const decided = items.map((item): BibleBackfillItemDto => {
    if (item.status !== "awaiting_decision" || !item.changeSetId) return item;
    const status = statusById.get(item.changeSetId);
    if (status === "applied" || status === "partially_applied") {
      applied += 1;
      return { ...item, status: "applied" };
    }
    if (status === "rejected") {
      rejected += 1;
      return { ...item, status: "rejected" };
    }
    return item;
  });
  if (applied + rejected === 0) return { items, counts };
  return {
    items: decided,
    counts: {
      ...counts,
      applied: counts.applied + applied,
      rejected: counts.rejected + rejected,
      awaitingDecision: counts.awaitingDecision - applied - rejected,
    },
  };
}

function toDetail(value: BibleBackfillCreatedDto): BibleBackfillDetailDto {
  return {
    job: value.job,
    items: value.items,
    counts: value.counts,
    usage: value.usage,
    availableActions: value.availableActions,
    unanchoredImportedEvents: value.unanchoredImportedEvents,
  };
}

function currentItem(
  job: BibleBackfillJobDto,
  items: BibleBackfillItemDto[],
): BibleBackfillItemDto | null {
  return (
    items.find((item) => item.ordinal === job.currentOrdinal) ??
    items.find((item) =>
      ["settling", "awaiting_decision", "failed"].includes(item.status),
    ) ??
    null
  );
}

type BackfillError = NonNullable<BibleBackfillJobDto["error"]>;

/**
 * The extra fields of a stop reason may sit flat on error or inside
 * error.details.
 */
function errorPayload(error: BackfillError): Record<string, unknown> {
  const details = error.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? { ...error, ...(details as Record<string, unknown>) }
    : error;
}

function stringField(error: BackfillError | null, key: string): string | null {
  if (!error) return null;
  const value = errorPayload(error)[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * Stop reason code written by the coordinator to job.error → panel text; detail
 * means the raw server explanation is attached.
 */
const STOP_REASONS: Record<string, { key: MessageKey; detail?: true }> = {
  "child.awaiting_user": { key: "bible.backfill.stopReason.childAwaitingUser" },
  "child.failed": { key: "bible.backfill.stopReason.childFailed", detail: true },
  "child.fatal": { key: "bible.backfill.stopReason.childFatal", detail: true },
  "run.cancelled": { key: "bible.backfill.stopReason.runCancelled" },
  "bible_backfill.chapter.changed": { key: "bible.backfill.stopReason.chapterChanged" },
  "bible_backfill.run.missing": { key: "bible.backfill.stopReason.runMissing" },
  "bible_backfill.unexpected": { key: "bible.backfill.stopReason.unexpected", detail: true },
  "bible_backfill.cancelled": { key: "bible.backfill.stopReason.cancelled" },
  "bible_backfill.review_required": { key: "bible.backfill.stopReason.reviewRequired" },
  "settlement.anchor.missing": { key: "bible.backfill.stopReason.anchorMissing" },
  "canon_change_set.not_found": { key: "bible.backfill.stopReason.changeSetMissing" },
  "document.version.not_found": { key: "bible.backfill.stopReason.versionMissing" },
};

/**
 * Existing records this chapter would change, listed by a review_required stop.
 */
interface ReviewTarget {
  path: string;
  action: "withdraw" | "supersede" | "update" | "end" | "anchor" | "develop" | "resolve";
  label: string | null;
  /**
   * The foreshadowing was resolved or abandoned; this chapter would reopen it.
   */
  reopens: boolean;
}

const REVIEW_ACTIONS: Record<ReviewTarget["action"], MessageKey> = {
  withdraw: "bible.backfill.attention.reviewAction.withdraw",
  supersede: "bible.backfill.attention.reviewAction.supersede",
  update: "bible.backfill.attention.reviewAction.update",
  end: "bible.backfill.attention.reviewAction.end",
  anchor: "bible.backfill.attention.reviewAction.anchor",
  develop: "bible.backfill.attention.reviewAction.develop",
  resolve: "bible.backfill.attention.reviewAction.resolve",
};

function reviewActionKey(target: ReviewTarget): MessageKey {
  return target.action === "develop" && target.reopens
    ? "bible.backfill.attention.reviewAction.reopen"
    : REVIEW_ACTIONS[target.action];
}

function reviewTargets(error: BackfillError): ReviewTarget[] {
  const targets = errorPayload(error).targets;
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((target, index): ReviewTarget[] => {
    if (!target || typeof target !== "object") return [];
    const record = target as Record<string, unknown>;
    const action = record.action;
    if (typeof action !== "string" || !(action in REVIEW_ACTIONS)) return [];
    return [
      {
        path: typeof record.path === "string" ? record.path : String(index),
        action: action as ReviewTarget["action"],
        label: typeof record.label === "string" && record.label ? record.label : null,
        reopens: record.reopens === true,
      },
    ];
  });
}

interface StopReason {
  message: string;
  /**
   * Raw server explanation (usually English), shown only as secondary detail.
   */
  detail: string | null;
  /** Unrecognized reason code, shown only as secondary detail. */
  code: string | null;
}

function stopReason(
  error: BackfillError,
  t: (key: MessageKey) => string,
): StopReason {
  const raw =
    typeof error.message === "string" && error.message.trim()
      ? error.message
      : null;
  const known = STOP_REASONS[error.code];
  if (known) {
    return { message: t(known.key), detail: known.detail ? raw : null, code: null };
  }
  const translated = knownApiErrorMessage(error.code);
  if (translated) {
    return { message: translated, detail: raw !== translated ? raw : null, code: null };
  }
  return { message: t("bible.backfill.stopReason.unknown"), detail: raw, code: error.code };
}

function StopReasonText({ reason }: { reason: StopReason }) {
  const { t } = useI18n();
  return (
    <>
      <p className="bible-backfill__error-text">{reason.message}</p>
      {reason.detail ? (
        <p className="bible-backfill__detail">
          {t("bible.backfill.attention.detail", { message: reason.detail })}
        </p>
      ) : null}
      {reason.code ? (
        <p className="bible-backfill__detail mono">
          {t("bible.backfill.attention.code", { code: reason.code })}
        </p>
      ) : null}
    </>
  );
}

/**
 * Usage recorded by the child run; the cost is shown only when pricing produced
 * a non-zero cost.
 */
function UsageLine({
  usage,
  final = false,
}: {
  usage: BibleBackfillUsageDto;
  final?: boolean;
}) {
  const { locale, t } = useI18n();
  const values = {
    calls: formatCount(usage.calls, locale),
    tokens: formatCount(usage.inputTokens + usage.outputTokens, locale),
  };
  const text =
    usage.costUsd !== null
      ? t(
          final
            ? "bible.backfill.usage.totalWithCost"
            : "bible.backfill.usage.soFarWithCost",
          { ...values, cost: formatUsd(usage.costUsd, locale) },
        )
      : t(final ? "bible.backfill.usage.total" : "bible.backfill.usage.soFar", values);
  return (
    <div className="bible-backfill__usage">
      <p className="mono">{text}</p>
      {usage.costUsd === null ? (
        <p className="bible-backfill__detail">{t("bible.backfill.usage.pricingHint")}</p>
      ) : null}
    </div>
  );
}

function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
}
