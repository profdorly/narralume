import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorNote } from "../../components/error-note";
import { useI18n } from "../../i18n";
import { applyStoryImport, type ImportBatchDetail } from "../../lib/api";
import { importCandidateKindLabel } from "../../lib/labels";
import { bibleBackfillPath, projectWorkspacePath } from "../../lib/project-route";
import { ShelfDialog } from "./dialog";

export function ImportDialog({
  detail,
  onClose,
  onApplied,
  onOpen,
}: {
  detail: ImportBatchDetail;
  onClose: () => void;
  onApplied: (projectId: string) => void;
  onOpen: (path: string) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>(() =>
    detail.candidates.map((candidate) => candidate.id),
  );
  const [appliedProjectId, setAppliedProjectId] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (ids: string[]) => applyStoryImport(detail.batch.id, ids),
    onSuccess: ({ projectId }, ids) => {
      onApplied(projectId);
      const importedProse = detail.candidates.some(
        (candidate) =>
          candidate.kind === "document" && ids.includes(candidate.id),
      );
      if (importedProse) setAppliedProjectId(projectId);
      else onOpen(projectWorkspacePath(projectId, "overview"));
    },
  });

  if (appliedProjectId) {
    return (
      <ShelfDialog
        eyebrow={t("shelf.upload.import")}
        title={t("shelf.import.appliedTitle", { name: detail.batch.filename })}
        note={t("shelf.import.appliedBody")}
        onClose={() =>
          onOpen(projectWorkspacePath(appliedProjectId, "overview"))
        }
      >
        <div className="shelf-dialog__actions">
          <button
            type="button"
            className="btn btn--outline"
            onClick={() =>
              onOpen(projectWorkspacePath(appliedProjectId, "overview"))
            }
          >
            {t("shelf.import.openProject")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onOpen(bibleBackfillPath(appliedProjectId))}
          >
            {t("shelf.import.completeBible")}
          </button>
        </div>
      </ShelfDialog>
    );
  }

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );

  return (
    <ShelfDialog
      eyebrow={t("shelf.upload.import")}
      title={t("shelf.import.title", { name: detail.batch.filename })}
      note={t("shelf.import.note", { count: detail.candidates.length })}
      onClose={onClose}
    >
      <div className="shelf-dialog__candidates">
        {detail.candidates.map((candidate) => (
          <label key={candidate.id} className="shelf-candidate">
            <input
              type="checkbox"
              checked={selected.includes(candidate.id)}
              onChange={() => toggle(candidate.id)}
            />
            <span className="shelf-candidate__kind mono">
              {importCandidateKindLabel(candidate.kind)}
            </span>
            <span className="shelf-candidate__title">{candidate.title}</span>
          </label>
        ))}
      </div>
      {mutation.isError ? (
        <div className="shelf-dialog__error">
          <ErrorNote error={mutation.error} title={t("shelf.import.error")} />
        </div>
      ) : null}
      <div className="shelf-dialog__actions">
        <button type="button" className="btn btn--outline" onClick={onClose}>
          {t("shelf.import.cancel")}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={mutation.isPending || selected.length === 0}
          onClick={() => mutation.mutate(selected)}
        >
          {mutation.isPending
            ? t("shelf.import.submitting")
            : t("shelf.import.submit", { count: selected.length })}
        </button>
      </div>
    </ShelfDialog>
  );
}
