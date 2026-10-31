import { sha256Hex } from "@lapis/domain";

import type { NarrativeRun, RunStepError } from "@lapis/domain";
import {
  isMaxTokensUnsupportedError,
  isSamplingParameterUnsupportedError,
  ModelError,
  StructuredOutputError,
  type ModelGateway,
  type ModelProtocol,
  type ModelRequest,
} from "@lapis/llm";
import {
  type ResolvedCredential,
  type StoredModel,
  type StoredProvider,
} from "@lapis/persistence";

import {
  type AppliedModelRuntime,
  budgetUsage,
  roleOutputLimit,
  requestTokenEstimate,
} from "./ledger.js";

export interface ResolvedCandidate {
  /** Model name sent on the wire request. */
  model: string;
  gateway: ModelGateway;
  /** Recorded as llm_calls.model_id. */
  callModelId: string;
  callProtocol: ModelProtocol;
  /** Key into policy.modelPricingUsdPerMillion. */
  pricingId: string;
  /** Stable provider-scoped semaphore key shared across runs. */
  providerKey: string;
  logicalCallDeadlineMs: number | null;
  runtime: CandidateRuntime;
  /** Number of real HTTP requests dispatched by this logical call. */
  physicalAttempts(): number;
  recordSnapshot(applied: AppliedModelRuntime): void;
}

export interface CandidateRuntime {
  protocol: ModelProtocol;
  providerId: string;
  modelContextWindow: number | null;
  modelMaxOutputTokens: number | null;
  sampling: Readonly<Record<string, unknown>>;
  capabilities: Readonly<Record<string, boolean>>;
  metadataSource: StoredModel["metadataSource"] | null;
  metadataVerifiedAt: string | null;
}

export function modelRuntime(
  model: StoredModel | null,
  protocol: ModelProtocol,
  providerId: string,
  overrides: { capabilities?: Readonly<Record<string, boolean>> } = {},
): CandidateRuntime {
  return {
    protocol,
    providerId,
    modelContextWindow: model?.contextWindow ?? null,
    modelMaxOutputTokens: model?.maxOutputTokens ?? null,
    sampling: model?.sampling ?? {},
    capabilities: overrides.capabilities ?? model?.capabilities ?? {},
    metadataSource: model?.metadataSource ?? null,
    metadataVerifiedAt: model?.metadataVerifiedAt ?? null,
  };
}

