import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import {
  appendDocumentVersion,
  restoreDocumentVersion,
  type DocumentDraft,
  type DocumentVersion,
  type StudioDocumentDetail,
} from "../../lib/api";

export function useVersions({
  projectId,
  detail,
  content,
  setDraftSavedContent,
  savedContentRef,
  latestDraftRef,
  saveQueueRef,
  cancelScheduledAutosave,
  onRefresh,
}: {
  projectId: string;
  detail: StudioDocumentDetail | undefined;
  content: string;
  setDraftSavedContent: (value: string) => void;
  savedContentRef: { current: string };
  latestDraftRef: { current: DocumentDraft | null };
  saveQueueRef: { current: Promise<void> };
  cancelScheduledAutosave: () => void;
  onRefresh: () => void;
}) {
  const [restoreTarget, setRestoreTarget] = useState<DocumentVersion | null>(
    null,
  );
  const versionMutation = useMutation({
    mutationFn: async () => {
      cancelScheduledAutosave();
      await saveQueueRef.current;
      return appendDocumentVersion(projectId, detail!.document.id, {
        content,
        source: "manual",
        expectedCurrentVersionId: detail!.document.currentVersionId,
      });
    },
    onSuccess: () => {
      latestDraftRef.current = null;
      savedContentRef.current = content;
      setDraftSavedContent(content);
      onRefresh();
    },
  });
  const restoreMutation = useMutation({
    mutationFn: (version: DocumentVersion) =>
      restoreDocumentVersion(
        projectId,
        detail!.document.id,
        version.id,
        detail!.document.currentVersionId,
      ),
    onSuccess: () => {
      setRestoreTarget(null);
      onRefresh();
    },
  });

  return {
    restoreTarget,
    setRestoreTarget,
    versionMutation,
    restoreMutation,
  };
}
