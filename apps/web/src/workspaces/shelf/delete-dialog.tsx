import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { ErrorNote } from "../../components/error-note";
import { useI18n } from "../../i18n";
import { deleteProject, type Project } from "../../lib/api";
import { ShelfDialog } from "./dialog";

export function DeleteDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [confirmation, setConfirmation] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      deleteProject({
        id: project.id,
        title: project.title,
        updatedAt: project.updatedAt,
      }),
    onSuccess: () => onDeleted(),
  });

  return (
    <ShelfDialog
      eyebrow="DESTROY"
      title={t("shelf.deleteBook.title")}
      note={t("shelf.deleteBook.note", { name: project.title })}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmation === project.title) mutation.mutate();
        }}
      >
        <div className="shelf-dialog__field">
          <label className="shelf-dialog__label mono" htmlFor="delete-confirm">
            {t("shelf.deleteBook.confirmLabel")}
          </label>
          <input
            id="delete-confirm"
            className="shelf-dialog__input"
            placeholder={project.title}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoFocus
          />
        </div>
        {mutation.isError ? (
          <div className="shelf-dialog__error">
            <ErrorNote
              error={mutation.error}
              title={t("shelf.deleteBook.error")}
            />
          </div>
        ) : null}
        <div className="shelf-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            {t("shelf.deleteBook.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={mutation.isPending || confirmation !== project.title}
          >
            {mutation.isPending
              ? t("shelf.deleteBook.submitting")
              : t("shelf.deleteBook.submit")}
          </button>
        </div>
      </form>
    </ShelfDialog>
  );
}
