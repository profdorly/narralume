import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  saveDocumentDraft,
  type DocumentDraft,
  type StudioDocumentDetail,
} from "../../lib/api";

export type FlushDraft = () => Promise<boolean>;

export function useChapterDraft({
  projectId,
  detail,
  onFlushReady,
}: {
  projectId: string;
  detail: StudioDocumentDetail | undefined;
  onFlushReady: (flush: FlushDraft | null) => void;
}) {
  const initialContent =
    detail?.draft?.content ?? detail?.currentVersion?.content ?? "";
  const [content, setContent] = useState(initialContent);
  const [draftSavedContent, setDraftSavedContent] = useState(initialContent);
  const contentRef = useRef(content);
  const savedContentRef = useRef(draftSavedContent);
  const latestDraftRef = useRef<DocumentDraft | null>(detail?.draft ?? null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const autosaveTimerRef = useRef<number | null>(null);
  const queryClient = useQueryClient();

  const draftMutation = useMutation({
    mutationFn: (value: string) =>
      saveDocumentDraft(projectId, detail!.document.id, {
        content: value,
        baseVersionId: detail!.document.currentVersionId,
        expectedDraftUpdatedAt: latestDraftRef.current?.updatedAt ?? null,
      }),
    onSuccess: (draft, value) => {
      latestDraftRef.current = draft;
      savedContentRef.current = value;
      setDraftSavedContent(value);
      if (detail) {
        queryClient.setQueryData<StudioDocumentDetail>(
          ["project", projectId, "studio", "document", detail.document.id],
          (current) => (current ? { ...current, draft } : current),
        );
      }
    },
  });
  const mutateDraft = draftMutation.mutateAsync;
  const persistDraft = useCallback(
    (value: string): Promise<DocumentDraft | null> => {
      const perform = () => mutateDraft(value);
      const queued = saveQueueRef.current.then(perform, perform);
      saveQueueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [mutateDraft],
  );
  const cancelScheduledAutosave = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);
  const flushDraft = useCallback(async (): Promise<boolean> => {
    if (!detail) return true;
    cancelScheduledAutosave();
    await saveQueueRef.current;
    const value = contentRef.current;
    if (value === savedContentRef.current) return true;
    try {
      await persistDraft(value);
      return true;
    } catch {
      return false;
    }
  }, [cancelScheduledAutosave, detail, persistDraft]);

  useEffect(() => {
    if (!detail || content === draftSavedContent) return;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void persistDraft(content).catch(() => undefined);
    }, 700);
    return cancelScheduledAutosave;
  }, [
    cancelScheduledAutosave,
    content,
    detail,
    draftSavedContent,
    persistDraft,
  ]);

  const detailContentIdentity = detail
    ? `${detail.document.id}·${detail.document.currentVersionId ?? "none"}·${detail.draft?.contentHash ?? "none"}·${detail.draft?.updatedAt ?? "none"}`
    : null;
  const syncedIdentityRef = useRef(detailContentIdentity);
  useEffect(() => {
    if (!detail || detailContentIdentity === null) return;
    if (detailContentIdentity === syncedIdentityRef.current) return;
    syncedIdentityRef.current = detailContentIdentity;
    latestDraftRef.current = detail.draft;
    if (contentRef.current !== savedContentRef.current) return;
    cancelScheduledAutosave();
    const next = detail.draft?.content ?? detail.currentVersion?.content ?? "";
    contentRef.current = next;
    savedContentRef.current = next;
    setContent(next);
    setDraftSavedContent(next);
  }, [cancelScheduledAutosave, detail, detailContentIdentity]);

  useEffect(() => {
    onFlushReady(flushDraft);
    return () => onFlushReady(null);
  }, [flushDraft, onFlushReady]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (
        content !== draftSavedContent ||
        draftMutation.isPending ||
        draftMutation.isError
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [
    content,
    draftSavedContent,
    draftMutation.isPending,
    draftMutation.isError,
  ]);

  const updateContent = useCallback((next: string) => {
    contentRef.current = next;
    setContent(next);
  }, []);

  const saveState: "saved" | "saving" | "unsaved" =
    content === draftSavedContent && !draftMutation.isPending
      ? "saved"
      : draftMutation.isPending
        ? "saving"
        : "unsaved";

  return {
    content,
    updateContent,
    draftSavedContent,
    setDraftSavedContent,
    contentRef,
    savedContentRef,
    latestDraftRef,
    saveQueueRef,
    cancelScheduledAutosave,
    persistDraft,
    flushDraft,
    draftMutation,
    saveState,
  };
}
