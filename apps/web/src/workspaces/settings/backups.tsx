import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, FileCheck2, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../i18n";
import {
  createSystemBackup,
  getSystemBackups,
  previewSystemBackup,
  restoreSystemBackup,
  type SystemBackupPreview,
} from "../../lib/api";
import { formatBytes, formatRelativeDate, formatTime, shortHash } from "../../lib/fmt";

/* ---- System backups (moved from delivery: full database backup, verification
   and disaster recovery) ---------------------- */

export function SystemBackupsSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const systemBackupsQuery = useQuery({
    queryKey: ["system-backups"],
    queryFn: ({ signal }) => getSystemBackups(signal),
    staleTime: 10_000,
  });
  const [previewBackupId, setPreviewBackupId] = useState<string | null>(null);
  const [systemRestoreTarget, setSystemRestoreTarget] = useState<SystemBackupPreview | null>(null);
  const [restoreDirectory, setRestoreDirectory] = useState("");
  const [systemRestoreResult, setSystemRestoreResult] = useState<string | null>(null);

  const backupCreateMutation = useMutation({
    mutationFn: (label: string) => createSystemBackup(label),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["system-backups"] }),
  });
  const backupPreviewMutation = useMutation({
    mutationFn: (backupId: string) => previewSystemBackup(backupId),
    onSuccess: (data) => setPreviewBackupId(data.manifest.id),
  });
  const systemRestoreMutation = useMutation({
    mutationFn: () => restoreSystemBackup(systemRestoreTarget!.manifest.id, restoreDirectory.trim(), false),
    onSuccess: (result) => {
      setSystemRestoreResult(t("settings.backups.restoreResult", { path: result.databasePath, hash: result.sha256 }));
      setSystemRestoreTarget(null);
      setRestoreDirectory("");
    },
  });

  const backups = useMemo(() => systemBackupsQuery.data ?? [], [systemBackupsQuery.data]);

  return (
    <section className="settings__section delivery__section--backups" aria-label={t("settings.backups.label")}>
      <header className="settings__section-head">
        <div>
          <p className="mono">{t("settings.backups.eyebrow")}</p>
          <h2><Archive size={13} strokeWidth={2} aria-hidden="true" /> {t("settings.backups.label")}</h2>
        </div>
        <button
          type="button"
          className="delivery__backup-new"
          onClick={() => backupCreateMutation.mutate(t("settings.backups.createLabel", { date: new Date().toISOString().slice(0, 16) }))}
          disabled={backupCreateMutation.isPending}
          aria-label={t("settings.backups.createAria")}
        >
          <Plus size={12} strokeWidth={2} aria-hidden="true" />
          {t("settings.backups.createAction")}
        </button>
      </header>
      {systemBackupsQuery.isPending ? (
        <Skeleton lines={3} />
      ) : systemBackupsQuery.isError ? (
        <ErrorNote error={systemBackupsQuery.error} title={t("settings.backups.loadError")} />
      ) : backups.length === 0 ? (
        <p className="delivery__empty">{t("settings.backups.empty")}</p>
      ) : (
        <ol className="delivery__backups">
          {backups.map((backup) => (
            <li key={backup.id} className="delivery__backup-row">
              <span className="delivery__backup-label">{backup.label}</span>
              <span className="delivery__backup-meta mono">
                {t("settings.backups.meta", {
                  size: formatBytes(backup.sizeBytes),
                  pages: backup.pageCount,
                  projects: backup.projectCount,
                  date: formatRelativeDate(backup.createdAt),
                })}
              </span>
              <span className="delivery__backup-hash mono">{shortHash(backup.sha256)}</span>
              <button
                type="button"
                className="delivery__backup-preview-btn"
                onClick={() => backupPreviewMutation.mutate(backup.id)}
                disabled={backupPreviewMutation.isPending}
                aria-label={t("settings.backups.previewAria", { label: backup.label })}
              >
                <FileCheck2 size={12} strokeWidth={2} aria-hidden="true" />
                {t("settings.backups.previewAction")}
              </button>
            </li>
          ))}
        </ol>
      )}
      {previewBackupId ? (
        <BackupPreviewPane
          backupId={previewBackupId}
          preview={backupPreviewMutation.data ?? null}
          onClose={() => setPreviewBackupId(null)}
          onRestore={(preview) => {
            setSystemRestoreTarget(preview);
            setRestoreDirectory("");
          }}
        />
      ) : null}
      {systemRestoreResult ? <p className="delivery__restore-result" role="status">{systemRestoreResult}</p> : null}
      {systemRestoreTarget ? (
        <ConfirmDialog
          title={t("settings.backups.restoreTitle")}
          confirmLabel={t("settings.backups.restoreConfirm")}
          danger
          pending={systemRestoreMutation.isPending}
          confirmDisabled={!restoreDirectory.trim()}
          onCancel={() => setSystemRestoreTarget(null)}
          onConfirm={() => systemRestoreMutation.mutate()}
        >
          <p>{t("settings.backups.verifyHash", { hash: systemRestoreTarget.manifest.sha256 })}</p>
          <p>
            {t("settings.backups.restoreInfo", {
              check: systemRestoreTarget.integrityCheck,
              violations: systemRestoreTarget.foreignKeyViolations,
              projects: systemRestoreTarget.counts.projects,
            })}
          </p>
          <label className="delivery__restore-directory">{t("settings.backups.directoryLabel")}<input value={restoreDirectory} onChange={(event) => setRestoreDirectory(event.target.value)} placeholder={t("settings.backups.directoryPlaceholder")} /></label>
          {!restoreDirectory.trim() ? <p className="delivery__restore-warning">{t("settings.backups.directoryWarning")}</p> : null}
          {systemRestoreMutation.isError ? <ErrorNote error={systemRestoreMutation.error} title={t("settings.backups.restoreErrorTitle")} /> : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function BackupPreviewPane({
  backupId,
  preview,
  onClose,
  onRestore,
}: {
  backupId: string;
  preview: SystemBackupPreview | null;
  onClose: () => void;
  onRestore: (preview: SystemBackupPreview) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="delivery__backup-preview" role="note">
      <header className="delivery__backup-preview-head">
        <p className="delivery__backup-preview-title mono">
          {t("settings.backups.previewTitle", { id: backupId.slice(0, 8) })}
        </p>
        <button type="button" onClick={onClose} aria-label={t("settings.backups.closeAria")}>
          {t("settings.backups.closeAction")}
        </button>
      </header>
      {!preview ? (
        <Skeleton lines={2} />
      ) : (
        <dl className="delivery__backup-preview-body">
          <div>
            <dt>{t("settings.backups.labelLabel")}</dt>
            <dd className="mono">{preview.manifest.label}</dd>
          </div>
          <div>
            <dt>{t("settings.backups.hashLabel")}</dt>
            <dd className="mono">{shortHash(preview.manifest.sha256)}</dd>
          </div>
          <div>
            <dt>{t("settings.backups.archiveLabel")}</dt>
            <dd>
              {t("settings.backups.archiveInfo", {
                time: formatTime(preview.manifest.createdAt),
                size: formatBytes(preview.manifest.sizeBytes),
                pages: preview.manifest.pageCount,
              })}
            </dd>
          </div>
          <div>
            <dt>{t("settings.backups.hashCheckLabel")}</dt>
            <dd data-ok={preview.hashMatches}>
              {preview.hashMatches ? t("settings.backups.hashOk") : t("settings.backups.hashBad")}
            </dd>
          </div>
          <div>
            <dt>{t("settings.backups.integrityLabel")}</dt>
            <dd>{preview.integrityCheck}</dd>
          </div>
          <div>
            <dt>{t("settings.backups.violationsLabel")}</dt>
            <dd data-ok={preview.foreignKeyViolations === 0}>
              {preview.foreignKeyViolations}
            </dd>
          </div>
          <div>
            <dt>{t("settings.backups.countsLabel")}</dt>
            <dd>
              {t("settings.backups.countsValue", {
                projects: preview.counts.projects,
                documents: preview.counts.documents,
                versions: preview.counts.versions,
                canon: preview.counts.canonFacts,
                runs: preview.counts.runs,
              })}
            </dd>
          </div>
        </dl>
      )}
      {preview?.valid && preview.hashMatches && preview.foreignKeyViolations === 0 ? <button type="button" className="btn btn--primary" onClick={() => onRestore(preview)}>{t("settings.backups.restoreAction")}</button> : null}
    </div>
  );
}

