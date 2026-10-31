import "../../styles/settings.css";
import "../../styles/supply.css";
import "../../styles/delivery.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, Edit3, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorNote } from "../../components/error-note";
import { PageBand } from "../../components/page-band";
import { Skeleton } from "../../components/skeleton";
import { LOCALES, LOCALE_LABELS, useI18n } from "../../i18n";
import {
  createModel,
  createProvider,
  deleteAssignment,
  deleteModel,
  deleteProvider,
  getProjects,
  listAssignments,
  listModels,
  listProviders,
  probeProvider,
  setAssignment,
  updateModel,
  updateProvider,
  type AssignmentRole,
  type ModelConfigDto,
  type PublicProviderDto,
  type UpsertModelRequest,
  type UpsertProviderRequest,
} from "../../lib/api";
import { shortId } from "../../lib/fmt";
import { wireApiLabel } from "../../lib/labels";
import { projectWorkspacePath } from "../../lib/project-route";
import { ProductionTools } from "../delivery/production-tools";
import { SystemBackupsSection } from "./backups";
import {
  ADVANCED_ROLES,
  PRIMARY_ROLES,
  deleteDescription,
  safeProjectReturnPath,
  type DeleteTarget,
} from "./constants";
import { DriverSwitch, useDriverMode } from "./driver-switch";
import { PromptTemplatesSection } from "./prompt-templates";
import { ModelCard, ModelForm, ProviderForm } from "./provider-forms";
import { RoleCard } from "./role-card";

/* 设置：默认生成模型与岗位继承（写作/规划/审稿在未覆盖时继承默认生成模型）、
   Provider/模型/派岗管理、高级工具（运行中心/长篇推演链接、生产资产、系统备份档）。 */

