import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n, type MessageKey } from "../../i18n";
import {
  listAssignments,
  listModels,
  listProviders,
  type AssistantConversationDto,
} from "../../lib/api";

const ASSISTANT_EFFORT_LEVELS = ["off", "low", "medium", "high"] as const;

type AssistantEffortLevel = (typeof ASSISTANT_EFFORT_LEVELS)[number];

const ASSISTANT_EFFORT_LABEL_KEYS: Record<AssistantEffortLevel, MessageKey> = {
  off: "assistant.effort.off",
  low: "assistant.effort.low",
  medium: "assistant.effort.medium",
  high: "assistant.effort.high",
};

/**
 * Model pill above the composer: switch models within the same protocol +
 * conversation-level reasoning tier.
 */
export function AssistantModelControls({
  conversation,
  disabled,
  pending,
  onConfigure,
}: {
  conversation: AssistantConversationDto | null;
  disabled: boolean;
  pending: boolean;
  onConfigure: (input: {
    modelId?: string | null;
    reasoningEffort?: string | null;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { t } = useI18n();
  /* The pill shows the effective model name even when closed, so the list is
     always fetched (staleTime suppresses repeats). */
  const providersQuery = useQuery({
    queryKey: ["assistant-models", "providers"],
    queryFn: ({ signal }) => listProviders(signal),
    staleTime: 30_000,
  });
  const modelsQuery = useQuery({
    queryKey: ["assistant-models", "models"],
    queryFn: ({ signal }) => listModels(undefined, signal),
    staleTime: 30_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ["assistant-models", "assignments"],
    queryFn: ({ signal }) => listAssignments(signal),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const providers = useMemo(
    () => providersQuery.data ?? [],
    [providersQuery.data],
  );
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const modelById = useMemo(
    () => new Map(models.map((model) => [model.id, model])),
    [models],
  );
  const settings = conversation?.settings ?? {
    modelId: null,
    reasoningEffort: null,
  };
  const overrideModel = settings.modelId
    ? (modelById.get(settings.modelId) ?? null)
    : null;
  const writingAssignment = (assignmentsQuery.data ?? []).find(
    (assignment) => assignment.role === "writing",
  );
  const defaultModel = writingAssignment
    ? (modelById.get(writingAssignment.modelId) ?? null)
    : null;
  const effectiveModel = overrideModel ?? defaultModel;
  const effectiveProvider = effectiveModel
    ? (providerById.get(effectiveModel.providerId) ?? null)
    : null;
  /* Only same-protocol models appear in a conversation: to cross protocol
     families, change the default generation model in Settings. */
  const candidates = useMemo(
    () =>
      effectiveProvider
        ? models.filter((model) => {
            const provider = providerById.get(model.providerId);
            return (
              model.enabled &&
              model.taskType === "writing" &&
              provider?.enabled &&
              provider.wireApi === effectiveProvider.wireApi
            );
          })
        : [],
    [models, providerById, effectiveProvider],
  );
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof candidates>();
    for (const model of candidates) {
      const key = providerById.get(model.providerId)?.name ?? model.providerId;
      groups.set(key, [...(groups.get(key) ?? []), model]);
    }
    return [...groups.entries()];
  }, [candidates, providerById]);
  const effort = settings.reasoningEffort ?? "low";

  return (
    <div ref={rootRef} className="assistant-model">
      <button
        type="button"
        className="assistant-model__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("assistant.model.label")}
        disabled={disabled || pending}
        onClick={() => setOpen((value) => !value)}
      >
        <Cpu size={13} strokeWidth={1.6} aria-hidden="true" />
        <span className="assistant-model__name">
          {effectiveModel
            ? effectiveModel.modelId
            : t("assistant.model.unconfiguredDefault")}
        </span>
        {overrideModel ? null : (
          <span className="assistant-model__default mono">{t("assistant.model.defaultBadge")}</span>
        )}
        <span className="assistant-model__effort mono">
          {t("assistant.model.effortTag", { effort: t(ASSISTANT_EFFORT_LABEL_KEYS[effort]) })}
        </span>
        <ChevronDown size={13} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="assistant-model__menu"
          role="dialog"
          aria-label={t("assistant.model.label")}
        >
          <p className="assistant-model__section mono">{t("assistant.model.sectionModel")}</p>
          <div role="listbox" aria-label={t("assistant.model.listboxLabel")}>
            <button
              type="button"
              role="option"
              aria-selected={!settings.modelId}
              className="assistant-model__item"
              onClick={() => {
                setOpen(false);
                onConfigure({ modelId: null });
              }}
            >
              {t("assistant.model.followDefault")}
              {defaultModel ? ` · ${defaultModel.modelId}` : t("assistant.model.noDefault")}
            </button>
            {grouped.map(([providerName, groupModels]) => (
              <div
                key={providerName}
                className="assistant-model__group"
                role="group"
                aria-label={providerName}
              >
                <p className="assistant-model__provider mono">{providerName}</p>
                {groupModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={settings.modelId === model.id}
                    className="assistant-model__item"
                    onClick={() => {
                      setOpen(false);
                      onConfigure({ modelId: model.id });
                    }}
                  >
                    {model.modelId}
                  </button>
                ))}
              </div>
            ))}
            {open && (providersQuery.isPending || modelsQuery.isPending) ? (
              <p className="assistant-conv__empty">{t("assistant.model.loadingModels")}</p>
            ) : candidates.length === 0 ? (
              <p className="assistant-conv__empty">
                {t("assistant.model.noSameProtocol")}
              </p>
            ) : null}
          </div>
          <p className="assistant-model__section mono">{t("assistant.model.sectionEffort")}</p>
          <div className="assistant-model__efforts">
            {ASSISTANT_EFFORT_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={effort === level}
                className="assistant-model__effort-option"
                onClick={() =>
                  onConfigure({ reasoningEffort: level as string })
                }
              >
                {effort === level ? (
                  <Check size={12} strokeWidth={1.8} aria-hidden="true" />
                ) : null}
                {t(ASSISTANT_EFFORT_LABEL_KEYS[level])}
              </button>
            ))}
          </div>
          <p className="assistant-model__note">
            {t("assistant.model.note", { api: effectiveProvider?.wireApi ?? "—" })}
          </p>
        </div>
      ) : null}
    </div>
  );
}
