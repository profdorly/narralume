import { sha256Hex } from "@narralume/domain";
import { estimateTokens } from "@narralume/context";
import type {
  NarrativeRun,
  RunBudgetUsage,
  RunStepError,
} from "@narralume/domain";
import {
  ModelError,
  StructuredOutputError,
  type ModelCallTiming,
  type ModelProtocol,
  type ModelRequest,
  type NormalizedUsage,
  type StructuredMode,
} from "@narralume/llm";
import {
  type AssignmentRole,
  type StoredModel,
  type StoredProvider,
} from "@narralume/persistence";

import {
  type CandidateRuntime,
  isBooleanRecord,
  isRecordValue,
  isStringRecord,
  modelStepError,
  nullablePositiveInteger,
  policyFieldSource,
  positiveInteger,
  samplingFromRequest,
} from "./transport.js";

export type ModelRole =
  "planning" | "drafting" | "review" | "revision" | "settlement" | "analysis";

export function budgetUsage(
  usage: NormalizedUsage,
  wallTimeMs: number,
  calls = 1,
  pricing: ModelPricing | null = null,
): RunBudgetUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    calls,
    costUsd: pricing
      ? ((usage.inputTokens - usage.cachedInputTokens) * pricing.input +
          usage.cachedInputTokens * pricing.cachedInput +
          usage.outputTokens * pricing.output) /
        1_000_000
      : 0,
    wallTimeMs,
  };
}

export interface ModelPricing {
  input: number;
  output: number;
  cachedInput: number;
}

/** Maps the six narrative model roles onto the five assignment roles. */
export const ASSIGNMENT_ROLE_FOR_ROLE: Record<ModelRole, AssignmentRole> = {
  planning: "planning",
  review: "review",
  drafting: "writing",
  revision: "writing",
  settlement: "writing",
  analysis: "writing",
};

export function modelRoleForPurpose(purpose: string): ModelRole {
  const normalized = purpose.toLocaleLowerCase();
  if (normalized.includes("review") || normalized.includes("check"))
    return "review";
  if (normalized.includes("revision") || normalized.includes("edit"))
    return "revision";
  if (normalized.includes("settle") || normalized.includes("extract"))
    return "settlement";
  if (normalized.includes("plan") || normalized.includes("outline"))
    return "planning";
  if (normalized.includes("analy") || normalized.includes("import"))
    return "analysis";
  return "drafting";
}

export interface AppliedModelRuntime extends Record<string, unknown> {
  protocol: ModelProtocol;
  providerId: string;
  contextWindow: number;
  policyContextWindow: number;
  modelContextWindow: number;
  estimatedInputRawTokens: number;
  estimatedInputTokens: number;
  inputSafetyTokens: number;
  contextWindowPolicySource: string;
  contextWindowAppliedBy: "policy" | "model";
  requestedMaxOutputTokens: number | null;
  roleMaxOutputTokens: number | null;
  modelMaxOutputTokens: number;
  maxOutputTokens: number;
  roleMaxOutputTokensSource: string;
  maxOutputTokensAppliedBy: readonly string[];
  remainingContextTokens: number;
  modelMetadataSource: StoredModel["metadataSource"] | null;
  modelMetadataVerifiedAt: string | null;
  sampling: Readonly<Record<string, unknown>>;
  capabilities: Readonly<Record<string, boolean>>;
  structuredTier?: string;
  structuredTierPlan?: readonly StructuredMode[];
}

