import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Empty } from "../../components/empty";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { getLocale, useI18n } from "../../i18n";
import {
  getRecycledProjects,
  purgeRecycledProject,
  restoreRecycledProject,
  type RecycledProject,
} from "../../lib/api";
import { ShelfDialog } from "./dialog";

export function RecycleBin({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [purgeTarget, setPurgeTarget] = useState<RecycledProject | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const projectsQuery = useQuery({
    queryKey: ["projects", "recycle-bin"],
    queryFn: ({ signal }) => getRecycledProjects(signal),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: ["projects", "recycle-bin"],
    });
    onChanged();
  };
  const restoreMutation = useMutation({
    mutationFn: restoreRecycledProject,
    onSuccess: refresh,
  });
  const purgeMutation = useMutation({
    mutationFn: purgeRecycledProject,
    onSuccess: () => {
      setPurgeTarget(null);
      setConfirmation("");
      refresh();
    },
  });
  return (
    <ShelfDialog
      eyebrow={t("shelf.recycle.eyebrow")}
      title={t("shelf.recycle.title")}
      note={t("shelf.recycle.note")}
      onClose={onClose}
    >
      {projectsQuery.isPending ? (
        <Skeleton lines={4} />
      ) : projectsQuery.isError ? (
        <ErrorNote
          error={projectsQuery.error}
          title={t("shelf.recycle.loadError")}
        />
      ) : projectsQuery.data?.length ? (
        <div className="shelf-recycle">
          {projectsQuery.data.map((project) => (
            <article key={project.id} className="shelf-recycle__item">
              <div>
                <strong>{project.title}</strong>
                <p>
                  {t("shelf.recycle.autoClean", {
                    date: new Date(project.deleteAfter).toLocaleDateString(
                      getLocale(),
                    ),
                  })}
                </p>
              </div>
              <div className="shelf-recycle__actions">
                <button
                  type="button"
                  className="btn btn--outline"
                  disabled={restoreMutation.isPending || purgeMutation.isPending}
                  onClick={() => restoreMutation.mutate(project)}
                >
                  {t("shelf.recycle.restore")}
                </button>
                <button
                  type="button"
                  className="btn btn--outline"
                  disabled={restoreMutation.isPending || purgeMutation.isPending}
                  onClick={() => {
                    setPurgeTarget(project);
                    setConfirmation("");
                  }}
                >
                  {t("shelf.recycle.purge")}
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title={t("shelf.recycle.empty")}
          description={t("shelf.recycle.emptyHint")}
        />
      )}
      {purgeTarget ? (
        <div className="shelf-recycle__confirm">
          <p>{t("shelf.recycle.purgeNote", { name: purgeTarget.title })}</p>
          <input
            aria-label={t("shelf.recycle.purgeConfirmLabel")}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <div className="shelf-dialog__actions">
            <button
              type="button"
              className="btn btn--outline"
              onClick={() => setPurgeTarget(null)}
            >
              {t("common.action.cancel")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                confirmation !== purgeTarget.title || purgeMutation.isPending
              }
              onClick={() => purgeMutation.mutate(purgeTarget)}
            >
              {t("shelf.recycle.purge")}
            </button>
          </div>
        </div>
      ) : null}
      {restoreMutation.isError ? (
        <ErrorNote
          error={restoreMutation.error}
          title={t("shelf.recycle.restoreError")}
        />
      ) : null}
      {purgeMutation.isError ? (
        <ErrorNote
          error={purgeMutation.error}
          title={t("shelf.recycle.purgeError")}
        />
      ) : null}
    </ShelfDialog>
  );
}
