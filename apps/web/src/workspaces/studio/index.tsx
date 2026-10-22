import "../../styles/studio.css";
import "../../styles/review.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { Empty } from "../../components/empty";
import { ErrorNote } from "../../components/error-note";
import { PageBand } from "../../components/page-band";
import { ProjectRequiredState } from "../../components/project-required-state";
import { useI18n, getLocale, translate } from "../../i18n";
import {
  createStoryDocument,
  getProjectOverview,
  getRunDetail,
  getReviewWorkspace,
  getStoryBible,
  getStudioDocument,
  getStudioDocuments,
  setStoryDocumentArchived,
  type OutlineNode,
  type ReviewWorkspaceReport,
  type StoryDocument,
} from "../../lib/api";
import { formatRelativeDate } from "../../lib/fmt";
import { documentKindLabel } from "../../lib/labels";
import { useProjectId } from "../../lib/project-route";
import { useServerEvents } from "../../lib/sse";
import { rememberedTasks } from "../../lib/task-ledger";
import { StudioDesk } from "./desk";
import type { FlushDraft } from "./use-chapter-draft";

type CreateDocumentInput = {
  kind: StoryDocument["kind"];
  title: string;
  outlineNodeId: string | null;
};

export function StudioWorkspace() {
  const { t } = useI18n();
  const projectId = useProjectId();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [showRecycle, setShowRecycle] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const flushDraftRef = useRef<FlushDraft | null>(null);
  const createRequestRef = useRef<{
    identity: string;
    requestId: string;
  } | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("editor-focus", focusMode);
    return () => document.documentElement.classList.remove("editor-focus");
  }, [focusMode]);

  useServerEvents(
    {
      onRunStatus: (_runId, status) => {
        if (status !== "completed" || !projectId) return;
        void queryClient.invalidateQueries({
          queryKey: ["project", projectId, "studio"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["project", projectId, "review"],
        });
      },
    },
    Boolean(projectId),
  );

  const documentsQuery = useQuery({
    queryKey: ["project", projectId, "studio", "documents"],
    queryFn: ({ signal }) => getStudioDocuments(projectId!, signal),
    enabled: Boolean(projectId),
  });
  const documents = useMemo(
    () => documentsQuery.data ?? [],
    [documentsQuery.data],
  );
  const recycledDocumentsQuery = useQuery({
    queryKey: ["project", projectId, "studio", "documents", "recycle"],
    queryFn: ({ signal }) => getStudioDocuments(projectId!, signal, true),
    enabled: Boolean(projectId && showRecycle),
  });
  const listedDocuments = useMemo(
    () =>
      showRecycle
        ? (recycledDocumentsQuery.data ?? []).filter((document) =>
            Boolean(document.archivedAt),
          )
        : documents,
    [documents, recycledDocumentsQuery.data, showRecycle],
  );
  const reviewQuery = useQuery({
    queryKey: ["project", projectId, "review"],
    queryFn: ({ signal }) => getReviewWorkspace(projectId!, signal),
    enabled: Boolean(projectId),
  });
  const documentQuality = useMemo(
    () => currentDocumentQuality(documents, reviewQuery.data?.reports ?? []),
    [documents, reviewQuery.data?.reports],
  );
  const overviewQuery = useQuery({
    queryKey: ["project", projectId, "overview"],
    queryFn: ({ signal }) => getProjectOverview(projectId!, signal),
    enabled: Boolean(projectId),
    refetchInterval: (query) =>
      query.state.data?.activeTask ? 3_000 : false,
  });
  const requestedDocumentId = searchParams.get("document");
  const requestedOutlineId = searchParams.get("outline");
  const selectedRunId = searchParams.get("run");
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const focusTarget = searchParams.get("focus");
  const requestedDocument = requestedDocumentId
    ? listedDocuments.find((document) => document.id === requestedDocumentId)
    : undefined;
  const outlineDocument = requestedOutlineId
    ? listedDocuments.find(
        (document) => document.outlineNodeId === requestedOutlineId,
      )
    : undefined;
  const requestedTargetDocumentId =
    requestedDocument?.id ?? outlineDocument?.id ?? null;
  const rememberedChapterTasks = useMemo(() => {
    if (!projectId) return [];
    const documentIds = new Set(documents.map((document) => document.id));
    return rememberedTasks(projectId).filter(
      (task) =>
        task.kind === "chapter" &&
        Boolean(task.documentId && documentIds.has(task.documentId)),
    );
  }, [documents, projectId]);
  const overviewTask =
    overviewQuery.data?.activeTask?.kind === "chapter"
      ? overviewQuery.data.activeTask
      : null;
  const overviewTaskDocumentId =
    overviewTask?.targetChapter?.documentId ??
    rememberedChapterTasks.find((task) => task.taskId === overviewTask?.id)
      ?.documentId ??
    null;
  const restoreTask = selectedRunId
    ? null
    : requestedTargetDocumentId
      ? overviewTask && overviewTaskDocumentId === requestedTargetDocumentId
        ? { taskId: overviewTask.id, documentId: requestedTargetDocumentId }
        : (rememberedChapterTasks.find(
            (task) => task.documentId === requestedTargetDocumentId,
          ) ?? null)
      : overviewTask && overviewTaskDocumentId
        ? { taskId: overviewTask.id, documentId: overviewTaskDocumentId }
        : (rememberedChapterTasks[0] ?? null);
  const restoreCandidateRunId = restoreTask?.taskId ?? null;
  const restoreRunQuery = useQuery({
    queryKey: [
      "project",
      projectId,
      "studio",
      "restore-run",
      restoreCandidateRunId,
    ],
    queryFn: ({ signal }) =>
      getRunDetail(projectId!, restoreCandidateRunId!, signal),
    enabled: Boolean(projectId && restoreCandidateRunId),
    retry: false,
  });
  const canRestoreRun =
    restoreRunQuery.data?.run.recipe === "chapter-production" &&
    !["completed", "cancelled"].includes(restoreRunQuery.data.run.status);
  const activeDocumentId =
    requestedTargetDocumentId ??
    (showRecycle
      ? (listedDocuments[0]?.id ?? null)
      : ((canRestoreRun ? restoreTask?.documentId : null) ??
        listedDocuments[0]?.id ??
        null));
  const restoredRunId =
    restoreCandidateRunId !== dismissedRunId &&
    restoreTask?.documentId === activeDocumentId &&
    canRestoreRun
      ? restoreCandidateRunId
      : null;
  const effectiveRunId = selectedRunId ?? restoredRunId;
  const updateWorkspaceParams = useCallback(
    (updates: {
      document?: string | null;
      outline?: string | null;
      run?: string | null;
    }) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(updates)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          return next;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );
  useEffect(() => {
    if (requestedOutlineId && !documentsQuery.isPending && !outlineDocument) {
      queueMicrotask(() => setCreating(true));
    }
  }, [documentsQuery.isPending, outlineDocument, requestedOutlineId]);
  const storyQuery = useQuery({
    queryKey: ["project", projectId, "story-bible"],
    queryFn: ({ signal }) => getStoryBible(projectId!, signal),
    enabled: Boolean(projectId && creating),
  });
  const availableOutlineNodes = useMemo(() => {
    const used = new Set(storyQuery.data?.occupiedOutlineNodeIds ?? []);
    return (storyQuery.data?.outline ?? []).filter(
      (node) =>
        (node.kind === "chapter" || node.kind === "scene") &&
        !used.has(node.id),
    );
  }, [storyQuery.data]);
  const detailQuery = useQuery({
    queryKey: ["project", projectId, "studio", "document", activeDocumentId],
    queryFn: ({ signal }) =>
      getStudioDocument(projectId!, activeDocumentId!, signal),
    enabled: Boolean(projectId && activeDocumentId && !showRecycle),
  });
  const archiveMutation = useMutation({
    mutationFn: ({
      document,
      archived,
    }: {
      document: StoryDocument;
      archived: boolean;
    }) => setStoryDocumentArchived(document, archived),
    onSuccess: () => {
      updateWorkspaceParams({ document: null, outline: null, run: null });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "studio", "documents"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "studio", "document"],
      });
    },
  });
  const createMutation = useMutation({
    mutationFn: async (input: CreateDocumentInput) => {
      const ready = await flushDraftRef.current?.();
      if (ready === false)
        throw new Error(translate(getLocale(), "studio.errors.draftNotSynced"));
      const identity = JSON.stringify(input);
      if (createRequestRef.current?.identity !== identity) {
        createRequestRef.current = {
          identity,
          requestId: crypto.randomUUID(),
        };
      }
      return createStoryDocument(projectId!, {
        ...input,
        requestId: createRequestRef.current.requestId,
      });
    },
    onSuccess: (document) => {
      createRequestRef.current = null;
      setCreating(false);
      updateWorkspaceParams({
        document: document.id,
        outline: null,
        run: null,
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "studio", "documents"],
      });
    },
  });
  const registerFlush = useCallback((flush: FlushDraft | null) => {
    flushDraftRef.current = flush;
  }, []);

  if (!projectId) {
    return (
      <div className="studio">
        <ProjectRequiredState
          seal={t("studio.required.seal")}
          title={t("studio.required.title")}
          description={t("studio.required.description")}
        />
      </div>
    );
  }

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["project", projectId, "studio", "documents"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["project", projectId, "studio", "document", activeDocumentId],
    });
  };
  const selectDocument = async (nextDocumentId: string) => {
    if (nextDocumentId === activeDocumentId) return;
    const ready = await flushDraftRef.current?.();
    if (ready !== false) {
      setDismissedRunId(null);
      updateWorkspaceParams({
        document: nextDocumentId,
        outline: null,
        run: null,
      });
    }
  };

  return (
    <div className="studio">
      <PageBand
        index="ESCRITA · 04"
        title={t("studio.header.title")}
        meta={
          <div
            className="studio__mode-switch"
            role="group"
            aria-label={t("studio.header.modeSwitchAria")}
          >
            <button
              type="button"
              aria-pressed={focusMode}
              onClick={() => setFocusMode((value) => !value)}
            >
              {focusMode
                ? t("common.action.collapse")
                : t("common.action.expand")}
            </button>
          </div>
        }
      />
      {documentsQuery.isPending ? (
        <StudioLoading />
      ) : documentsQuery.isError ? (
        <ErrorNote
          error={documentsQuery.error}
          title={t("studio.errors.documentsLoad")}
        />
      ) : (
        <div className="studio__layout">
          <aside className="studio__docs">
            <header className="studio__docs-head">
              <p className="studio__docs-title">
                {showRecycle ? t("studio.docs.recycle") : t("studio.docs.list")}
              </p>
              <div>
                <button
                  type="button"
                  className="studio__text-button"
                  onClick={() => {
                    setShowRecycle((value) => !value);
                    setCreating(false);
                  }}
                >
                  {showRecycle
                    ? t("studio.docs.backToList")
                    : t("studio.docs.recycle")}
                </button>
                {!showRecycle ? (
                  <button
                    type="button"
                    className="studio__text-button"
                    onClick={() => setCreating((value) => !value)}
                  >
                    <Plus size={12} />
                    {t("studio.docs.new")}
                  </button>
                ) : null}
              </div>
            </header>
            {creating ? (
              <CreateDocumentForm
                initialOutlineNodeId={requestedOutlineId}
                outlineNodes={availableOutlineNodes}
                outlinePending={storyQuery.isPending}
                pending={createMutation.isPending}
                error={createMutation.error ?? storyQuery.error}
                onCancel={() => setCreating(false)}
                onOpenRecycle={() => {
                  setCreating(false);
                  setShowRecycle(true);
                }}
                onSubmit={(input) => createMutation.mutate(input)}
              />
            ) : null}
            <div className="studio__docs-list">
              {listedDocuments.map((document) => {
                const quality = documentQuality.get(document.id);
                return (
                  <button
                    key={document.id}
                    type="button"
                    className="studio__doc-link"
                    data-active={document.id === activeDocumentId}
                    onClick={() => void selectDocument(document.id)}
                  >
                    <span className="studio__doc-link-title">
                      {document.title}
                    </span>
                    <span className="studio__doc-link-meta">
                      {documentKindLabel(document.kind)} ·{" "}
                      {formatRelativeDate(document.updatedAt)}
                      {quality ? (
                        <span
                          className="studio__quality-mark"
                          data-quality={quality}
                        >
                          {quality === "pass"
                            ? t("studio.quality.pass")
                            : quality === "revise"
                              ? t("studio.quality.revise")
                              : t("studio.quality.block")}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {listedDocuments.length === 0 && !creating ? (
              <p className="studio__empty-note">
                {showRecycle
                  ? t("studio.docs.recycleEmpty")
                  : t("studio.docs.listEmpty")}
              </p>
            ) : null}
          </aside>
          {showRecycle ? (
            <RecycleDesk
              document={listedDocuments.find(
                (document) => document.id === activeDocumentId,
              )}
              pending={archiveMutation.isPending}
              error={archiveMutation.error}
              onRestore={(document) => {
                setShowRecycle(false);
                updateWorkspaceParams({
                  document: null,
                  outline: null,
                  run: null,
                });
                archiveMutation.mutate({ document, archived: false });
              }}
            />
          ) : (
            <StudioDesk
              key={detailQuery.data?.document.id ?? "pending"}
              projectId={projectId}
              detail={detailQuery.data}
              pending={Boolean(activeDocumentId) && detailQuery.isPending}
              error={detailQuery.error ?? archiveMutation.error}
              review={reviewQuery.data}
              reviewPending={reviewQuery.isPending}
              reviewError={reviewQuery.error}
              focusTarget={focusTarget}
              focusMode={focusMode}
              runId={effectiveRunId}
              onRunChange={(runId) => {
                setDismissedRunId(null);
                updateWorkspaceParams({
                  document: activeDocumentId,
                  outline: null,
                  run: runId,
                });
              }}
              onDismissRun={() => {
                if (effectiveRunId) setDismissedRunId(effectiveRunId);
                updateWorkspaceParams({ run: null });
              }}
              onCreateDocument={() => setCreating(true)}
              onArchive={async (document) => {
                const ready = await flushDraftRef.current?.();
                if (ready !== false)
                  archiveMutation.mutate({ document, archived: true });
              }}
              onRefresh={refresh}
              onFlushReady={registerFlush}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StudioLoading() {
  const { t } = useI18n();
  return (
    <div
      className="studio__layout studio__loading"
      aria-busy="true"
      aria-label={t("studio.loading.aria")}
    >
      <aside className="studio__loading-docs">
        <span />
        <span />
        <span />
        <span />
      </aside>
      <main className="studio__loading-paper">
        <div className="studio__loading-title" />
        <div className="studio__loading-lines">
          {Array.from({ length: 9 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      </main>
      <aside className="studio__loading-tools">
        <span />
        <span />
        <span />
      </aside>
    </div>
  );
}

function CreateDocumentForm({
  initialOutlineNodeId,
  outlineNodes,
  outlinePending,
  pending,
  error,
  onCancel,
  onOpenRecycle,
  onSubmit,
}: {
  initialOutlineNodeId: string | null;
  outlineNodes: OutlineNode[];
  outlinePending: boolean;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onOpenRecycle: () => void;
  onSubmit: (input: CreateDocumentInput) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<StoryDocument["kind"]>("chapter");
  const [outlineNodeId, setOutlineNodeId] = useState(
    initialOutlineNodeId ?? "",
  );
  const requiresOutline = kind === "chapter" || kind === "scene";
  const matchingNodes = outlineNodes.filter((node) => node.kind === kind);
  const selectedNode =
    matchingNodes.find((node) => node.id === outlineNodeId) ??
    matchingNodes[0] ??
    null;
  const resolvedTitle = title.trim() || selectedNode?.title || "";
  return (
    <form
      className="studio__inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!resolvedTitle || (requiresOutline && !selectedNode)) return;
        onSubmit({
          kind,
          title: resolvedTitle,
          outlineNodeId: requiresOutline ? selectedNode!.id : null,
        });
      }}
    >
      <label>
        {t("studio.create.kindLabel")}
        <select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as StoryDocument["kind"]);
            setOutlineNodeId("");
          }}
        >
          <option value="chapter">{t("studio.create.kindChapter")}</option>
          <option value="scene">{t("studio.create.kindScene")}</option>
          <option value="outline">{t("studio.create.kindOutline")}</option>
          <option value="synopsis">{t("studio.create.kindSynopsis")}</option>
          <option value="note">{t("studio.create.kindNote")}</option>
          <option value="style-sample">
            {t("studio.create.kindStyleSample")}
          </option>
        </select>
      </label>
      {requiresOutline ? (
        <label>
          {t("studio.create.outlineLabel")}
          <select
            aria-label={t("studio.create.outlineNodeAria")}
            value={selectedNode?.id ?? ""}
            disabled={outlinePending || matchingNodes.length === 0}
            onChange={(event) => setOutlineNodeId(event.target.value)}
          >
            {outlinePending ? (
              <option value="">{t("studio.create.outlineLoading")}</option>
            ) : matchingNodes.length === 0 ? (
              <option value="">
                {t("studio.create.noBindable", {
                  kind:
                    kind === "chapter"
                      ? t("studio.create.nodeKindChapter")
                      : t("studio.create.nodeKindScene"),
                })}
              </option>
            ) : (
              matchingNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.title}
                </option>
              ))
            )}
          </select>
        </label>
      ) : null}
      <label>
        {t("studio.create.titleLabel")}
        <input
          value={title}
          placeholder={selectedNode?.title ?? t("studio.create.titlePlaceholder")}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {requiresOutline && !outlinePending && matchingNodes.length === 0 ? (
        <div className="studio__form-note">
          <p>{t("studio.create.outlineMissingNote")}</p>
          <button type="button" className="btn" onClick={onOpenRecycle}>
            {t("studio.create.openRecycle")}
          </button>
        </div>
      ) : null}
      {error ? (
        <ErrorNote error={error} title={t("studio.errors.createFailed")} />
      ) : null}
      <div className="studio__inline-form-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.action.cancel")}
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={
            pending ||
            outlinePending ||
            !resolvedTitle ||
            (requiresOutline && !selectedNode)
          }
        >
          {t("common.action.create")}
        </button>
      </div>
    </form>
  );
}

function RecycleDesk({
  document,
  pending,
  error,
  onRestore,
}: {
  document: StoryDocument | undefined;
  pending: boolean;
  error: unknown;
  onRestore: (document: StoryDocument) => void;
}) {
  const { t } = useI18n();
  if (!document)
    return (
      <main className="studio__desk studio__desk--empty">
        <Empty
          title={t("studio.recycle.emptyTitle")}
          description={t("studio.recycle.emptyDescription")}
        />
      </main>
    );
  return (
    <main className="studio__desk studio__desk--empty">
      <div className="studio__recycle-card">
        <span className="mono">{t("studio.docs.recycle")}</span>
        <h2>{document.title}</h2>
        <p>
          {documentKindLabel(document.kind)} ·{" "}
          {t("studio.recycle.archivedAt", {
            time: document.archivedAt?.slice(0, 16) ?? "—",
          })}
        </p>
        <p>{t("studio.recycle.note")}</p>
        <button
          type="button"
          className="btn btn--primary"
          disabled={pending}
          onClick={() => onRestore(document)}
        >
          <ArchiveRestore size={13} />
          {pending ? t("studio.recycle.restoring") : t("studio.recycle.restore")}
        </button>
        {error ? (
          <ErrorNote error={error} title={t("studio.errors.restoreFailed")} />
        ) : null}
      </div>
    </main>
  );
}

function currentDocumentQuality(
  documents: StoryDocument[],
  reports: ReviewWorkspaceReport[],
): Map<string, ReviewWorkspaceReport["verdict"]> {
  const currentVersions = new Map(
    documents.flatMap((document) =>
      document.currentVersionId
        ? ([[document.currentVersionId, document.id]] as const)
        : [],
    ),
  );
  const quality = new Map<string, ReviewWorkspaceReport["verdict"]>();
  for (const report of [...reports].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )) {
    const documentId = report.documentVersionId
      ? currentVersions.get(report.documentVersionId)
      : undefined;
    if (documentId && !quality.has(documentId)) {
      quality.set(documentId, report.verdict);
    }
  }
  return quality;
}