export function SettingsWorkspace() {
  const queryClient = useQueryClient();
  const { locale, setLocale, t } = useI18n();
  const [searchParams] = useSearchParams();
  const contextProjectId = searchParams.get("project");
  const requestedReturnPath = searchParams.get("return");
  const returnPath = safeProjectReturnPath(contextProjectId, requestedReturnPath);
  const driverMode = useDriverMode();
  const [requestedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [providerEditor, setProviderEditor] = useState<PublicProviderDto | "new" | null>(null);
  const [modelEditor, setModelEditor] = useState<ModelConfigDto | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toolsProjectId, setToolsProjectId] = useState<string | null>(null);

  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: ({ signal }) => listProviders(signal),
    staleTime: 5_000,
  });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: ({ signal }) => listModels(undefined, signal),
    staleTime: 5_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ["assignments"],
    queryFn: ({ signal }) => listAssignments(signal),
    staleTime: 5_000,
  });
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => getProjects(signal),
  });

  const providers = useMemo(() => providersQuery.data ?? [], [providersQuery.data]);
  const allModels = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);
  const assignments = useMemo(() => assignmentsQuery.data ?? [], [assignmentsQuery.data]);
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const preferredProjectId = toolsProjectId ?? contextProjectId;
  const toolsProject = projects.find((project) => project.id === preferredProjectId) ?? projects[0] ?? null;

  const selectedProviderId = providers.some((provider) => provider.id === requestedProviderId)
    ? requestedProviderId
    : providers[0]?.id ?? null;

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const models = allModels.filter((model) => model.providerId === selectedProviderId);
  const currentProviderEditor = providerEditor === "new" || providerEditor === null
    ? providerEditor
    : providers.find((provider) => provider.id === providerEditor.id) ?? providerEditor;
  const currentModelEditor = modelEditor === "new" || modelEditor === null
    ? modelEditor
    : allModels.find((model) => model.id === modelEditor.id) ?? modelEditor;

  const providerMutation = useMutation({
    mutationFn: (input: { current: PublicProviderDto | null; value: UpsertProviderRequest }) =>
      input.current
        ? updateProvider(input.current.id, {
            ...input.value,
            expectedUpdatedAt: input.current.updatedAt,
          })
        : createProvider(input.value),
    onSuccess: (provider) => {
      setProviderEditor(null);
      setSelectedProviderId(provider.id);
      setNotice(t("settings.notices.providerSaved"));
      void queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: ["providers"] }),
  });
  const modelMutation = useMutation({
    mutationFn: (input: { current: ModelConfigDto | null; value: UpsertModelRequest }) =>
      input.current
        ? updateModel(input.current.id, {
            ...input.value,
            expectedUpdatedAt: input.current.updatedAt,
          })
        : createModel(input.value),
    onSuccess: () => {
      setModelEditor(null);
      setNotice(t("settings.notices.modelSaved"));
      void queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: ["models"] }),
  });
  const assignMutation = useMutation({
    mutationFn: (input: { role: AssignmentRole; modelId: string }) =>
      setAssignment(input.role, input.modelId),
    onSuccess: () => {
      setNotice(t("settings.notices.assignmentSaved"));
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
    },
  });
  const removeMutation = useMutation({
    mutationFn: async (target: DeleteTarget) => {
      if (target.kind === "provider") await deleteProvider(target.value.id);
      if (target.kind === "model") await deleteModel(target.value.id);
      if (target.kind === "assignment") await deleteAssignment(target.value);
      return target;
    },
    onSuccess: (target) => {
      setDeleteTarget(null);
      setNotice(target.kind === "assignment" ? t("settings.notices.assignmentRemoved") : t("settings.notices.recordDeleted"));
      if (target.kind === "provider") {
        setSelectedProviderId(null);
        void queryClient.invalidateQueries({ queryKey: ["providers"] });
      }
      if (target.kind === "model") void queryClient.invalidateQueries({ queryKey: ["models"] });
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
    },
  });
  const probeMutation = useMutation({
    mutationFn: (input: { providerId: string; modelId: string }) => probeProvider(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["models"] }),
  });

  const writingAssignment = assignments.find((entry) => entry.role === "writing");
  const enabledProviderIds = new Set(
    providers.filter((provider) => provider.enabled).map((provider) => provider.id),
  );
  const assignable = (model: ModelConfigDto) => model.enabled && enabledProviderIds.has(model.providerId);
  const generationModels = allModels.filter(
    (model) => assignable(model) && ["writing", "planning", "review"].includes(model.taskType),
  );
  const assignmentSourcesPending =
    providersQuery.isPending || modelsQuery.isPending || assignmentsQuery.isPending;
  const assignmentSourcesError =
    providersQuery.error ?? modelsQuery.error ?? assignmentsQuery.error;
  const renderRole = (role: AssignmentRole) => {
    const assignment = assignments.find((entry) => entry.role === role);
    return (
      <RoleCard
        key={role}
        role={role}
        assignedModel={assignment ? allModels.find((model) => model.id === assignment.modelId) : undefined}
        assignmentModelId={assignment?.modelId}
        inheritedModel={role === "planning" || role === "review" ? allModels.find((model) => model.id === writingAssignment?.modelId) : undefined}
        inherited={role === "planning" || role === "review"}
        providers={providers}
        candidates={role === "embedding" || role === "rerank"
          ? allModels.filter((model) => assignable(model) && model.taskType === role)
          : generationModels}
        pending={assignMutation.isPending && assignMutation.variables?.role === role}
        error={assignMutation.variables?.role === role ? assignMutation.error : null}
        onAssign={(modelId) => assignMutation.mutate({ role, modelId })}
        onRemove={() => setDeleteTarget({ kind: "assignment", value: role })}
      />
    );
  };

  return (
    <div className="settings">
      <PageBand
        index={t("settings.pageIndex")}
        title={t("settings.title")}
        meta={
          <span className="settings__band-meta">
            {contextProjectId ? <Link to={returnPath}><ArrowLeft size={12} aria-hidden="true" />{t("settings.backToProject")}</Link> : null}
            <span className="mono">
              {t("settings.band.counts", {
                providers: providers.length,
                models: allModels.length,
                status: writingAssignment ? t("settings.band.defaultSet") : t("settings.band.defaultUnset"),
              })}
            </span>
          </span>
        }
      />
      {notice ? <p className="settings__notice" role="status" aria-live="polite">{notice}</p> : null}

      <section className="settings__section" aria-label={t("settings.uiLanguage.label")}>
        <header className="settings__section-head">
          <div><p className="mono">{t("settings.uiLanguage.eyebrow")}</p><h2>{t("settings.uiLanguage.label")}</h2></div>
          <p className="settings__section-note">{t("settings.uiLanguage.hint")}</p>
        </header>
        <div className="settings__language">
          {LOCALES.map((option) => (
            <button
              key={option}
              type="button"
              className="settings__language-option"
              data-active={option === locale ? "true" : "false"}
              aria-pressed={option === locale}
              onClick={() => setLocale(option)}
            >
              {LOCALE_LABELS[option]}
            </button>
          ))}
        </div>
      </section>

      <section className="settings__section" aria-label={t("settings.generation.label")}>
        <header className="settings__section-head">
          <div><p className="mono">{t("settings.generation.eyebrow")}</p><h2>{t("settings.generation.label")}</h2></div>
          <p className="settings__section-note">{t("settings.generation.hint")}</p>
        </header>
        <div className="settings__roles">
          {assignmentSourcesPending ? <Skeleton lines={3} /> : assignmentSourcesError ? (
            <ErrorNote error={assignmentSourcesError} title={t("settings.generation.loadError")} />
          ) : PRIMARY_ROLES.map(renderRole)}
        </div>
        {!assignmentSourcesPending && !assignmentSourcesError ? (
          <details className="settings__advanced-roles">
            <summary>{t("settings.generation.advancedSummary")}</summary>
            <p>{t("settings.generation.advancedHint")}</p>
            <div className="settings__roles">{ADVANCED_ROLES.map(renderRole)}</div>
          </details>
        ) : null}
      </section>

      <PromptTemplatesSection />

      <details className="settings__channel-management" aria-label={t("settings.channels.label")}>
        <summary>
          <span className="settings__channel-summary-copy">
            <span className="mono">{t("settings.channels.eyebrow")}</span>
            <strong>{t("settings.channels.label")}</strong>
            <span>{t("settings.channels.summaryHint")}</span>
          </span>
          <span className="settings__channel-summary-meta mono">
            {t("settings.channels.counts", { providers: providers.length, models: allModels.length })}
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <p className="settings__channel-note">{t("settings.channels.note")}</p>
        <div className="supply__layout">
        <section className="supply__column" aria-label={t("settings.channels.providersLabel")}>
          <header className="supply__column-head">
            <span className="supply__column-eyebrow">{t("settings.channels.providerEyebrow")}</span>
            <p className="supply__column-title">{t("settings.channels.providersLabel")}</p>
            <button type="button" className="supply__mini-action" onClick={() => setProviderEditor("new")}>
              <Plus size={12} aria-hidden="true" /> {t("settings.channels.add")}
            </button>
          </header>
          <div className="supply__column-body">
            {currentProviderEditor ? (
              <ProviderForm
                key={currentProviderEditor === "new" ? "new" : currentProviderEditor.id}
                provider={currentProviderEditor === "new" ? null : currentProviderEditor}
                pending={providerMutation.isPending}
                error={providerMutation.error}
                onCancel={() => setProviderEditor(null)}
                onSubmit={(value) => providerMutation.mutate({ current: currentProviderEditor === "new" ? null : currentProviderEditor, value })}
              />
            ) : null}
            {providersQuery.isPending ? <Skeleton lines={4} /> : providersQuery.isError ? (
              <ErrorNote error={providersQuery.error} title={t("settings.channels.providersLoadError")} />
            ) : providers.length === 0 ? (
              <p className="supply__empty">{t("settings.channels.emptyProviders")}</p>
            ) : providers.map((provider) => (
              <div key={provider.id} className="supply__provider-wrap" data-active={provider.id === selectedProviderId}>
                <button type="button" className="supply__provider" onClick={() => setSelectedProviderId(provider.id)}>
                  <span className="supply__provider-name">{provider.name}</span>
                  <span className="supply__provider-kind">{wireApiLabel(provider.wireApi)}</span>
                  <span className="supply__provider-base mono">{provider.baseUrl}</span>
                  <span className="supply__provider-foot">
                    <span className="supply__provider-status" data-on={provider.enabled}>{provider.enabled ? t("settings.state.enabled") : t("settings.state.disabled")}</span>
                    <span>{t("settings.channels.modelCount", { count: allModels.filter((model) => model.providerId === provider.id).length })}</span>
                  </span>
                </button>
                <div className="supply__item-actions">
                  <button type="button" className="supply__icon-action" aria-label={t("settings.channels.editProviderAria", { name: provider.name })} onClick={() => setProviderEditor(provider)}><Edit3 size={13} /></button>
                  <button type="button" className="supply__icon-action" aria-label={t("settings.channels.deleteProviderAria", { name: provider.name })} onClick={() => setDeleteTarget({ kind: "provider", value: provider })}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="supply__column" aria-label={t("settings.channels.modelsLabel")}>
          <header className="supply__column-head">
            <span className="supply__column-eyebrow">{t("settings.channels.modelEyebrow")}</span>
            <p className="supply__column-title">{selectedProvider ? t("settings.channels.modelsTitle", { name: selectedProvider.name }) : t("settings.channels.modelsTitleEmpty")}</p>
            <button type="button" className="supply__mini-action" disabled={!selectedProvider} onClick={() => setModelEditor("new")}>
              <Plus size={12} aria-hidden="true" /> {t("settings.channels.add")}
            </button>
          </header>
          <div className="supply__column-body">
            {currentModelEditor && selectedProvider ? (
              <ModelForm
                key={currentModelEditor === "new" ? `new-${selectedProvider.id}` : currentModelEditor.id}
                providerId={selectedProvider.id}
                model={currentModelEditor === "new" ? null : currentModelEditor}
                pending={modelMutation.isPending}
                error={modelMutation.error}
                onCancel={() => setModelEditor(null)}
                onSubmit={(value) => modelMutation.mutate({ current: currentModelEditor === "new" ? null : currentModelEditor, value })}
              />
            ) : null}
            {!selectedProvider ? <p className="supply__empty">{t("settings.channels.emptyPickProvider")}</p> : modelsQuery.isPending ? (
              <Skeleton lines={4} />
            ) : modelsQuery.isError ? <ErrorNote error={modelsQuery.error} title={t("settings.channels.modelsLoadError")} /> : models.length === 0 ? (
              <p className="supply__empty">{t("settings.channels.emptyModels")}</p>
            ) : models.map((model) => (
              <ModelCard
                key={model.id}
                model={model}
                onEdit={() => setModelEditor(model)}
                onDelete={() => setDeleteTarget({ kind: "model", value: model })}
                onProbe={() => probeMutation.mutate({ providerId: model.providerId, modelId: model.id })}
                probePending={probeMutation.isPending && probeMutation.variables?.modelId === model.id}
                probeData={probeMutation.data?.modelId === model.id ? probeMutation.data : undefined}
                probeError={probeMutation.variables?.modelId === model.id ? probeMutation.error : null}
              />
            ))}
          </div>
        </section>
        </div>
      </details>

      <section className="settings__section" aria-label={t("settings.tools.label")}>
        <header className="settings__section-head">
          <div><p className="mono">{t("settings.tools.eyebrow")}</p><h2>{t("settings.tools.label")}</h2></div>
          <p className="settings__section-note">
            {t("settings.tools.hintFull")}
          </p>
        </header>
        <div className="settings__tools-links">
          {projectsQuery.isPending ? (
            <Skeleton lines={2} />
          ) : projectsQuery.isError ? (
            <ErrorNote error={projectsQuery.error} title={t("settings.tools.projectsLoadError")} />
          ) : toolsProject ? (
            <>
              <Link className="settings__tool-link" to={projectWorkspacePath(toolsProject.id, "runs")}>{t("settings.tools.runsLink", { title: toolsProject.title })}</Link>
              <Link className="settings__tool-link" to={projectWorkspacePath(toolsProject.id, "lab")}>{t("settings.tools.labLink", { title: toolsProject.title })}</Link>
            </>
          ) : (
            <p className="supply__empty">{t("settings.tools.emptyProjects")}</p>
          )}
          {!projectsQuery.isPending && !projectsQuery.isError && projects.length > 0 ? (
            <label className="settings__project-pick">
              {t("settings.tools.assetProjectLabel")}
              <select value={toolsProject?.id ?? ""} onChange={(event) => setToolsProjectId(event.target.value || null)}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.title}{project.subtitle ? ` · ${project.subtitle}` : ""} · {shortId(project.id)}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {!projectsQuery.isPending && !projectsQuery.isError && toolsProject ? (
          <ProductionTools key={toolsProject.id} projectId={toolsProject.id} />
        ) : null}
      </section>

      <section className="settings__section" aria-label={t("settings.driver.label")}>
        <header className="settings__section-head">
          <div><p className="mono">{t("settings.driver.eyebrow")}</p><h2>{t("settings.driver.label")}</h2></div>
          <p className="settings__section-note">
            {t("settings.driver.note", {
              mode: driverMode === "local"
                ? t("settings.driver.modeLocal")
                : driverMode === "server"
                  ? t("settings.driver.modeServer")
                  : t("settings.driver.modeProbing"),
            })}
          </p>
        </header>
        <DriverSwitch />
      </section>

      <SystemBackupsSection />

      {deleteTarget ? (
        <ConfirmDialog
          title={deleteTarget.kind === "assignment" ? t("settings.confirm.unassignTitle") : t("settings.confirm.deleteTitle")}
          confirmLabel={deleteTarget.kind === "assignment" ? t("settings.confirm.unassignAction") : t("common.action.delete")}
          danger
          pending={removeMutation.isPending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => removeMutation.mutate(deleteTarget)}
        >
          <p>{deleteDescription(deleteTarget)}</p>
          {removeMutation.isError ? <ErrorNote error={removeMutation.error} title={t("settings.confirm.errorTitle")} /> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