export function isRecordValue(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isBooleanRecord(
  value: unknown,
): value is Record<string, boolean> {
  return (
    isRecordValue(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isRecordValue(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function nullablePositiveInteger(
  value: unknown,
  fallback: number | null,
): number | null {
  return value === null
    ? null
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : fallback;
}

export function applyRuntimeRequest(
  run: NarrativeRun,
  purpose: string,
  request: ModelRequest,
  runtime: CandidateRuntime,
): ModelRequest {
  const policyContextWindow =
    positiveInteger(run.policy.contextWindow) ?? 64_000;
  // Provider metadata is advisory. Unknown physical limits fall back to the
  // bounded run policy instead of making an otherwise usable model
  // unassignable.
  const modelContextWindow = runtime.modelContextWindow ?? policyContextWindow;
  const contextWindow = Math.min(policyContextWindow, modelContextWindow);
  const estimate = requestTokenEstimate(request, contextWindow);
  const remainingContextTokens =
    contextWindow - estimate.conservative - estimate.safety;
  if (remainingContextTokens < 1) {
    throw <RunStepError>{
      code: "model.context_length",
      message: `The conservative input budget of ${estimate.conservative + estimate.safety} tokens exceeds the effective context window ${contextWindow}`,
      retryable: false,
      details: {
        purpose,
        estimatedInputTokens: estimate.conservative,
        inputSafetyTokens: estimate.safety,
        contextWindow,
      },
    };
  }

  const requested = positiveInteger(request.maxOutputTokens);
  const rolePolicy = roleOutputLimit(run, purpose);
  const outputCandidates = [
    requested,
    rolePolicy,
    runtime.modelMaxOutputTokens,
    remainingContextTokens,
  ].filter((value): value is number => value !== null);
  const maxOutputTokens = Math.max(1, Math.min(...outputCandidates));
  const sampling = mergedSampling(runtime.protocol, runtime.sampling, request);
  const applied: ModelRequest = {
    ...request,
    maxOutputTokens,
    ...sampling,
  };
  if (runtime.capabilities.samplingParameters === false) {
    // The connection probe recorded that this model rejects temperature
    // (e.g. OpenAI reasoning models). The probe never sends top_p, but a model
    // that rejects temperature is not trusted with top_p either, so neither
    // the model defaults nor the worker request may send them. Unknown keeps
    // the requested values.
    delete applied.temperature;
    delete applied.topP;
  }
  return applied;
}

export function mergedSampling(
  protocol: ModelProtocol,
  model: Readonly<Record<string, unknown>>,
  request: ModelRequest,
): Pick<
  ModelRequest,
  "temperature" | "topP" | "reasoningEffort" | "stopSequences"
> {
  const adapter = adapterSamplingDefaults(protocol);
  const modelSampling = normalizeSampling(model);
  return {
    ...adapter,
    ...modelSampling,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.stopSequences === undefined
      ? {}
      : { stopSequences: request.stopSequences }),
  };
}

export function adapterSamplingDefaults(
  protocol: ModelProtocol,
): Pick<ModelRequest, "temperature" | "topP"> {
  // Provider defaults are intentionally left on the provider unless the
  // adapter needs a stable override. Keeping this explicit makes the merge
  // order deterministic without inventing sampling values.
  // Referencing the protocol is deliberate: future adapter defaults belong
  // in this switch point, before model and step overrides are merged.
  void protocol;
  return {};
}

export function normalizeSampling(
  sampling: Readonly<Record<string, unknown>>,
): Pick<
  ModelRequest,
  "temperature" | "topP" | "reasoningEffort" | "stopSequences"
> {
  const temperature = finiteInRange(sampling.temperature, 0, 2);
  const topP = finiteInRange(sampling.topP ?? sampling.top_p, 0, 1);
  const reasoningEffort = ["none", "minimal", "low", "medium", "high"].includes(
    String(sampling.reasoningEffort),
  )
    ? (sampling.reasoningEffort as ModelRequest["reasoningEffort"])
    : undefined;
  const stopSequences = Array.isArray(sampling.stopSequences)
    ? sampling.stopSequences.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : undefined;
  return {
    ...(temperature === null ? {} : { temperature }),
    ...(topP === null ? {} : { topP }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(stopSequences === undefined ? {} : { stopSequences }),
  };
}

export function samplingFromRequest(
  request: ModelRequest,
): Readonly<Record<string, unknown>> {
  return {
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.stopSequences === undefined
      ? {}
      : { stopSequences: request.stopSequences }),
  };
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export function finiteInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

export interface PhysicalAttemptCounter {
  count: number;
}

export interface LogicalCallScope {
  signal: AbortSignal;
  dispose(): void;
  normalizeError(error: unknown, callerSignal: AbortSignal): unknown;
}

/** One deadline shared by provider queuing, structured tiers and repairs. */
export function createLogicalCallScope(
  deadlineMs: number | null,
  callerSignal: AbortSignal,
): LogicalCallScope {
  if (deadlineMs === null) {
    return {
      signal: callerSignal,
      dispose() {},
      normalizeError: (error) => error,
    };
  }
  const startedAt = Date.now();
  const deadlineController = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    deadlineController.abort(
      new DOMException("Logical model call deadline exceeded", "TimeoutError"),
    );
  }, deadlineMs);
  return {
    signal: AbortSignal.any([callerSignal, deadlineController.signal]),
    dispose: () => clearTimeout(timer),
    normalizeError: (error, externalSignal) =>
      expired && !externalSignal.aborted
        ? <RunStepError>{
            code: "model.logical_call_timeout",
            message: `The logical model call exceeded the overall deadline of ${deadlineMs}ms`,
            retryable: true,
            details: {
              scope: "logical-call",
              deadlineMs,
              elapsedMs: Date.now() - startedAt,
            },
          }
        : error,
  };
}

export function createPhysicalAttemptCounter(): PhysicalAttemptCounter {
  return { count: 0 };
}

export function credentialStepError(
  provider: StoredProvider,
  credential: Exclude<ResolvedCredential, { ok: true }>,
): RunStepError {
  if (credential.reason === "missing_env") {
    return {
      code: "model.credential.missing_env",
      message: `The credential of provider "${provider.name}" references the unset environment variable ${credential.name}`,
      retryable: false,
    };
  }
  return {
    code: "model.credential.empty",
    message: `The credential of provider "${provider.name}" is empty`,
    retryable: false,
  };
}

export function resolveCredentialForEnvironment(
  provider: StoredProvider,
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedCredential {
  if (provider.credentialRef.startsWith("relay:")) {
    // Relay provider (D5): the real key lives only in the relay's environment
    // variables; the browser gets a dummy key. The relay strips this header and
    // injects the server key; the dummy value only satisfies the non-empty
    // check.
    return { ok: true, apiKey: `relay:${provider.credentialRef.slice(6)}` };
  }
  if (!provider.credentialRef.startsWith("env:")) {
    return provider.credentialRef.length > 0
      ? { ok: true, apiKey: provider.credentialRef }
      : { ok: false, reason: "empty" };
  }
  const name = provider.credentialRef.slice("env:".length);
  const value = environment[name];
  if (value === undefined) return { ok: false, reason: "missing_env", name };
  if (value.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, apiKey: value };
}

export function modelStepError(
  error: unknown,
  cancelled: boolean,
  attempt?: { runtime: CandidateRuntime; request: ModelRequest },
): RunStepError {
  if (cancelled) {
    // Preserve the partial output accumulated before the abort so recovery
    // can offer continue/adopt/regenerate on top of it.
    const partialText =
      error instanceof ModelError ? error.partialText : undefined;
    return {
      code: "model.cancelled",
      message: "The model call was cancelled",
      retryable: true,
      ...(partialText
        ? { details: { partialText: redactDiagnostic(partialText) } }
        : {}),
    };
  }
  if (isStepError(error)) {
    // A RunStepError is spread into a fresh object at every call site (to
    // attach usage). Return a plain object so non-enumerable Error fields —
    // message on a ModelError instance — are not silently dropped, and so the
    // step error retains the message every RunStepError must carry.
    return {
      code: error.code,
      message:
        typeof error.message === "string" && error.message.length > 0
          ? error.message
          : error.code,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.usage === undefined ? {} : { usage: error.usage }),
    };
  }
  if (error instanceof StructuredOutputError) {
    const outputLimited =
      error.finishReason === "length" ||
      error.finishReason === "context_length";
    return {
      code: outputLimited
        ? "model.structured_output_limit"
        : "model.structured_output",
      message: outputLimited
        ? "Structured output still hit the model output/context limit after repair; raise the effective limit or shrink the input"
        : error.message,
      // A validation failure is a random-sampling problem: following the
      // retryable semantics of StructuredOutputError, it goes through
      // step-level backoff retry. Only output/context limits are excluded,
      // since a re-roll hits the same limit.
      retryable: outputLimited ? false : error.retryable,
      details: {
        attempts: error.attempts,
        ...(error.finishReason ? { finishReason: error.finishReason } : {}),
        validationIssues: error.validationIssues.slice(0, 20),
        ...(error.invalidText
          ? {
              invalidOutputHash: sha256Hex(error.invalidText),
              invalidOutputExcerpt: redactDiagnostic(error.invalidText).slice(
                0,
                2_048,
              ),
            }
          : {}),
      },
      usage: budgetUsage(error.usage, 0, error.attempts),
    };
  }
  if (error instanceof ModelError) {
    const constraint =
      attempt === undefined ? null : requestConstraintHint(error, attempt);
    return {
      code: `model.${error.category}`,
      message:
        constraint === null
          ? error.message
          : `${error.message} (${constraint.hint})`,
      retryable: error.retryable,
      ...(constraint === null
        ? {}
        : { details: { requestConstraint: constraint.reason } }),
    };
  }
  return {
    code: "model.failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

/**
 * Explains a provider rejection of a request constraint that only the
 * connection probe records (sampling parameters, the Chat Completions
 * max_tokens field). The call is deliberately not retried with an adjusted
 * request. While the capability is unknown the hint points the author at the
 * probe. When the probe already recorded that the model accepts the
 * parameter, re-probing would record the same value, so the hint says the
 * request falls outside the probe evidence instead (for example a reasoning
 * effort other than the probe's, or top_p, which the probe never sends).
 */
export function requestConstraintHint(
  error: ModelError,
  attempt: { runtime: CandidateRuntime; request: ModelRequest },
): { reason: string; hint: string } | null {
  const { capabilities, protocol } = attempt.runtime;
  const effort =
    attempt.request.reasoningEffort === undefined
      ? ""
      : ` at reasoning effort "${attempt.request.reasoningEffort}"`;
  if (isSamplingParameterUnsupportedError(error)) {
    if (capabilities.samplingParameters === undefined) {
      return {
        reason: "sampling_parameters_unsupported",
        hint: "this model rejects temperature/top_p; run Probe on it in Settings so runs started afterwards omit them",
      };
    }
    if (capabilities.samplingParameters === true) {
      const topP =
        attempt.request.topP === undefined
          ? ""
          : " (the probe does not send top_p)";
      return {
        reason: "sampling_parameters_outside_probe_evidence",
        hint: `this model rejected temperature/top_p${effort} although its connection probe accepted temperature${topP}; the probe evidence does not cover this request`,
      };
    }
  }
  if (protocol === "openai-chat" && isMaxTokensUnsupportedError(error)) {
    if (capabilities.maxCompletionTokens === undefined) {
      return {
        reason: "max_tokens_unsupported",
        hint: "this model requires max_completion_tokens; run Probe on it in Settings so runs started afterwards send it",
      };
    }
    if (capabilities.maxCompletionTokens === false) {
      return {
        reason: "max_tokens_outside_probe_evidence",
        hint: `this model rejected max_tokens${effort} although its connection probe accepted it; the probe evidence does not cover this request`,
      };
    }
  }
  return null;
}

const PROVIDER_CONCURRENCY = 2;
const PROVIDER_SEMAPHORES = new Map<string, ProviderSemaphore>();

export async function withProviderPermit<T>(
  providerKey: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  let semaphore = PROVIDER_SEMAPHORES.get(providerKey);
  if (!semaphore) {
    semaphore = new ProviderSemaphore(PROVIDER_CONCURRENCY);
    PROVIDER_SEMAPHORES.set(providerKey, semaphore);
  }
  const release = await semaphore.acquire(signal);
  try {
    return await operation();
  } finally {
    release();
  }
}

export class ProviderSemaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancelledModelError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseFactory());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(cancelledModelError());
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(cancelledModelError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseFactory());
    }
  }
}

export function cancelledModelError(): ModelError {
  return new ModelError(
    "Model call cancelled while waiting for provider capacity",
    {
      category: "cancelled",
    },
  );
}

export function isStepError(error: unknown): error is RunStepError {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    typeof (error as RunStepError).code === "string" &&
    typeof (error as RunStepError).retryable === "boolean"
  );
}