export function frozenStoredModel(
  current: StoredModel,
  snapshot: Readonly<Record<string, unknown>>,
): StoredModel {
  const taskType = [
    "writing",
    "planning",
    "review",
    "embedding",
    "rerank",
  ].includes(String(snapshot.taskType))
    ? (snapshot.taskType as StoredModel["taskType"])
    : current.taskType;
  const metadataSource = [
    "manual",
    "environment",
    "catalog",
    "migration",
  ].includes(String(snapshot.metadataSource))
    ? (snapshot.metadataSource as StoredModel["metadataSource"])
    : current.metadataSource;
  return {
    ...current,
    providerId:
      typeof snapshot.providerId === "string"
        ? snapshot.providerId
        : current.providerId,
    modelId:
      typeof snapshot.modelId === "string" ? snapshot.modelId : current.modelId,
    taskType,
    contextWindow:
      typeof snapshot.contextWindow === "number"
        ? snapshot.contextWindow
        : current.contextWindow,
    maxOutputTokens:
      typeof snapshot.maxOutputTokens === "number"
        ? snapshot.maxOutputTokens
        : current.maxOutputTokens,
    sampling: isRecordValue(snapshot.sampling)
      ? snapshot.sampling
      : current.sampling,
    capabilities: isBooleanRecord(snapshot.capabilities)
      ? snapshot.capabilities
      : current.capabilities,
    metadataSource,
    metadataVerifiedAt:
      typeof snapshot.metadataVerifiedAt === "string"
        ? snapshot.metadataVerifiedAt
        : snapshot.metadataVerifiedAt === null
          ? null
          : current.metadataVerifiedAt,
    enabled:
      typeof snapshot.enabled === "boolean"
        ? snapshot.enabled
        : current.enabled,
    createdAt:
      typeof snapshot.createdAt === "string"
        ? snapshot.createdAt
        : current.createdAt,
    updatedAt:
      typeof snapshot.updatedAt === "string"
        ? snapshot.updatedAt
        : current.updatedAt,
  };
}

/**
 * Reuses the immutable transport configuration from the first purpose call
 * while resolving the current credential secret from storage. Credentials
 * are deliberately absent from snapshots, and a later provider/model disable
 * still stops new I/O.
 */
export function frozenStoredProvider(
  current: StoredProvider,
  snapshot: Readonly<Record<string, unknown>>,
): StoredProvider {
  const wireApi = [
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
  ].includes(String(snapshot.wireApi))
    ? (snapshot.wireApi as StoredProvider["wireApi"])
    : current.wireApi;
  return {
    ...current,
    name: typeof snapshot.name === "string" ? snapshot.name : current.name,
    wireApi,
    baseUrl:
      typeof snapshot.baseUrl === "string" ? snapshot.baseUrl : current.baseUrl,
    endpoint:
      typeof snapshot.endpoint === "string" || snapshot.endpoint === null
        ? snapshot.endpoint
        : current.endpoint,
    credentialRef: current.credentialRef,
    anthropicVersion:
      typeof snapshot.anthropicVersion === "string" ||
      snapshot.anthropicVersion === null
        ? snapshot.anthropicVersion
        : current.anthropicVersion,
    headers: isStringRecord(snapshot.headers)
      ? snapshot.headers
      : current.headers,
    queryParams: isStringRecord(snapshot.queryParams)
      ? snapshot.queryParams
      : current.queryParams,
    requestStartTimeoutMs: nullablePositiveInteger(
      snapshot.requestStartTimeoutMs,
      current.requestStartTimeoutMs,
    ),
    streamIdleTimeoutMs: nullablePositiveInteger(
      snapshot.streamIdleTimeoutMs,
      current.streamIdleTimeoutMs,
    ),
    enabled: current.enabled,
    createdAt:
      typeof snapshot.createdAt === "string"
        ? snapshot.createdAt
        : current.createdAt,
    updatedAt:
      typeof snapshot.updatedAt === "string"
        ? snapshot.updatedAt
        : current.updatedAt,
  };
}

