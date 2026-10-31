import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ErrorNote } from "../../components/error-note";
import { useI18n } from "../../i18n";
import { downloadLibraryDatabase } from "../../lib/api";
import { formatBytes, formatRelativeDate } from "../../lib/fmt";
import {
  currentDriverMode,
  onDriverModeChange,
  readDriverOverride,
  resolveDriverMode,
  setDriverOverride,
  type DriverMode,
} from "../../kernel/transport";

/* ---- 运行驱动（M3：server API / 浏览器本地内核） ----------------------------- */

export function useDriverMode(): DriverMode {
  const [mode, setMode] = useState(currentDriverMode());
  useEffect(() => {
    void resolveDriverMode();
    return onDriverModeChange(setMode);
  }, []);
  return mode;
}

export function DriverSwitch() {
  const { t } = useI18n();
  const mode = useDriverMode();
  const override = readDriverOverride();
  const [pendingReload, setPendingReload] = useState(false);
  const [storageState, setStorageState] = useState<
    "unknown" | "granted" | "denied"
  >("unknown");
  const [storageEstimate, setStorageEstimate] = useState<{
    usage: number;
    quota: number;
  } | null>(null);
  const [lastExportAt, setLastExportAt] = useState<string | null>(() =>
    window.localStorage.getItem("lapis:local-db-last-export"),
  );
  const effective = override ?? mode;
  useEffect(() => {
    if (effective !== "local" || !navigator.storage) return;
    let active = true;
    void Promise.all([
      navigator.storage.persisted(),
      navigator.storage.estimate(),
    ]).then(([persisted, estimate]) => {
      if (!active) return;
      setStorageState(persisted ? "granted" : "denied");
      if (estimate.usage !== undefined && estimate.quota !== undefined)
        setStorageEstimate({ usage: estimate.usage, quota: estimate.quota });
    });
    return () => {
      active = false;
    };
  }, [effective]);
  const downloadMutation = useMutation({
    mutationFn: async () => {
      // 下载我的库（D6）：local 驱动从内核取 bytes；server 驱动提示用系统备份。
      const { blob, filename } = await downloadLibraryDatabase();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename ?? "lapis.sqlite";
      anchor.click();
      URL.revokeObjectURL(url);
      const exportedAt = new Date().toISOString();
      window.localStorage.setItem("lapis:local-db-last-export", exportedAt);
      setLastExportAt(exportedAt);
    },
  });
  const requestPersistence = async () => {
    if (!navigator.storage?.persist) return;
    const granted = await navigator.storage.persist();
    setStorageState(granted ? "granted" : "denied");
  };
  return (
    <div className="settings__tools-links">
      <label className="settings__project-pick">
        {t("settings.driver.label")}
        <select
          value={override ?? "auto"}
          disabled={pendingReload}
          onChange={(event) => {
            const next = event.target.value;
            setDriverOverride(next === "auto" ? null : (next as "server" | "local"));
            setPendingReload(true);
            window.location.reload();
          }}
        >
          <option value="auto">{t("settings.driver.optionAuto")}</option>
          <option value="server">{t("settings.driver.optionServer")}</option>
          <option value="local">{t("settings.driver.optionLocal")}</option>
        </select>
      </label>
      <button
        type="button"
        className="settings__tool-link"
        disabled={effective !== "local" || downloadMutation.isPending}
        title={effective === "local" ? t("settings.driver.downloadTitleLocal") : t("settings.driver.downloadTitleOther")}
        onClick={() => downloadMutation.mutate()}
      >
        {downloadMutation.isPending ? t("settings.driver.downloading") : t("settings.driver.downloadAction")}
      </button>
      {downloadMutation.isError ? (
        <ErrorNote error={downloadMutation.error} title={t("settings.driver.exportErrorTitle")} />
      ) : null}
      <p className="settings__section-note">
        {t("settings.driver.effectiveLabel", {
          mode: effective === "local"
            ? t("settings.driver.optionLocal")
            : effective === "server"
              ? t("settings.driver.optionServer")
              : t("settings.driver.modeProbing"),
        })}
        {override ? t("settings.driver.sourceManual") : t("settings.driver.sourceAuto")}
      </p>
      {effective === "local" ? (
        <>
          <p className="settings__section-note">{t("settings.driver.opfsNote")}</p>
          <p className="settings__section-note">
            {t("settings.driver.persistenceState", {
              state: storageState === "granted"
                ? t("settings.driver.persistenceGranted")
                : storageState === "denied"
                  ? t("settings.driver.persistenceDenied")
                  : t("settings.driver.persistenceReading"),
            })}
            {storageEstimate
              ? t("settings.driver.storageUsage", {
                  usage: formatBytes(storageEstimate.usage),
                  quota: formatBytes(storageEstimate.quota),
                })
              : ""}
            {lastExportAt
              ? t("settings.driver.lastExport", { date: formatRelativeDate(lastExportAt) })
              : t("settings.driver.noExport")}
          </p>
          <button
            type="button"
            className="settings__tool-link"
            onClick={() => void requestPersistence()}
            disabled={storageState === "granted" || !navigator.storage?.persist}
          >
            {storageState === "granted" ? t("settings.driver.persistGrantedAction") : t("settings.driver.persistRequestAction")}
          </button>
        </>
      ) : null}
    </div>
  );
}

