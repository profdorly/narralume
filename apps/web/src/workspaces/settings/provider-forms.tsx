import { Edit3, Radio, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { ErrorNote } from "../../components/error-note";
import { useI18n } from "../../i18n";
import {
  type ModelConfigDto,
  type ModelTaskType,
  type ProviderProbeResult,
  type PublicProviderDto,
  type UpsertModelRequest,
  type UpsertProviderRequest,
  type WireApi,
} from "../../lib/api";
import {
  assignmentRoleLabel,
  metadataSourceLabel,
  probeStageLabel,
  probeStageStatusLabel,
  wireApiLabel,
} from "../../lib/labels";
import { TASK_TYPES, WIRE_APIS } from "./constants";

/* ---- Provider / 模型管理（从供给迁入） --------------------------------------- */

export function ProviderForm({ provider, pending, error, onCancel, onSubmit }: {
  provider: PublicProviderDto | null;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (value: UpsertProviderRequest) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(provider?.name ?? "");
  const [wireApi, setWireApi] = useState<WireApi>(provider?.wireApi ?? "openai-chat");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [endpoint, setEndpoint] = useState(provider?.endpoint ?? "");
  const [credentialRef, setCredentialRef] = useState("");
  const [anthropicVersion, setAnthropicVersion] = useState(provider?.anthropicVersion ?? "");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!provider && !credentialRef.trim()) {
      setLocalError(t("settings.provider.credentialRequired"));
      return;
    }
    const value: UpsertProviderRequest = {
      name: name.trim(), wireApi, baseUrl: baseUrl.trim(), endpoint: endpoint.trim() || null,
      anthropicVersion: anthropicVersion.trim() || null, headers: provider?.headers ?? {},
      queryParams: provider?.queryParams ?? {}, requestStartTimeoutMs: provider?.requestStartTimeoutMs ?? null,
      streamIdleTimeoutMs: provider?.streamIdleTimeoutMs ?? null, enabled,
      ...(credentialRef.trim() ? { credentialRef: credentialRef.trim() } : {}),
    };
    onSubmit(value);
  };
  return (
    <form className="supply__editor" onSubmit={submit}>
      <h3>{provider ? t("settings.provider.formTitleEdit") : t("settings.provider.formTitleNew")}</h3>
      <label>{t("settings.provider.nameLabel")}<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("settings.provider.protocolLabel")}<select value={wireApi} onChange={(event) => setWireApi(event.target.value as WireApi)}>{WIRE_APIS.map((value) => <option key={value} value={value}>{wireApiLabel(value)}</option>)}</select></label>
      <label>Base URL<input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
      <label>{t("settings.provider.endpointLabel")}<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
      <label>{provider ? t("settings.provider.credentialLabelEdit") : t("settings.provider.credentialLabelNew")}<input type="password" value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} autoComplete="off" /></label>
      {wireApi === "anthropic-messages" ? <label>Anthropic Version<input value={anthropicVersion} onChange={(event) => setAnthropicVersion(event.target.value)} /></label> : null}
      <label className="supply__check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("common.action.enable")}</label>
      {localError ? <p className="supply__local-error" role="alert">{localError}</p> : null}
      {error ? <ErrorNote error={error} title={t("settings.provider.saveErrorTitle")} /> : null}
      <div className="supply__editor-actions"><button type="button" className="btn" onClick={onCancel}>{t("common.action.cancel")}</button><button type="submit" className="btn btn--primary" disabled={pending}>{pending ? t("common.state.saving") : t("common.action.save")}</button></div>
    </form>
  );
}