export function snapshotRuntime(
  run: NarrativeRun,
  purpose: string,
  request: ModelRequest,
  runtime: CandidateRuntime,
  structured: {
    structuredTier?: string;
    structuredTierPlan?: readonly StructuredMode[];
  } = {},
  requestedMaxOutputTokens: number | null = null,
): AppliedModelRuntime {
  const policyContextWindow =
    positiveInteger(run.policy.contextWindow) ?? 64_000;
  const modelContextWindow = runtime.modelContextWindow ?? policyContextWindow;
  const modelMaxOutputTokens =
    runtime.modelMaxOutputTokens ?? request.maxOutputTokens!;
  const contextWindow = Math.min(policyContextWindow, modelContextWindow);
  const estimate = requestTokenEstimate(request, contextWindow);
  const remainingContextTokens =
    contextWindow - estimate.conservative - estimate.safety;
  const finalOutputTokens = request.maxOutputTokens!;
  const roleLimit = roleOutputLimit(run, purpose);
  const appliedBy = [
    ...(requestedMaxOutputTokens === finalOutputTokens ? ["purpose"] : []),
    ...(roleLimit === finalOutputTokens ? ["role-policy"] : []),
    ...(modelMaxOutputTokens === finalOutputTokens ? ["model"] : []),
    ...(remainingContextTokens === finalOutputTokens
      ? ["remaining-context"]
      : []),
  ];
  return {
    protocol: runtime.protocol,
    providerId: runtime.providerId,
    contextWindow,
    policyContextWindow,
    modelContextWindow,
    estimatedInputRawTokens: estimate.raw,
    estimatedInputTokens: estimate.conservative,
    inputSafetyTokens: estimate.safety,
    contextWindowPolicySource: policyFieldSource(run, "contextWindow"),
    contextWindowAppliedBy:
      modelContextWindow < policyContextWindow ? "model" : "policy",
    requestedMaxOutputTokens,
    roleMaxOutputTokens: roleLimit,
    modelMaxOutputTokens,
    maxOutputTokens: finalOutputTokens,
    roleMaxOutputTokensSource: policyFieldSource(
      run,
      roleOutputPolicyKey(purpose),
    ),
    maxOutputTokensAppliedBy: appliedBy,
    remainingContextTokens,
    modelMetadataSource: runtime.metadataSource,
    modelMetadataVerifiedAt: runtime.metadataVerifiedAt,
    sampling: samplingFromRequest(request),
    capabilities: runtime.capabilities,
    ...structured,
  };
}

export function estimateRequestInputTokens(request: ModelRequest): number {
  const content = [
    request.instructions ?? "",
    stableJson(request.messages),
    stableJson(request.tools ?? []),
    stableJson(request.responseSchema ?? null),
  ].join("\n");
  return estimateTokens(content);
}

export function requestTokenEstimate(
  request: ModelRequest,
  contextWindow: number,
): { raw: number; conservative: number; safety: number } {
  const raw = estimateRequestInputTokens(request);
  // Unknown compatible endpoints do not expose a reliable count API. Keep a
  // modest wrapper/tokenizer margin instead of maintaining a home-grown full
  // tokenizer, then retain a separate context safety band.
  const conservative = Math.ceil(raw * 1.12) + 256;
  const safety = Math.max(1_024, Math.ceil(contextWindow * 0.02));
  return { raw, conservative, safety };
}

export function tokenEstimateDetails(
  request: ModelRequest,
  usage: NormalizedUsage,
): Record<string, unknown> {
  const raw = estimateRequestInputTokens(request);
  const estimated = Math.ceil(raw * 1.12) + 256;
  return {
    estimatedInputTokens: estimated,
    actualInputTokens: usage.inputTokens,
    inputEstimateErrorTokens: usage.inputTokens - estimated,
    inputEstimateErrorRatio:
      usage.inputTokens === 0
        ? null
        : Number(
            ((estimated - usage.inputTokens) / usage.inputTokens).toFixed(4),
          ),
  };
}

export function roleOutputLimit(
  run: NarrativeRun,
  purpose: string,
): number | null {
  return positiveInteger(run.policy[roleOutputPolicyKey(purpose)]);
}

