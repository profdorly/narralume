import { Network, Unplug } from "lucide-react";

import { ErrorNote } from "../../components/error-note";
import { useI18n } from "../../i18n";
import type { AssignmentRole, ModelConfigDto, PublicProviderDto } from "../../lib/api";
import { modelDisplayName, roleCopy } from "./constants";

/* ---- 岗位卡：含继承语义的生成模型岗 ------------------------------------------- */

export function RoleCard({ role, assignedModel, assignmentModelId, inheritedModel, inherited, providers, candidates, pending, error, onAssign, onRemove }: {
  role: AssignmentRole;
  assignedModel: ModelConfigDto | undefined;
  assignmentModelId: string | undefined;
  inheritedModel: ModelConfigDto | undefined;
  inherited: boolean;
  providers: PublicProviderDto[];
  candidates: ModelConfigDto[];
  pending: boolean;
  error: unknown;
  onAssign: (modelId: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const inheritedActive = inherited && !assignmentModelId && inheritedModel;
  return (
    <div className="supply__role" role="group" aria-label={roleCopy(role).name}>
      <div className="supply__role-head">
        <span className="supply__role-name">{roleCopy(role).name}</span>
        <span className="supply__role-status" data-ready={Boolean(assignmentModelId) || Boolean(inheritedActive)}>
          {assignmentModelId ? t("settings.roleCard.statusAssigned") : inheritedActive ? t("settings.roleCard.statusInherited") : t("settings.roleCard.statusPending")}
        </span>
      </div>
      <p className="supply__role-description">{roleCopy(role).note}</p>
      <div className="supply__role-model" data-unset={!assignmentModelId}>
        {assignedModel ? <><strong>{modelDisplayName(assignedModel, providers)}</strong> · {assignedModel.enabled ? t("settings.state.enabled") : t("settings.state.disabled")}</> : assignmentModelId ? <>{t("settings.roleCard.staleConfig")}</> : inheritedActive ? <>{t("settings.roleCard.inheritFrom", { name: modelDisplayName(inheritedModel, providers) })}</> : <>{t("settings.roleCard.notConnected")}</>}
      </div>
      <div className="supply__role-actions">
        {candidates.map((model) => <button key={model.id} type="button" className="supply__role-assign-btn" disabled={pending || model.id === assignmentModelId} onClick={() => onAssign(model.id)}><Network size={12} /> {modelDisplayName(model, providers)}</button>)}
        {assignmentModelId ? <button type="button" className="supply__role-assign-btn" disabled={pending} onClick={onRemove}><Unplug size={12} /> {inherited ? t("settings.roleCard.unassignOverride") : t("settings.roleCard.unassign")}</button> : null}
      </div>
      {candidates.length === 0 ? <p className="supply__role-empty">{t("settings.roleCard.emptyCandidates")}</p> : null}
      {error ? <ErrorNote error={error} title={t("settings.roleCard.assignError")} /> : null}
    </div>
  );
}

