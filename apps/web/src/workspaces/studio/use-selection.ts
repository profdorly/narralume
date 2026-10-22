import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import {
  appendDocumentVersion,
  createDocumentComment,
  createSelectionEdit,
  decideEditProposal,
  setDocumentCommentStatus,
  type DocumentComment,
  type DocumentDraft,
  type EditProposal,
  type StudioDocumentDetail,
} from "../../lib/api";

export function useSelection({
  projectId,
  detail,
  content,
  setDraftSavedContent,
  savedContentRef,
  latestDraftRef,
  saveQueueRef,
  persistDraft,
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
  persistDraft: (value: string) => Promise<DocumentDraft | null>;
  cancelScheduledAutosave: () => void;
  onRefresh: () => void;
}) {
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [commentBody, setCommentBody] = useState("");
  const [editInstruction, setEditInstruction] = useState("");

  const commentMutation = useMutation({
    mutationFn: async () => {
      cancelScheduledAutosave();
      await saveQueueRef.current;
      const selectedContent = content;
      let version = detail!.currentVersion;
      if (!version || version.content !== selectedContent) {
        version = await appendDocumentVersion(projectId, detail!.document.id, {
          content: selectedContent,
          source: "manual:comment-checkpoint",
          expectedCurrentVersionId: detail!.document.currentVersionId,
        });
        latestDraftRef.current = null;
        savedContentRef.current = selectedContent;
        setDraftSavedContent(selectedContent);
      }
      return createDocumentComment(projectId, detail!.document.id, {
        versionId: version.id,
        startOffset: selection.start,
        endOffset: selection.end,
        quote: selectedContent.slice(selection.start, selection.end),
        body: commentBody.trim(),
      });
    },
    onSuccess: () => {
      setCommentBody("");
      onRefresh();
    },
  });
  const statusMutation = useMutation({
    mutationFn: (comment: DocumentComment) =>
      setDocumentCommentStatus(
        comment.id,
        comment.status === "open" ? "resolved" : "open",
      ),
    onSuccess: onRefresh,
  });
  const editMutation = useMutation({
    mutationFn: async () => {
      cancelScheduledAutosave();
      await saveQueueRef.current;
      let baseVersionId = detail!.currentVersion?.id ?? null;
      let draftContentHash: string | null = null;
      if (!baseVersionId) {
        const version = await appendDocumentVersion(
          projectId,
          detail!.document.id,
          {
            content,
            source: "manual:selection-baseline",
            expectedCurrentVersionId: null,
          },
        );
        baseVersionId = version.id;
        latestDraftRef.current = null;
        savedContentRef.current = content;
        setDraftSavedContent(content);
      } else {
        const syncedDraft =
          content === savedContentRef.current
            ? latestDraftRef.current
            : await persistDraft(content);
        draftContentHash = syncedDraft?.contentHash ?? null;
      }
      return createSelectionEdit(projectId, detail!.document.id, {
        baseVersionId,
        draftContentHash,
        selectionStart: selection.start,
        selectionEnd: selection.end,
        instruction: editInstruction.trim(),
      });
    },
    onSuccess: () => {
      latestDraftRef.current = null;
      savedContentRef.current = content;
      setDraftSavedContent(content);
      setEditInstruction("");
      onRefresh();
    },
  });
  const proposalMutation = useMutation({
    mutationFn: (input: { proposal: EditProposal; action: "accept" | "reject" }) =>
      decideEditProposal(input.proposal.id, input.action),
    onSuccess: onRefresh,
  });

  return {
    selection,
    setSelection,
    commentBody,
    setCommentBody,
    editInstruction,
    setEditInstruction,
    commentMutation,
    statusMutation,
    editMutation,
    proposalMutation,
  };
}