export function ModelForm({ providerId, model, pending, error, onCancel, onSubmit }: {
  providerId: string;
  model: ModelConfigDto | null;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (value: UpsertModelRequest) => void;
}) {
  const { t } = useI18n();
  const [modelId, setModelId] = useState(model?.modelId ?? "");
  const [taskType, setTaskType] = useState<ModelTaskType>(model?.taskType ?? "writing");
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? "");
  const [maxOutputTokens, setMaxOutputTokens] = useState(model?.maxOutputTokens?.toString() ?? "");
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  return (
    <form className="supply__editor" onSubmit={(event) => {
      event.preventDefault();
      onSubmit({
        providerId, modelId: modelId.trim(), taskType,
        contextWindow: contextWindow ? Number(contextWindow) : null,
        maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null,
        sampling: model?.sampling ?? {}, capabilities: model?.capabilities ?? {}, enabled,
      });
    }}>
      <h3>{model ? t("settings.model.formTitleEdit") : t("settings.model.formTitleNew")}</h3>
      <label>{t("settings.model.modelIdLabel")}<input required value={modelId} onChange={(event) => setModelId(event.target.value)} /></label>
      <label>{t("settings.model.taskTypeLabel")}<select value={taskType} onChange={(event) => setTaskType(event.target.value as ModelTaskType)}>{TASK_TYPES.map((value) => <option key={value} value={value}>{assignmentRoleLabel(value)}</option>)}</select><span className="supply__field-hint">{t("settings.model.taskTypeHint")}</span></label>
      <label>{t("settings.model.contextLabel")}<input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder={t("settings.model.limitPlaceholder")} /></label>
      <label>{t("settings.model.outputLabel")}<input type="number" min="1" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder={t("settings.model.limitPlaceholder")} /></label>
      <label className="supply__check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t("common.action.enable")}</label>
      {error ? <ErrorNote error={error} title={t("settings.model.saveErrorTitle")} /> : null}
      <div className="supply__editor-actions"><button type="button" className="btn" onClick={onCancel}>{t("common.action.cancel")}</button><button type="submit" className="btn btn--primary" disabled={pending}>{pending ? t("common.state.saving") : t("common.action.save")}</button></div>
    </form>
  );
}

export function ModelCard({ model, onEdit, onDelete, onProbe, probePending, probeData, probeError }: {
  model: ModelConfigDto;
  onEdit: () => void;
  onDelete: () => void;
  onProbe: () => void;
  probePending: boolean;
  probeData: ProviderProbeResult | undefined;
  probeError: unknown;
}) {
  const { t } = useI18n();
  const lacksLimits = model.contextWindow === null || model.maxOutputTokens === null;
  return (
    <article className="supply__model" data-enabled={model.enabled} aria-label={t("settings.model.cardAria", { id: model.modelId })}>
      <div className="supply__model-head"><span className="supply__model-id">{model.modelId}</span><span className="supply__model-task">{assignmentRoleLabel(model.taskType)}</span></div>
      <div className="supply__model-meta">
        <span><strong>{model.contextWindow === null ? t("common.state.unknown") : model.contextWindow === 0 ? "0" : `${Math.round(model.contextWindow / 1000)}k`}</strong> {t("settings.model.context")}</span>
        <span><strong>{model.maxOutputTokens === null ? t("common.state.unknown") : model.maxOutputTokens === 0 ? "0" : `${Math.round(model.maxOutputTokens / 1000)}k`}</strong> {t("settings.model.output")}</span>
        <span>{model.enabled ? t("settings.state.enabled") : t("settings.state.disabled")}</span><span>{metadataSourceLabel(model.metadataSource)}</span>
        {model.metadataStale ? <span className="supply__warn">{t("settings.model.metadataStale")}</span> : null}
      </div>
      {lacksLimits && ["writing", "planning", "review"].includes(model.taskType) ? <p className="supply__model-missing">{t("settings.model.limitsMissing")}</p> : null}
      <div className="supply__item-actions supply__item-actions--model">
        <button type="button" className="btn" onClick={onProbe} disabled={probePending}><Radio size={12} /> {probePending ? t("settings.model.probing") : t("settings.model.probe")}</button>
        <button type="button" className="btn" onClick={onEdit}><Edit3 size={12} /> {t("common.action.edit")}</button>
        <button type="button" className="btn" onClick={onDelete}><Trash2 size={12} /> {t("common.action.delete")}</button>
      </div>
      {probeError ? <ErrorNote error={probeError} title={t("settings.model.probeErrorTitle")} /> : null}
      {probeData ? <ProbeReport result={probeData} /> : null}
    </article>
  );
}

function ProbeReport({ result }: { result: ProviderProbeResult }) {
  const { t } = useI18n();
  return (
    <div className="supply__probe"><p className="supply__probe-title">{t("settings.model.probeReportTitle")}</p><div className="supply__probe-body">
      {result.stages.map((stage) => <div key={stage.stage} className="supply__probe-row">
        <span className="supply__probe-stage">{probeStageLabel(stage.stage)}</span>
        <span className="supply__probe-status" data-s={stage.status}>{probeStageStatusLabel(stage.status)}</span>
        <span className="supply__probe-latency">{stage.latencyMs} ms</span>
        <span className="supply__probe-detail">{stage.detail}</span>
      </div>)}
    </div></div>
  );
}