export function explicitPolicyFields(
  policy: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const value = policy.explicitPolicyFields;
  return new Set(
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
}

export function policyFieldSource(run: NarrativeRun, field: string): string {
  return explicitPolicyFields(run.policy).has(field)
    ? "run"
    : `quality-preset:${String(run.policy.qualityPreset ?? "standard")}`;
}

interface RuntimeTimeoutPolicy {
  requestStartTimeoutMs: {
    value: number;
    source: "run" | "provider" | "built-in";
  };
  streamIdleTimeoutMs: {
    value: number;
    source: "run" | "provider" | "built-in";
  };
  logicalCallDeadlineMs: { value: number | null; source: string };
  stepDeadlineMs: { value: number | null; source: string };
  runDeadlineMs: { value: number | null; source: string };
}

export function resolveRuntimeTimeouts(
  run: NarrativeRun,
  provider: StoredProvider,
): RuntimeTimeoutPolicy {
  const explicit = explicitPolicyFields(run.policy);
  const runRequestStart = explicit.has("requestStartTimeoutMs")
    ? timeoutMsOrNull(run.policy.requestStartTimeoutMs, 600_000)
    : null;
  const providerRequestStart = timeoutMsOrNull(
    provider.requestStartTimeoutMs,
    600_000,
  );
  const runStreamIdle = explicit.has("streamIdleTimeoutMs")
    ? timeoutMsOrNull(run.policy.streamIdleTimeoutMs, 1_800_000)
    : null;
  const providerStreamIdle = timeoutMsOrNull(
    provider.streamIdleTimeoutMs,
    1_800_000,
  );
  return {
    requestStartTimeoutMs: runRequestStart
      ? { value: runRequestStart, source: "run" }
      : providerRequestStart
        ? { value: providerRequestStart, source: "provider" }
        : { value: 120_000, source: "built-in" },
    streamIdleTimeoutMs: runStreamIdle
      ? { value: runStreamIdle, source: "run" }
      : providerStreamIdle
        ? { value: providerStreamIdle, source: "provider" }
        : { value: 120_000, source: "built-in" },
    logicalCallDeadlineMs: {
      value: timeoutMsOrNull(run.policy.logicalCallDeadlineMs, 3_600_000),
      source: policyFieldSource(run, "logicalCallDeadlineMs"),
    },
    stepDeadlineMs: {
      value: timeoutMsOrNull(run.policy.stepDeadlineMs, 7_200_000),
      source: policyFieldSource(run, "stepDeadlineMs"),
    },
    runDeadlineMs: {
      value: timeoutMsOrNull(run.policy.runDeadlineMs, 14_400_000),
      source: policyFieldSource(run, "runDeadlineMs"),
    },
  };
}

export function timeoutMsOrNull(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : null;
}

export function policyIntInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(Math.floor(value), max))
    : null;
}

export function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["'])[^"']+(["'])/giu,
      "$1[REDACTED]$2",
    );
}
