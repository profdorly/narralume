import { getLocale, translate, type MessageKey } from "../../i18n";
import type {
  AssignmentRole,
  ModelConfigDto,
  ModelTaskType,
  PublicProviderDto,
  WireApi,
} from "../../lib/api";

export const PRIMARY_ROLES: AssignmentRole[] = ["writing", "embedding"];
export const ADVANCED_ROLES: AssignmentRole[] = ["planning", "review"];
export const TASK_TYPES: ModelTaskType[] = [...PRIMARY_ROLES, ...ADVANCED_ROLES];
export const WIRE_APIS: WireApi[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
];

export const ROLE_KEYS: Record<
  AssignmentRole,
  { name: MessageKey; note: MessageKey }
> = {
  writing: {
    name: "settings.roles.writing.name",
    note: "settings.roles.writing.note",
  },
  planning: {
    name: "settings.roles.planning.name",
    note: "settings.roles.planning.note",
  },
  review: {
    name: "settings.roles.review.name",
    note: "settings.roles.review.note",
  },
  embedding: {
    name: "settings.roles.embedding.name",
    note: "settings.roles.embedding.note",
  },
  rerank: {
    name: "settings.roles.rerank.name",
    note: "settings.roles.rerank.note",
  },
};

export function roleCopy(role: AssignmentRole): { name: string; note: string } {
  const locale = getLocale();
  return {
    name: translate(locale, ROLE_KEYS[role].name),
    note: translate(locale, ROLE_KEYS[role].note),
  };
}

export type DeleteTarget =
  | { kind: "provider"; value: PublicProviderDto }
  | { kind: "model"; value: ModelConfigDto }
  | { kind: "assignment"; value: AssignmentRole };

export function modelDisplayName(
  model: ModelConfigDto | undefined,
  providers: PublicProviderDto[],
): string {
  const locale = getLocale();
  if (!model) return translate(locale, "settings.modelNames.unknownModel");
  const channelName =
    providers.find((provider) => provider.id === model.providerId)?.name ??
    translate(locale, "settings.modelNames.unknownChannel");
  return `${channelName} · ${model.modelId}`;
}

export function deleteDescription(target: DeleteTarget): string {
  const locale = getLocale();
  if (target.kind === "assignment") {
    const role = roleCopy(target.value).name;
    return target.value === "writing"
      ? translate(locale, "settings.confirm.unassignWriting", { role })
      : translate(locale, "settings.confirm.unassignOther", { role });
  }
  if (target.kind === "provider") {
    return translate(locale, "settings.confirm.deleteProvider", {
      name: target.value.name,
    });
  }
  return translate(locale, "settings.confirm.deleteModel", {
    name: target.value.modelId,
  });
}

export function safeProjectReturnPath(
  projectId: string | null,
  requestedPath: string | null,
): string {
  if (!projectId) return "/shelf";
  const projectRoot = `/projects/${encodeURIComponent(projectId)}/`;
  return requestedPath?.startsWith(projectRoot)
    ? requestedPath
    : `${projectRoot}overview`;
}
