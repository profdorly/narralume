import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  BookOpen,
  Check,
  LibraryBig,
  MessageSquarePlus,
  Plus,
  Save,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { publishAssistantContext } from "../../app/assistant-page-context";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { Empty } from "../../components/empty";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { getLocale, translate, useI18n, type MessageKey } from "../../i18n";
import {
  createChapterRun,
  createDocumentReview,
  decideReviewIssue,
  decideRevisionProposal,
  getCanonChangeSets,
  getProjectRuns,
  getReviewWorkspace,
  getStoryBible,
  type DocumentComment,
  type DocumentVersion,
  type EditProposal,
  type ReviewRevisionProposal,
  type ReviewWorkspace,
  type ReviewWorkspaceIssue,
  type ReviewWorkspaceReport,
  type StoryDocument,
  type StudioDocumentDetail,
} from "../../lib/api";
import { projectWorkspacePath } from "../../lib/project-route";
import {
  reviewCategoryLabel,
  reviewIssueActionLabel,
  reviewIssueStatusLabel,
  reviewVerdictLabel,
} from "../../lib/labels";
import { rememberTask } from "../../lib/task-ledger";
import { CanonChangeSetReview } from "../shared/canon-change-review";
import { ManuscriptEditor } from "./manuscript-editor";
import { WritingTaskPanel } from "./task-panel";
import { ChapterCompanion } from "./chapter-companion";
import { useChapterDraft, type FlushDraft } from "./use-chapter-draft";
import { useSelection } from "./use-selection";
import { useVersions } from "./use-versions";

type StudioTool =
  | "companion"
  | "review"
  | "revisions"
  | "canon"
  | "comments"
  | "versions"
  | "selection";

const STUDIO_TOOLS: Array<{ id: StudioTool; labelKey: MessageKey }> = [
  { id: "companion", labelKey: "studio.tools.companion" },
  { id: "review", labelKey: "studio.tools.review" },
  { id: "revisions", labelKey: "studio.tools.revisions" },
  { id: "canon", labelKey: "studio.tools.canon" },
  { id: "comments", labelKey: "studio.tools.comments" },
  { id: "versions", labelKey: "studio.tools.versions" },
  { id: "selection", labelKey: "studio.tools.selection" },
];

function studioToolFromFocus(value: string | null): StudioTool {
  if (value === "companion") return "companion";
  if (value === "canon") return "canon";
  if (value === "revisions") return "revisions";
  if (value === "comments") return "comments";
  if (value === "versions") return "versions";
  if (value === "selection") return "selection";
  return "review";
}