export function roleOutputPolicyKey(purpose: string): string {
  const role = modelRoleForPurpose(purpose);
  return role === "planning"
    ? "planningMaxOutputTokens"
    : role === "review"
      ? "reviewMaxOutputTokens"
      : role === "settlement"
        ? "settlementMaxOutputTokens"
        : role === "analysis"
          ? "analysisMaxOutputTokens"
          : "draftMaxOutputTokens";
}

export function pricingFor(
  run: NarrativeRun,
  modelId: string,
): ModelPricing | null {
  const table = run.policy.modelPricingUsdPerMillion;
  if (!table || typeof table !== "object" || Array.isArray(table)) return null;
  const entry = (table as Record<string, unknown>)[modelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const pricing = entry as Record<string, unknown>;
  const input = finiteNonNegative(pricing.input);
  const output = finiteNonNegative(pricing.output);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cachedInput: finiteNonNegative(pricing.cachedInput) ?? input,
  };
}

export function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function pricedFailureUsage(
  rawError: unknown,
  error: RunStepError,
  wallTimeMs: number,
  calls: number,
  pricing: ModelPricing | null,
): RunBudgetUsage {
  if (rawError instanceof StructuredOutputError) {
    return budgetUsage(rawError.usage, wallTimeMs, calls, pricing);
  }
  if (!error.usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      calls,
      costUsd: 0,
      wallTimeMs,
    };
  }
  const normalized: NormalizedUsage = {
    inputTokens: error.usage.inputTokens,
    outputTokens: error.usage.outputTokens,
    totalTokens: error.usage.inputTokens + error.usage.outputTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  return budgetUsage(normalized, wallTimeMs, calls, pricing);
}

export function emptyBudgetUsage(): RunBudgetUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
}

export function addBudgetUsage(
  left: RunBudgetUsage,
  right: RunBudgetUsage,
): RunBudgetUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    calls: left.calls + right.calls,
    costUsd: left.costUsd + right.costUsd,
    wallTimeMs: left.wallTimeMs + right.wallTimeMs,
  };
}

export function safeError(error: unknown): Record<string, unknown> {
  const normalized = modelStepError(error, false);
  return {
    code: normalized.code,
    message: normalized.message.slice(0, 2_000),
    retryable: normalized.retryable,
    ...(normalized.details === undefined
      ? {}
      : { details: normalized.details }),
    // Full failure receipt: keep the provider request id, the stable
    // machine-readable reason (e.g. "request_start_timeout"), the HTTP
    // status, and the call timing so failures are diagnosable from
    // llm_calls alone. There are no dedicated columns, so they live in
    // error_json.
    ...(error instanceof ModelError && error.code !== undefined
      ? { reason: error.code }
      : {}),
    ...(error instanceof ModelError && error.requestId !== undefined
      ? { requestId: error.requestId }
      : {}),
    ...(error instanceof ModelError && error.status !== undefined
      ? { status: error.status }
      : {}),
    ...(error instanceof ModelError && error.timing !== undefined
      ? { timing: error.timing }
      : {}),
  };
}

/** INTEGER-column safe timing value: null when the phase was never reached. */
export function roundedTimingMs(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value);
}

/**
 * Success-side details fragment carrying the transport-measured total
 * duration. llm_calls.duration_ms stays the logical wall-clock duration (it
 * also feeds budget wallTimeMs), so the transport figure is persisted under
 * details_json instead.
 */
export function timingDetails(timing: ModelCallTiming | undefined): {
  details?: { totalDurationMs: number };
} {
  const totalDurationMs = roundedTimingMs(timing?.totalDurationMs);
  return totalDurationMs === null ? {} : { details: { totalDurationMs } };
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function promptCacheKey(projectId: string, purpose: string): string {
  const purposeKey = purpose.replace(/[^a-z0-9._-]+/giu, "-").slice(0, 40);
  return `narrative-${sha256Hex(projectId).slice(0, 12)}-${purposeKey}`;
}