export function StudioDesk({
  projectId,
  detail,
  pending,
  error,
  review,
  reviewPending,
  reviewError,
  focusTarget,
  focusMode,
  runId,
  onRunChange,
  onDismissRun,
  onCreateDocument,
  onArchive,
  onRefresh,
  onFlushReady,
}: {
  projectId: string;
  detail: StudioDocumentDetail | undefined;
  pending: boolean;
  error: unknown;
  review: ReviewWorkspace | undefined;
  reviewPending: boolean;
  reviewError: unknown;
  focusTarget: string | null;
  focusMode: boolean;
  runId: string | null;
  onRunChange: (runId: string) => void;
  onDismissRun: () => void;
  onCreateDocument: () => void;
  onArchive: (document: StoryDocument) => void | Promise<void>;
  onRefresh: () => void;
  onFlushReady: (flush: FlushDraft | null) => void;
}) {
  const { t } = useI18n();
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [counts, setCounts] = useState({ words: 0, characters: 0 });
  const [toolSelection, setToolSelection] = useState(() => ({
    focusTarget,
    tool: studioToolFromFocus(focusTarget),
  }));
  const openedCompanionFor = useRef<string | null>(null);
  useEffect(() => {
    const open = detail?.document;
    if (!open || focusTarget) return;
    if (open.kind !== "chapter" || !open.outlineNodeId) return;
    if (openedCompanionFor.current === open.id) return;
    openedCompanionFor.current = open.id;
    setToolSelection({ focusTarget, tool: "companion" });
  }, [detail, focusTarget]);
  const activeTool =
    toolSelection.focusTarget === focusTarget
      ? toolSelection.tool
      : studioToolFromFocus(focusTarget);
  const aiRequestRef = useRef<{ identity: string; requestId: string } | null>(
    null,
  );
  const queryClient = useQueryClient();
  const draft = useChapterDraft({ projectId, detail, onFlushReady });
  const versions = useVersions({
    projectId,
    detail,
    content: draft.content,
    setDraftSavedContent: draft.setDraftSavedContent,
    savedContentRef: draft.savedContentRef,
    latestDraftRef: draft.latestDraftRef,
    saveQueueRef: draft.saveQueueRef,
    cancelScheduledAutosave: draft.cancelScheduledAutosave,
    onRefresh,
  });
  const selection = useSelection({
    projectId,
    detail,
    content: draft.content,
    setDraftSavedContent: draft.setDraftSavedContent,
    savedContentRef: draft.savedContentRef,
    latestDraftRef: draft.latestDraftRef,
    saveQueueRef: draft.saveQueueRef,
    persistDraft: draft.persistDraft,
    cancelScheduledAutosave: draft.cancelScheduledAutosave,
    onRefresh,
  });

  useEffect(() => {
    const selected =
      selection.selection.end > selection.selection.start
        ? draft.content
            .slice(selection.selection.start, selection.selection.end)
            .slice(0, 40_000)
        : null;
    publishAssistantContext({
      documentId: detail?.document.id ?? null,
      outlineNodeId: detail?.document.outlineNodeId ?? null,
      selection: selected
        ? {
            start: selection.selection.start,
            end: selection.selection.end,
            text: selected,
          }
        : null,
    });
  }, [
    draft.content,
    detail?.document.id,
    detail?.document.outlineNodeId,
    selection.selection,
  ]);

  const aiMutation = useMutation({
    mutationFn: () => {
      const input = {
        targetOutlineNodeId: detail!.document.outlineNodeId!,
        planningMode: "auto" as const,
        origin: {
          surface: "writing" as const,
          documentId: detail!.document.id,
        },
        maxRevisionCycles: 2,
      };
      const identity = JSON.stringify(input);
      if (aiRequestRef.current?.identity !== identity) {
        aiRequestRef.current = {
          identity,
          requestId: crypto.randomUUID(),
        };
      }
      return createChapterRun(projectId, {
        ...input,
        requestId: aiRequestRef.current.requestId,
      });
    },
    onSuccess: (created) => {
      aiRequestRef.current = null;
      rememberTask({
        projectId,
        kind: "chapter",
        taskId: created.run.id,
        label: t("studio.ai.taskLabel", { name: detail!.document.title }),
        createdAt: new Date().toISOString(),
        origin: { surface: "writing", documentId: detail!.document.id },
        documentId: detail!.document.id,
      });
      onRunChange(created.run.id);
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "runs"],
      });
    },
  });

  if (pending)
    return (
      <main className="studio__desk">
        <Skeleton lines={8} />
      </main>
    );
  if (error)
    return (
      <main className="studio__desk">
        <ErrorNote error={error} title={t("studio.errors.detailLoad")} />
      </main>
    );
  if (!detail)
    return (
      <main className="studio__desk studio__desk--empty">
        <Empty
          title={t("studio.empty.title")}
          description={t("studio.empty.description")}
          action={
            <div className="studio__empty-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={onCreateDocument}
              >
                <Plus size={13} />
                {t("studio.empty.create")}
              </button>
              <Link to={projectWorkspacePath(projectId, "bible")}>
                {t("studio.empty.planLink")}
              </Link>
            </div>
          }
        />
      </main>
    );

  const hasSelection = selection.selection.end > selection.selection.start;
  const selectionNeedsCheckpoint =
    detail.currentVersion?.content !== draft.content;
  const aiReady =
    detail.document.kind === "chapter" &&
    detail.document.outlineNodeId !== null;
  const anyError =
    versions.versionMutation.error ??
    draft.draftMutation.error ??
    selection.commentMutation.error ??
    selection.editMutation.error ??
    selection.proposalMutation.error ??
    selection.statusMutation.error ??
    aiMutation.error;
  const activeToolLabel = t(
    STUDIO_TOOLS.find((tool) => tool.id === activeTool)?.labelKey ??
      "studio.tools.fallback",
  );
  const toolCount = (tool: StudioTool): number | null => {
    if (tool === "comments") return detail.comments.length;
    if (tool === "versions") return detail.versions.length;
    if (tool === "selection") return detail.proposals.length;
    return null;
  };
  const saveLabel =
    draft.saveState === "saved"
      ? t("studio.desk.draftSynced")
      : draft.saveState === "saving"
        ? t("studio.desk.draftSyncing")
        : t("studio.desk.draftUnsynced");
  const proposalRanges = detail.proposals
    .filter((proposal) => proposal.status === "proposed")
    .map((proposal) => ({
      id: proposal.id,
      from: proposal.selectionStart,
      to: proposal.selectionEnd,
    }));

  return (
    <>
      <main className="studio__desk">
        <header className="studio__desk-head">
          <p className="studio__desk-title">{detail.document.title}</p>
          <span className="studio__desk-tag">
            {t("studio.desk.versionCount", { count: detail.versions.length })}
          </span>
          <span
            className="save-state studio__desk-meta"
            data-state={draft.saveState}
          >
            {saveLabel}
          </span>
          <button
            type="button"
            className="studio__text-button"
            onClick={() => setArchiveOpen(true)}
          >
            <Archive size={12} />
            {t("studio.desk.archive")}
          </button>
        </header>
        {runId ? (
          <WritingTaskPanel
            projectId={projectId}
            runId={runId}
            onRunChange={onRunChange}
            onDismiss={onDismissRun}
            onAccepted={() => {
              setTaskNotice(t("studio.task.acceptedNotice"));
              onDismissRun();
            }}
            onRefreshDocument={onRefresh}
          />
        ) : null}
        {taskNotice ? (
          <p className="studio__task-accepted" role="status">
            <Check size={13} aria-hidden="true" />
            {taskNotice}
            <button
              type="button"
              aria-label={t("studio.task.dismissNoticeAria")}
              onClick={() => setTaskNotice(null)}
            >
              ×
            </button>
          </p>
        ) : null}
        <div className="studio__desk-editor">
          {draft.content.length === 0 ? (
            <div className="studio__blank-page-note">
              <span className="mono">{t("studio.desk.blankTagline")}</span>
              <strong>{t("studio.desk.blankHeading")}</strong>
              <p>
                {aiReady
                  ? t("studio.desk.blankHintAi")
                  : t("studio.desk.blankHintPlain")}
              </p>
            </div>
          ) : null}
          <ManuscriptEditor
            className="studio__desk-textarea"
            ariaLabel={t("studio.desk.editorAria")}
            value={draft.content}
            placeholder={t("studio.desk.editorPlaceholder")}
            focusMode={focusMode}
            proposalRanges={proposalRanges}
            onChange={draft.updateContent}
            onSelect={selection.setSelection}
            onCounts={setCounts}
          />
          {anyError ? (
            <ErrorNote
              error={anyError}
              title={t("studio.desk.operationErrorTitle")}
            />
          ) : null}
          {versions.versionMutation.isSuccess ? (
            <p className="studio__saved-note" role="status">
              {t("studio.desk.versionSaved")}
            </p>
          ) : null}
          <div className="studio__desk-foot">
            <span
              className="studio__desk-stat"
              data-word-count={counts.words}
              data-character-count={counts.characters}
            >
              {t("studio.desk.stats", {
                count: counts.characters,
                selected:
                  selection.selection.end - selection.selection.start,
              })}
            </span>
            <div className="studio__desk-actions">
              {aiReady ? (
                <>
                  <button
                    type="button"
                    className="studio__save-btn studio__save-btn--ai"
                    disabled={aiMutation.isPending}
                    title={t("studio.ai.buttonTitle")}
                    onClick={() => aiMutation.mutate()}
                  >
                    <Sparkles size={13} />
                    {aiMutation.isPending
                      ? t("studio.ai.submitting")
                      : t("studio.ai.button")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setToolSelection({ focusTarget, tool: "selection" })
                    }
                  >
                    {t("studio.companion.rewrite")}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setToolSelection({ focusTarget, tool: "companion" })
                    }
                  >
                    {t("studio.tools.companion")}
                  </button>
                </>
              ) : detail.document.kind === "manuscript" ? (
                <span className="studio__desk-hint">
                  {t("studio.hint.manuscriptPrefix")}
                  <Link to={projectWorkspacePath(projectId, "bible")}>
                    {t("studio.hint.manuscriptLinkChapters")}
                  </Link>
                  {t("studio.hint.manuscriptMiddle")}
                  <Link to={projectWorkspacePath(projectId, "autopilot")}>
                    {t("studio.hint.manuscriptLinkAutopilot")}
                  </Link>
                </span>
              ) : detail.document.kind === "scene" ? (
                <span className="studio__desk-hint">
                  {t("studio.hint.scene")}
                </span>
              ) : (
                <span className="studio__desk-hint">
                  {t("studio.hint.unboundPrefix")}
                  <Link to={projectWorkspacePath(projectId, "bible")}>
                    {t("studio.hint.unboundLink")}
                  </Link>
                </span>
              )}
              <button
                type="button"
                className="studio__save-btn"
                disabled={
                  versions.versionMutation.isPending || !draft.content.trim()
                }
                onClick={() => versions.versionMutation.mutate()}
              >
                <Save size={13} />
                {versions.versionMutation.isPending
                  ? t("studio.desk.savingVersion")
                  : t("studio.desk.saveVersion")}
              </button>
            </div>
          </div>
        </div>
      </main>
      <aside className="studio__side" aria-label={t("studio.tools.dockAria")}>
        <nav
          className="studio__tool-nav"
          role="tablist"
          aria-label={t("studio.tools.navAria")}
        >
          {STUDIO_TOOLS.map((tool) => {
            const count = toolCount(tool.id);
            return (
              <button
                key={tool.id}
                type="button"
                role="tab"
                aria-selected={activeTool === tool.id}
                aria-controls="studio-tool-panel"
                onClick={() =>
                  setToolSelection({ focusTarget, tool: tool.id })
                }
              >
                <StudioToolIcon tool={tool.id} />
                <span>{t(tool.labelKey)}</span>
                {count !== null ? <small>{count}</small> : null}
              </button>
            );
          })}
        </nav>
        <section
          className="studio__tool-panel"
          id="studio-tool-panel"
          role="tabpanel"
          aria-label={t("studio.tools.panelAria", { label: activeToolLabel })}
        >
          {activeTool === "companion" ? (
            <ChapterCompanion
              projectId={projectId}
              document={detail.document}
              prose={draft.content}
              review={review}
              onOpenSelection={() =>
                setToolSelection({ focusTarget, tool: "selection" })
              }
              onOpenChanges={() =>
                setToolSelection({ focusTarget, tool: "canon" })
              }
            />
          ) : null}
          {activeTool === "review" ? (
            <ReviewPanel
              projectId={projectId}
              document={detail.document}
              workspace={review}
              pending={reviewPending}
              error={reviewError}
            />
          ) : null}
          {activeTool === "revisions" ? (
            <RevisionProposalPanel
              projectId={projectId}
              activeDocumentId={detail.document.id}
            />
          ) : null}
          {activeTool === "canon" ? (
            <CanonChangesPanel
              projectId={projectId}
              document={detail.document}
              versions={detail.versions}
            />
          ) : null}
          {activeTool === "comments" ? (
            <CommentPanel
              comments={detail.comments}
              pending={selection.statusMutation.isPending}
              onToggle={(comment) => selection.statusMutation.mutate(comment)}
            />
          ) : null}
          {activeTool === "versions" ? (
            <VersionPanel
              versions={detail.versions}
              currentVersionId={detail.document.currentVersionId}
              pending={versions.restoreMutation.isPending}
              onRestore={versions.setRestoreTarget}
            />
          ) : null}
          {activeTool === "selection" ? (
            <>
              <section
                className="studio__selection-tools"
                aria-label={t("studio.selection.aria")}
              >
                <h3>{t("studio.selection.title")}</h3>
                <blockquote>
                  {hasSelection
                    ? draft.content.slice(
                        selection.selection.start,
                        selection.selection.end,
                      )
                    : t("studio.selection.emptyQuote")}
                </blockquote>
                <div className="studio__selection-grid">
                  <div className="studio__selection-cell">
                    <label>
                      {t("studio.selection.commentLabel")}
                      <textarea
                        value={selection.commentBody}
                        onChange={(event) =>
                          selection.setCommentBody(event.target.value)
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="btn"
                      disabled={
                        !hasSelection ||
                        !selection.commentBody.trim() ||
                        selection.commentMutation.isPending
                      }
                      onClick={() => selection.commentMutation.mutate()}
                    >
                      <MessageSquarePlus size={12} />
                      {selectionNeedsCheckpoint
                        ? t("studio.selection.commentCheckpoint")
                        : t("studio.selection.commentCreate")}
                    </button>
                  </div>
                  <div className="studio__selection-cell">
                    <label>
                      {t("studio.selection.editLabel")}
                      <textarea
                        value={selection.editInstruction}
                        onChange={(event) =>
                          selection.setEditInstruction(event.target.value)
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={
                        !hasSelection ||
                        !selection.editInstruction.trim() ||
                        selection.editMutation.isPending
                      }
                      onClick={() => selection.editMutation.mutate()}
                    >
                      <Sparkles size={12} />
                      {selection.editMutation.isPending
                        ? t("studio.selection.editPending")
                        : t("studio.selection.editSubmit")}
                    </button>
                    {selection.editMutation.data ? (
                      <p className="studio__saved-note" role="status">
                        {t("studio.selection.editStarted")}{" "}
                        <Link
                          to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(selection.editMutation.data.run.id)}`}
                        >
                          {t("studio.selection.editProgressLink")}
                        </Link>
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>
              <ProposalPanel
                proposals={detail.proposals}
                pending={selection.proposalMutation.isPending}
                onDecide={(proposal, action) =>
                  selection.proposalMutation.mutate({ proposal, action })
                }
              />
            </>
          ) : null}
        </section>
      </aside>
      {versions.restoreTarget ? (
        <ConfirmDialog
          title={t("studio.confirm.restoreTitle")}
          confirmLabel={t("studio.confirm.restoreLabel")}
          pending={versions.restoreMutation.isPending}
          onCancel={() => versions.setRestoreTarget(null)}
          onConfirm={() =>
            versions.restoreMutation.mutate(versions.restoreTarget!)
          }
        >
          <p>{t("studio.confirm.restoreBody")}</p>
          {versions.restoreMutation.isError ? (
            <ErrorNote
              error={versions.restoreMutation.error}
              title={t("studio.errors.restoreVersionFailed")}
            />
          ) : null}
        </ConfirmDialog>
      ) : null}
      {archiveOpen ? (
        <ConfirmDialog
          title={t("studio.desk.archive")}
          confirmLabel={t("studio.desk.archive")}
          danger
          onCancel={() => setArchiveOpen(false)}
          onConfirm={() => {
            setArchiveOpen(false);
            if (detail) void onArchive(detail.document);
          }}
        >
          <p>{t("studio.confirm.archiveBody")}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function StudioToolIcon({ tool }: { tool: StudioTool }) {
  const props = { size: 15, strokeWidth: 1.6, "aria-hidden": true } as const;
  switch (tool) {
    case "companion":
      return <LibraryBig {...props} />;
    case "review":
      return <Check {...props} />;
    case "revisions":
      return <Undo2 {...props} />;
    case "canon":
      return <BookOpen {...props} />;
    case "comments":
      return <MessageSquarePlus {...props} />;
    case "versions":
      return <Save {...props} />;
    case "selection":
      return <Sparkles {...props} />;
  }
}

function ReviewPanel({
  projectId,
  document,
  workspace,
  pending,
  error,
}: {
  projectId: string;
  document: StoryDocument;
  workspace: ReviewWorkspace | undefined;
  pending: boolean;
  error: unknown;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [flash, setFlash] = useState<string | null>(null);
  const reviewRequestRef = useRef<{
    versionId: string;
    requestId: string;
  } | null>(null);
  const decideMutation = useMutation({
    mutationFn: (input: {
      issue: ReviewWorkspaceIssue;
      action: "accept" | "reject" | "false_positive" | "intentional_keep";
    }) =>
      decideReviewIssue(projectId, input.issue.id, {
        action: input.action,
        note: null,
        expectedStatus: input.issue.status,
      }),
    onSuccess: (_data, input) => {
      setFlash(
        t("studio.review.decisionFlash", {
          action: reviewIssueActionLabel(input.action),
        }),
      );
      window.setTimeout(() => setFlash(null), 2200);
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "review"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "studio"],
      });
    },
  });
  const reviewMutation = useMutation({
    mutationFn: () => {
      if (!document.currentVersionId) {
        throw new Error(t("studio.review.errorNoVersion"));
      }
      if (reviewRequestRef.current?.versionId !== document.currentVersionId) {
        reviewRequestRef.current = {
          versionId: document.currentVersionId,
          requestId: crypto.randomUUID(),
        };
      }
      return createDocumentReview(projectId, document.id, {
        requestId: reviewRequestRef.current.requestId,
        documentVersionId: document.currentVersionId,
        origin: { surface: "writing", documentId: document.id },
      });
    },
    onSuccess: (created) => {
      reviewRequestRef.current = null;
      setFlash(t("studio.review.submittedFlash"));
      rememberTask({
        projectId,
        kind: "chapter",
        taskId: created.run.id,
        label: t("studio.task.reviewTaskLabel", { name: document.title }),
        createdAt: new Date().toISOString(),
        origin: { surface: "writing", documentId: document.id },
        documentId: document.id,
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "runs"],
      });
    },
  });
  const reports = (workspace?.reports ?? [])
    .filter((report) => report.documentId === document.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const currentReports = reports.filter(
    (report) => report.documentVersionId === document.currentVersionId,
  );
  const latest: ReviewWorkspaceReport | null = currentReports[0] ?? null;
  if (error)
    return (
      <Panel title={t("studio.tools.review")} count={0}>
        <ErrorNote error={error} title={t("studio.errors.reviewLoad")} />
      </Panel>
    );
  if (pending)
    return (
      <Panel title={t("studio.tools.review")} count={0}>
        <Skeleton lines={3} />
      </Panel>
    );
  const canReview =
    document.kind === "chapter" &&
    document.outlineNodeId !== null &&
    document.currentVersionId !== null;
  const visibleReports = reports.filter(
    (report) =>
      report.id === latest?.id ||
      report.issues.some((issue) => issue.status === "open"),
  );
  const openCount = visibleReports
    .flatMap((report) => report.issues)
    .filter((issue) => issue.status === "open").length;
  return (
    <Panel title={t("studio.tools.review")} count={openCount}>
      <div className="studio__review-command">
        <p className="studio__section-intro">
          {latest
            ? t("studio.review.introCurrent")
            : document.kind === "manuscript"
              ? t("studio.review.introManuscript")
              : t("studio.review.introNone")}
        </p>
        {canReview ? (
          <button
            type="button"
            className="btn"
            disabled={reviewMutation.isPending}
            onClick={() => reviewMutation.mutate()}
          >
            <Check size={12} aria-hidden="true" />
            {reviewMutation.isPending
              ? t("studio.review.submitting")
              : latest
                ? t("studio.review.rereview")
                : t("studio.review.reviewCurrent")}
          </button>
        ) : null}
      </div>
      {reviewMutation.isError ? (
        <ErrorNote
          error={reviewMutation.error}
          title={t("studio.errors.reviewSubmitFailed")}
        />
      ) : null}
      {!latest && visibleReports.length > 0 ? (
        <p className="studio__review-stale">{t("studio.review.staleNote")}</p>
      ) : null}
      {!latest && visibleReports.length === 0 ? (
        <p className="studio__panel-empty">{t("studio.review.emptyNote")}</p>
      ) : null}
      {visibleReports.map((report, index) => {
        const reportOpenIssues = report.issues.filter(
          (issue) => issue.status === "open",
        );
        return (
          <details
            key={report.id}
            className="studio__review-report"
            open={index === 0 || reportOpenIssues.length > 0}
          >
            <summary>
              <strong>
                {report.id === latest?.id
                  ? t("studio.review.reportCurrent")
                  : t("studio.review.reportPast")}
              </strong>
              <span>
                {t("studio.review.reportMeta", {
                  verdict: reviewVerdictLabel(report.verdict),
                  count: reportOpenIssues.length,
                  time: report.createdAt.slice(0, 16),
                })}
              </span>
            </summary>
            <div className="studio__review-report-body">
              <div
                className="review__report"
                aria-label={t("studio.review.reportAria")}
              >
                <div className="review__report-head">
                  <p className="review__report-verdict" data-v={report.verdict}>
                    {reviewVerdictLabel(report.verdict)}
                  </p>
                  <p className="review__report-summary">{report.summary}</p>
                </div>
                <div
                  className="review__report-scores"
                  aria-label={t("studio.review.scoresAria")}
                >
                  {Object.entries(report.scores).map(([key, value]) => (
                    <span key={key}>
                      {reviewScoreLabel(key)} · {value}
                    </span>
                  ))}
                </div>
              </div>
              {report.reviewedContent ? (
                <details className="studio__reviewed-copy">
                  <summary>
                    {t("studio.review.reviewedCopySummary", {
                      count: report.reviewedContent.length,
                    })}
                  </summary>
                  <div
                    className="review__doc-body review__doc-body--desk"
                    aria-label={t("studio.review.reviewedCopyAria")}
                  >
                    {markQuotes(
                      report.reviewedContent,
                      report.issues
                        .flatMap((issue) =>
                          issue.evidence.map((entry) => entry.quote),
                        )
                        .filter(Boolean),
                    )}
                  </div>
                </details>
              ) : null}
              {report.issues.length === 0 ? (
                <div className="review__empty">
                  <strong>{t("studio.review.cleanTitle")}</strong>
                  {t("studio.review.cleanBody")}
                </div>
              ) : (
                <div className="review__issues">
                  {report.issues.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      pending={decideMutation.isPending}
                      onDecide={(action) =>
                        decideMutation.mutate({ issue, action })
                      }
                    />
                  ))}
                </div>
              )}
              {reportOpenIssues.length === 0 && report.issues.length > 0 ? (
                <p className="studio__panel-empty">
                  {t("studio.review.allDecided", {
                    count: report.issues.length,
                  })}
                </p>
              ) : null}
            </div>
          </details>
        );
      })}
      {flash ? (
        <p className="review__flash" role="status">
          <Check size={13} aria-hidden="true" />
          {flash}
        </p>
      ) : null}
    </Panel>
  );
}

function IssueCard({
  issue,
  pending,
  onDecide,
}: {
  issue: ReviewWorkspaceIssue;
  pending: boolean;
  onDecide: (
    action: "accept" | "reject" | "false_positive" | "intentional_keep",
  ) => void;
}) {
  const { t } = useI18n();
  const decided = issue.decision !== null;
  return (
    <article className="review__issue" data-decided={decided}>
      <div className="review__issue-head">
        <span className="review__issue-badge" data-s={issue.severity}>
          {reviewSeverityLabel(issue.severity)}
        </span>
        <span className="review__issue-cat">
          {reviewCategoryLabel(issue.category)}
        </span>
        <span
          className="review__decision-chip"
          data-d={issue.decision?.action}
        >
          {decided
            ? reviewIssueActionLabel(issue.decision!.action)
            : reviewIssueStatusLabel(issue)}
        </span>
      </div>
      <p className="review__issue-message">{issue.message}</p>
      {issue.evidence.length > 0 ? (
        <div className="review__issue-evidence">
          {issue.evidence.map((entry, index) => (
            <span key={index}>
              “{entry.quote}”
              {index < issue.evidence.length - 1 ? " · " : ""}
            </span>
          ))}
        </div>
      ) : null}
      {issue.suggestedDirection ? (
        <p className="review__issue-suggest">{issue.suggestedDirection}</p>
      ) : null}
      {!decided ? (
        <div
          className="review__decider"
          role="group"
          aria-label={t("studio.review.deciderAria")}
        >
          <button
            type="button"
            className="review__decider-btn"
            disabled={pending}
            onClick={() => onDecide("accept")}
          >
            <Check size={11} strokeWidth={2} aria-hidden="true" />
            {t("studio.decide.accept")}
          </button>
          <button
            type="button"
            className="review__decider-btn"
            disabled={pending}
            onClick={() => onDecide("reject")}
          >
            {t("studio.decide.reject")}
          </button>
          <button
            type="button"
            className="review__decider-btn"
            disabled={pending}
            onClick={() => onDecide("false_positive")}
          >
            {t("studio.review.falsePositive")}
          </button>
          <button
            type="button"
            className="review__decider-btn"
            disabled={pending}
            onClick={() => onDecide("intentional_keep")}
          >
            {t("studio.review.intentionalKeep")}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function RevisionProposalPanel({
  projectId,
  activeDocumentId,
}: {
  projectId: string;
  activeDocumentId: string;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["project", projectId, "review"],
    queryFn: ({ signal }) => getReviewWorkspace(projectId, signal),
  });
  const mutation = useMutation({
    mutationFn: (input: {
      proposal: ReviewRevisionProposal;
      action: "apply" | "reject";
    }) => decideRevisionProposal(projectId, input.proposal.id, input.action),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "review"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "studio"],
      });
    },
  });
  const proposals = (query.data?.proposals ?? []).filter(
    (proposal) => proposal.documentId === activeDocumentId,
  );
  if (query.isPending) return null;
  return (
    <Panel title={t("studio.revisions.title")} count={proposals.length}>
      {query.isError ? (
        <ErrorNote error={query.error} title={t("studio.errors.revisionsLoad")} />
      ) : proposals.length === 0 ? (
        <p className="studio__panel-empty">{t("studio.revisions.empty")}</p>
      ) : (
        proposals.map((proposal) => (
          <article
            key={proposal.id}
            className="studio__proposal"
            data-status={proposal.status}
          >
            <strong>
              {t("studio.revisions.itemTitle", {
                status: proposalStatusLabel(proposal.status),
              })}
            </strong>
            {proposal.baseContent ? (
              <details className="studio__proposal-base">
                <summary>
                  {t("studio.revisions.baseSummary", {
                    count: proposal.baseContent.length,
                  })}
                </summary>
                <pre>{proposal.baseContent}</pre>
              </details>
            ) : null}
            <div
              className="review__doc-body review__doc-body--desk"
              aria-label={t("studio.revisions.revisedAria", {
                count: proposal.revisedContent.length,
              })}
            >
              {proposal.revisedContent}
            </div>
            {proposal.diff && Object.keys(proposal.diff).length > 0 ? (
              <details className="studio__proposal-base">
                <summary>{t("studio.revisions.diffSummary")}</summary>
                <pre className="review__proposal-diff">
                  {JSON.stringify(proposal.diff, null, 2)}
                </pre>
              </details>
            ) : null}
            {proposal.addressedIssueIds.length > 0 ? (
              <small>
                {t("studio.revisions.addressedIssues", {
                  count: proposal.addressedIssueIds.length,
                })}
              </small>
            ) : null}
            {proposal.status === "proposed" ? (
              <div className="studio__proposal-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ proposal, action: "apply" })
                  }
                >
                  {t("studio.revisions.apply")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({ proposal, action: "reject" })
                  }
                >
                  {t("studio.decide.reject")}
                </button>
              </div>
            ) : (
              <small>
                {proposalStatusLabel(proposal.status)}
                {proposal.decidedAt
                  ? ` · ${proposal.decidedAt.slice(0, 16)}`
                  : ""}
              </small>
            )}
            {mutation.isError ? (
              <ErrorNote
                error={mutation.error}
                title={t("studio.errors.proposalDecideFailed")}
              />
            ) : null}
          </article>
        ))
      )}
    </Panel>
  );
}

function CanonChangesPanel({
  projectId,
  document,
  versions,
}: {
  projectId: string;
  document: StoryDocument;
  versions: DocumentVersion[];
}) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ["project", projectId, "canon-change-sets"],
    queryFn: ({ signal }) => getCanonChangeSets(projectId, signal),
  });
  const runsQuery = useQuery({
    queryKey: ["project", projectId, "runs"],
    queryFn: ({ signal }) => getProjectRuns(projectId, signal),
  });
  const storyQuery = useQuery({
    queryKey: ["project", projectId, "story-bible"],
    queryFn: ({ signal }) => getStoryBible(projectId, signal),
  });
  const relatedRunIds = new Set(
    (runsQuery.data ?? [])
      .filter(
        (run) =>
          document.outlineNodeId &&
          run.targetOutlineNodeId === document.outlineNodeId,
      )
      .map((run) => run.id),
  );
  const versionIds = new Set(versions.map((version) => version.id));
  const sets = (query.data ?? []).filter(
    (set) =>
      set.status === "candidate" &&
      (relatedRunIds.has(set.runId) ||
        changeSetTouchesVersions(set.changes, versionIds)),
  );
  const entityNames = new Map(
    (storyQuery.data?.entities ?? []).map((entity) => [entity.id, entity.name]),
  );
  const settlementRuns = (runsQuery.data ?? []).filter(
    (run) =>
      run.recipe === "manual-settlement" &&
      runOriginDocumentId(run.policy) === document.id,
  );
  const activeSettlement = settlementRuns.find(
    (run) => !TERMINAL_RUN_STATUSES.has(run.status),
  );
  const failedSettlement = [...settlementRuns]
    .reverse()
    .find((run) => run.status === "failed");
  if (query.isPending || runsQuery.isPending)
    return (
      <Panel title={t("studio.canon.title")} count={0}>
        <Skeleton lines={2} />
      </Panel>
    );
  return (
    <Panel title={t("studio.canon.title")} count={sets.length}>
      {query.isError || runsQuery.isError ? (
        <ErrorNote
          error={query.error ?? runsQuery.error}
          title={t("studio.errors.canonLoad")}
        />
      ) : (
        <>
          {activeSettlement ? (
            <p className="studio__settlement-status" role="status">
              {t("studio.canon.settlementRunning")}
            </p>
          ) : failedSettlement ? (
            <p className="studio__settlement-status" data-tone="failed">
              {t("studio.canon.settlementFailedPrefix")}
              <Link
                to={`${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(failedSettlement.id)}`}
              >
                {t("studio.task.detailLink")}
              </Link>
              {t("studio.canon.settlementFailedSuffix")}
            </p>
          ) : null}
          {sets.length === 0 && !activeSettlement ? (
            <p className="studio__panel-empty">{t("studio.canon.empty")}</p>
          ) : sets.length > 0 ? (
            <>
              <p className="studio__section-intro">{t("studio.canon.intro")}</p>
              <CanonChangeSetReview
                projectId={projectId}
                sets={sets}
                entityNames={entityNames}
              />
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function CommentPanel({
  comments,
  pending,
  onToggle,
}: {
  comments: DocumentComment[];
  pending: boolean;
  onToggle: (comment: DocumentComment) => void;
}) {
  const { t } = useI18n();
  return (
    <Panel title={t("studio.comments.title")} count={comments.length}>
      {comments.length === 0 ? (
        <p className="studio__panel-empty">{t("studio.comments.empty")}</p>
      ) : (
        comments.map((comment) => (
          <article key={comment.id} className="studio__pin">
            <span className="studio__pin-state" data-s={comment.status}>
              {comment.status === "open"
                ? t("studio.comments.open")
                : t("studio.comments.resolved")}
            </span>
            <blockquote>{comment.quote}</blockquote>
            <p>{comment.body}</p>
            <small>
              {t("studio.comments.position", {
                start: comment.startOffset,
                end: comment.endOffset,
              })}
            </small>
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => onToggle(comment)}
            >
              {comment.status === "open"
                ? t("studio.comments.markResolved")
                : t("studio.comments.reopen")}
            </button>
          </article>
        ))
      )}
    </Panel>
  );
}

function VersionPanel({
  versions,
  currentVersionId,
  pending,
  onRestore,
}: {
  versions: DocumentVersion[];
  currentVersionId: string | null;
  pending: boolean;
  onRestore: (version: DocumentVersion) => void;
}) {
  const { t } = useI18n();
  return (
    <Panel title={t("studio.versions.title")} count={versions.length}>
      {versions.map((version, index) => (
        <article
          key={version.id}
          className="studio__version"
          data-current={version.id === currentVersionId}
        >
          <span className="studio__version-no mono">
            v{versions.length - index}
          </span>
          <span className="studio__version-meta">
            {t("studio.versions.meta", {
              source: versionSourceLabel(version.source),
              count: version.content.length,
              time: version.createdAt.slice(0, 16),
            })}
          </span>
          {version.id !== currentVersionId ? (
            <button
              type="button"
              className="btn"
              disabled={pending}
              onClick={() => onRestore(version)}
            >
              <Undo2 size={11} />
              {t("studio.versions.restore")}
            </button>
          ) : null}
        </article>
      ))}
    </Panel>
  );
}

function ProposalPanel({
  proposals,
  pending,
  onDecide,
}: {
  proposals: EditProposal[];
  pending: boolean;
  onDecide: (proposal: EditProposal, action: "accept" | "reject") => void;
}) {
  const { t } = useI18n();
  return (
    <Panel title={t("studio.proposals.title")} count={proposals.length}>
      {proposals.length === 0 ? (
        <p className="studio__panel-empty">{t("studio.proposals.empty")}</p>
      ) : (
        proposals.map((proposal) => (
          <article
            key={proposal.id}
            className="studio__proposal"
            data-status={proposal.status}
          >
            <strong>{proposal.instruction}</strong>
            {proposal.status === "proposed" ? (
              <small className="studio__proposal-state">
                {proposalStatusLabel(proposal.status)}
              </small>
            ) : null}
            <del>{proposal.originalText}</del>
            <ins>{proposal.replacementText}</ins>
            {proposal.status === "proposed" ? (
              <div className="studio__proposal-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={pending}
                  onClick={() => onDecide(proposal, "accept")}
                >
                  {t("studio.decide.accept")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={pending}
                  onClick={() => onDecide(proposal, "reject")}
                >
                  {t("studio.decide.reject")}
                </button>
              </div>
            ) : (
              <small>{proposalStatusLabel(proposal.status)}</small>
            )}
          </article>
        ))
      )}
    </Panel>
  );
}

function Panel({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="studio__panel">
      <header className="studio__panel-head">
        <p className="studio__panel-title">{title}</p>
        <span className="studio__panel-count">{count}</span>
      </header>
      <div className="studio__panel-body">{children}</div>
    </section>
  );
}

function reviewScoreLabel(key: string): string {
  const keys: Record<string, MessageKey> = {
    continuity: "studio.review.score.continuity",
    pacing: "studio.review.score.pacing",
    character: "studio.review.score.character",
    prose: "studio.review.score.prose",
    goal: "studio.review.score.goal",
    pov: "studio.review.score.pov",
  };
  const messageKey = keys[key];
  return messageKey ? translate(getLocale(), messageKey) : key;
}

function reviewSeverityLabel(value: ReviewWorkspaceIssue["severity"]): string {
  const keys: Record<ReviewWorkspaceIssue["severity"], MessageKey> = {
    info: "studio.review.severity.info",
    minor: "studio.review.severity.minor",
    major: "studio.review.severity.major",
    critical: "studio.review.severity.critical",
  };
  return translate(getLocale(), keys[value]);
}

function proposalStatusLabel(
  value: ReviewRevisionProposal["status"] | EditProposal["status"],
): string {
  const keys: Record<string, MessageKey> = {
    proposed: "studio.status.proposed",
    accepted: "studio.status.accepted",
    rejected: "studio.status.rejected",
    superseded: "studio.status.superseded",
  };
  const messageKey = keys[value];
  return messageKey ? translate(getLocale(), messageKey) : value;
}

function versionSourceLabel(source: string): string {
  if (source === "manual")
    return translate(getLocale(), "studio.versionSource.manual");
  if (source === "manual:comment-checkpoint")
    return translate(getLocale(), "studio.versionSource.commentCheckpoint");
  if (source === "manual:selection-baseline")
    return translate(getLocale(), "studio.versionSource.selectionBaseline");
  if (source.startsWith("run:"))
    return translate(getLocale(), "studio.versionSource.aiContent");
  if (source.startsWith("revision:"))
    return translate(getLocale(), "studio.versionSource.aiRevision");
  if (source.startsWith("restore:"))
    return translate(getLocale(), "studio.versionSource.restored");
  return translate(getLocale(), "studio.versionSource.fallback");
}

function changeSetTouchesVersions(
  value: unknown,
  versionIds: Set<string>,
): boolean {
  if (Array.isArray(value))
    return value.some((item) => changeSetTouchesVersions(item, versionIds));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.documentVersionId === "string" &&
    versionIds.has(record.documentVersionId)
  )
    return true;
  return Object.values(record).some((item) =>
    changeSetTouchesVersions(item, versionIds),
  );
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function runOriginDocumentId(policy: unknown): string | null {
  if (!policy || typeof policy !== "object") return null;
  const origin = (policy as Record<string, unknown>).origin;
  if (!origin || typeof origin !== "object") return null;
  const documentId = (origin as Record<string, unknown>).documentId;
  return typeof documentId === "string" ? documentId : null;
}

function markQuotes(content: string, quotes: string[]) {
  if (!quotes.length) return content;
  const pieces: Array<{ text: string; hot: boolean }> = [
    { text: content, hot: false },
  ];
  for (const quote of quotes) {
    const pattern = escapeRegExp(quote);
    const next: typeof pieces = [];
    for (const piece of pieces) {
      if (piece.hot) {
        next.push(piece);
        continue;
      }
      const text = piece.text;
      const regex = new RegExp(pattern, "g");
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex)
          next.push({ text: text.slice(lastIndex, match.index), hot: false });
        next.push({ text: match[0], hot: true });
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < text.length)
        next.push({ text: text.slice(lastIndex), hot: false });
    }
    pieces.splice(0, pieces.length, ...next);
  }
  return pieces.map((piece, index) =>
    piece.hot ? (
      <mark key={index}>{piece.text}</mark>
    ) : (
      <span key={index}>{piece.text}</span>
    ),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
