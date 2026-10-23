import { randomUuid, sha256Hex } from "@narralume/domain";

import type {
  NarrativeRun,
  NarrativeRunStep,
  RunBudgetUsage,
  RunStepError,
} from "@narralume/domain";
import {
  createModelAdapter,
  collectModelEvents,
  generateOpenAIEmbeddings,
  ModelGateway,
  StructuredOutputError,
  structuredTierPlan,
  type AdapterConfig,
  type FinishReason,
  type FetchLike,
  type JsonSchemaContract,
  type ModelProtocol,
  type ModelRequest,
  type ModelEvent,
  type StructuredValidator,
} from "@narralume/llm";
import {
  SqliteAssignmentRepository,
  SqliteLlmCallRepository,
  SqliteModelAssignmentSnapshotRepository,
  SqliteModelRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
  publicProvider,
  type AssignmentRole,
  type NarrativeDatabase,
  type ResolvedModelAssignment,
  type StoredModel,
  type StoredProvider,
} from "@narralume/persistence";

import {
  addBudgetUsage,
  ASSIGNMENT_ROLE_FOR_ROLE,
  budgetUsage,
  emptyBudgetUsage,
  frozenStoredModel,
  frozenStoredProvider,
  modelRoleForPurpose,
  pricedFailureUsage,
  pricingFor,
  promptCacheKey,
  roleOutputLimit,
  snapshotRuntime,
  stableJson,
  tokenEstimateDetails,
  timingDetails,
  roundedTimingMs,
  safeError,
  type AppliedModelRuntime,
  type ModelRole,
} from "./ledger.js";
import {
  applyRuntimeRequest,
  createLogicalCallScope,
  createPhysicalAttemptCounter,
  credentialStepError,
  modelRuntime,
  modelStepError,
  positiveInteger,
  resolveCredentialForEnvironment,
  resolveRuntimeTimeouts,
  withProviderPermit,
  type PhysicalAttemptCounter,
  type ResolvedCandidate,
} from "./transport.js";
import { structuredMaxRepairAttempts } from "./structured.js";

export interface NarrativeTextResult {
  text: string;
  usage: RunBudgetUsage;
  finishReason?: FinishReason;
}

export interface NarrativeStructuredResult<T> {
  value: T;
  usage: RunBudgetUsage;
  mode: "native" | "json-mode" | "prompt" | "repair";
  attempts: number;
}

export interface NarrativeEmbeddingResult {
  vectors: number[][];
  model: string;
  modelId: string;
  usage: RunBudgetUsage;
}

export interface NarrativeModelClient {
  text(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: Omit<ModelRequest, "model">,
    signal: AbortSignal,
  ): Promise<NarrativeTextResult>;
  structured<T>(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: Omit<ModelRequest, "model" | "responseSchema">,
    contract: JsonSchemaContract,
    validate: StructuredValidator<T>,
    signal: AbortSignal,
  ): Promise<NarrativeStructuredResult<T>>;
  embed?(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: { inputs: readonly string[] },
    signal: AbortSignal,
  ): Promise<NarrativeEmbeddingResult>;
  /**
   * True when an explicit embedding assignment is configured.
   */
  hasEmbeddingAssignment?(): boolean;
  /**
   * Upstream model name `embed` would use for this run and purpose (the
   * name stored with each vector), or null when no embedding model is
   * assigned. Lets callers skip passages that already have a current vector.
   */
  embeddingModelName?(run: NarrativeRun, purpose: string): string | null;
  /** Model-aware context ceiling for prompt compilation. */
  effectiveContextWindow?(run: NarrativeRun, purpose: string): number;
  /** Model- and role-aware output ceiling for context reserve planning. */
  effectiveOutputLimit?(run: NarrativeRun, purpose: string): number;
  /** Stable, non-secret model declaration key for context receipt reuse. */
  contextMaterializationKey?(run: NarrativeRun, purpose: string): string;
}

export class GatewayNarrativeModelClient implements NarrativeModelClient {
  private readonly calls: SqliteLlmCallRepository;
  private readonly assignments: SqliteAssignmentRepository;
  private readonly assignmentSnapshots: SqliteModelAssignmentSnapshotRepository;
  private readonly runs: SqliteRunRepository;
  private readonly models: SqliteModelRepository;
  private readonly providers: SqliteProviderRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly environment: Readonly<
      Record<string, string | undefined>
    > = {},
    private readonly observe?: (
      runId: string,
      stepId: string,
      event: ModelEvent,
    ) => void,
    private readonly fetcher?: FetchLike,
  ) {
    this.calls = new SqliteLlmCallRepository(database);
    this.assignments = new SqliteAssignmentRepository(database);
    this.assignmentSnapshots = new SqliteModelAssignmentSnapshotRepository(
      database,
    );
    this.runs = new SqliteRunRepository(database);
    this.models = new SqliteModelRepository(database);
    this.providers = new SqliteProviderRepository(database);
  }

  async text(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: Omit<ModelRequest, "model">,
    signal: AbortSignal,
  ): Promise<NarrativeTextResult> {
    const candidates = this.resolveCandidates(run, step, purpose);
    let lastError: RunStepError | null = null;
    let failedUsage = emptyBudgetUsage();
    for (const candidate of candidates) {
      const fullRequest = applyRuntimeRequest(
        run,
        purpose,
        {
          ...request,
          model: candidate.model,
          promptCacheKey:
            request.promptCacheKey ?? promptCacheKey(run.projectId, purpose),
          cacheControl: request.cacheControl ?? { type: "ephemeral" },
        },
        candidate.runtime,
      );
      candidate.recordSnapshot(
        snapshotRuntime(
          run,
          purpose,
          fullRequest,
          candidate.runtime,
          {},
          positiveInteger(request.maxOutputTokens),
        ),
      );
      const call = this.begin(run, step, purpose, fullRequest, candidate);
      const logicalCall = createLogicalCallScope(
        candidate.logicalCallDeadlineMs,
        signal,
      );
      try {
        const response = await withProviderPermit(
          candidate.providerKey,
          logicalCall.signal,
          async () => {
            const events = candidate.gateway.stream(fullRequest, {
              signal: logicalCall.signal,
              stream: true,
            });
            return collectModelEvents(this.observed(events, run.id, step.id));
          },
        );
        const durationMs = Date.now() - call.started;
        this.calls.complete(call.id, {
          ...(response.responseId ? { responseId: response.responseId } : {}),
          finishReason: response.finishReason,
          usage: response.usage,
          ttftMs: roundedTimingMs(response.timing?.timeToFirstTokenMs),
          durationMs,
          finishedAt: new Date().toISOString(),
          details: {
            physicalAttempts: candidate.physicalAttempts(),
            ...tokenEstimateDetails(fullRequest, response.usage),
            ...timingDetails(response.timing).details,
          },
        });
        candidate.recordSnapshot(
          snapshotRuntime(
            run,
            purpose,
            fullRequest,
            candidate.runtime,
            {},
            positiveInteger(request.maxOutputTokens),
          ),
        );
        logicalCall.dispose();
        return {
          text: response.text,
          finishReason: response.finishReason,
          usage: addBudgetUsage(
            failedUsage,
            budgetUsage(
              response.usage,
              durationMs,
              candidate.physicalAttempts(),
              pricingFor(run, candidate.pricingId),
            ),
          ),
        };
      } catch (error) {
        const scopedError = logicalCall.normalizeError(error, signal);
        logicalCall.dispose();
        this.recordFailure(
          call.id,
          call.started,
          scopedError,
          signal.aborted,
          candidate.physicalAttempts(),
        );
        const normalized = modelStepError(scopedError, signal.aborted, {
          runtime: candidate.runtime,
          request: fullRequest,
        });
        failedUsage = addBudgetUsage(
          failedUsage,
          pricedFailureUsage(
            scopedError,
            normalized,
            Date.now() - call.started,
            candidate.physicalAttempts(),
            pricingFor(run, candidate.pricingId),
          ),
        );
        lastError = { ...normalized, usage: failedUsage };
        if (signal.aborted) break;
      }
    }
    throw lastError!;
  }

  hasEmbeddingAssignment(): boolean {
    return this.assignments.resolve("embedding") !== null;
  }

  embeddingModelName(run: NarrativeRun, purpose: string): string | null {
    return (
      this.resolveSnapshotAssignment(run, `${purpose}:embedding`, "embedding")
        ?.model.modelId ?? null
    );
  }

  effectiveContextWindow(run: NarrativeRun, purpose: string): number {
    const requested = positiveInteger(run.policy.contextWindow) ?? 64_000;
    const role = modelRoleForPurpose(purpose);
    const assigned = this.resolveRunAssignment(run, purpose, role);
    if (!assigned?.model.contextWindow) return requested;
    return Math.min(requested, assigned.model.contextWindow);
  }

  effectiveOutputLimit(run: NarrativeRun, purpose: string): number {
    const role = modelRoleForPurpose(purpose);
    const assigned = this.resolveRunAssignment(run, purpose, role);
    const workLimit = roleOutputLimit(run, purpose) ?? 16_000;
    return assigned?.model.maxOutputTokens
      ? Math.min(workLimit, assigned.model.maxOutputTokens)
      : workLimit;
  }

  contextMaterializationKey(run: NarrativeRun, purpose: string): string {
    const role = modelRoleForPurpose(purpose);
    const alreadyFrozen = this.assignmentSnapshots.get(run.id, purpose);
    const resolved = this.resolveRunAssignment(run, purpose, role);
    if (!resolved) return `unassigned:${role}`;
    if (!alreadyFrozen) {
      this.recordAssignmentSnapshot(run, purpose, role, resolved);
    }
    return stableJson({
      requestedRole: role,
      assignmentRole: resolved.role,
      modelId: resolved.model.id,
      contextWindow: resolved.model.contextWindow,
      maxOutputTokens: resolved.model.maxOutputTokens,
      metadataSource: resolved.model.metadataSource,
      metadataVerifiedAt: resolved.model.metadataVerifiedAt,
      modelUpdatedAt: resolved.model.updatedAt,
    });
  }

  async embed(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: { inputs: readonly string[] },
    signal: AbortSignal,
  ): Promise<NarrativeEmbeddingResult> {
    const snapshotPurpose = `${purpose}:embedding`;
    const resolved = this.resolveSnapshotAssignment(
      run,
      snapshotPurpose,
      "embedding",
    );
    if (!resolved)
      throw <RunStepError>{
        code: "model.embedding_assignment.unavailable",
        message: "No usable embedding model assignment is configured",
        retryable: false,
      };
    return this.embedViaAssignment(
      run,
      step,
      purpose,
      request,
      resolved,
      signal,
      snapshotPurpose,
    );
  }

  private async embedViaAssignment(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: { inputs: readonly string[] },
    resolved: ResolvedModelAssignment,
    signal: AbortSignal,
    snapshotPurpose: string,
  ): Promise<NarrativeEmbeddingResult> {
    const { model, provider } = resolved;
    if (provider.wireApi === "anthropic-messages") {
      throw <RunStepError>{
        code: "model.embedding_profile.unavailable",
        message: `Provider "${provider.name}" with the ${provider.wireApi} wire API does not support embeddings`,
        retryable: false,
      };
    }
    const credential = resolveCredentialForEnvironment(
      provider,
      this.environment,
    );
    if (!credential.ok) throw credentialStepError(provider, credential);
    const physicalAttempts = createPhysicalAttemptCounter();
    const call = this.beginEmbedding(
      run,
      step,
      purpose,
      { model: model.modelId, inputs: request.inputs },
      { callModelId: model.id, callProtocol: provider.wireApi },
    );
    const logicalCall = createLogicalCallScope(
      resolveRuntimeTimeouts(run, provider).logicalCallDeadlineMs.value,
      signal,
    );
    try {
      const response = await withProviderPermit(
        provider.id,
        logicalCall.signal,
        () =>
          generateOpenAIEmbeddings(
            this.assignmentAdapterConfig(
              run,
              step,
              provider,
              credential.apiKey,
              physicalAttempts,
            ),
            model.modelId,
            request.inputs,
            logicalCall.signal,
          ),
      );
      const durationMs = Date.now() - call.started;
      this.calls.complete(call.id, {
        finishReason: "stop",
        usage: response.usage,
        durationMs,
        finishedAt: new Date().toISOString(),
        details: { physicalAttempts: physicalAttempts.count },
      });
      this.recordAssignmentSnapshot(
        run,
        snapshotPurpose,
        "embedding",
        resolved,
      );
      logicalCall.dispose();
      return {
        vectors: response.vectors,
        model: model.modelId,
        modelId: model.id,
        usage: budgetUsage(
          response.usage,
          durationMs,
          physicalAttempts.count,
          pricingFor(run, model.id),
        ),
      };
    } catch (error) {
      const scopedError = logicalCall.normalizeError(error, signal);
      logicalCall.dispose();
      this.recordFailure(
        call.id,
        call.started,
        scopedError,
        signal.aborted,
        physicalAttempts.count,
      );
      const normalized = modelStepError(scopedError, signal.aborted);
      throw {
        ...normalized,
        usage: pricedFailureUsage(
          scopedError,
          normalized,
          Date.now() - call.started,
          physicalAttempts.count,
          pricingFor(run, model.id),
        ),
      };
    }
  }

  private async *observed(
    events: AsyncIterable<ModelEvent>,
    runId: string,
    stepId: string,
  ): AsyncGenerator<ModelEvent> {
    for await (const event of events) {
      this.observe?.(runId, stepId, event);
      yield event;
    }
  }

  async structured<T>(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: Omit<ModelRequest, "model" | "responseSchema">,
    contract: JsonSchemaContract,
    validate: StructuredValidator<T>,
    signal: AbortSignal,
  ): Promise<NarrativeStructuredResult<T>> {
    const candidates = this.resolveCandidates(run, step, purpose);
    let lastError: RunStepError | null = null;
    let failedUsage = emptyBudgetUsage();
    for (const candidate of candidates) {
      const fullRequest = applyRuntimeRequest(
        run,
        purpose,
        {
          ...request,
          model: candidate.model,
          responseSchema: contract,
          promptCacheKey:
            request.promptCacheKey ?? promptCacheKey(run.projectId, purpose),
          cacheControl: request.cacheControl ?? { type: "ephemeral" },
        },
        candidate.runtime,
      );
      const allowedModes = structuredTierPlan(candidate.runtime.capabilities);
      candidate.recordSnapshot(
        snapshotRuntime(
          run,
          purpose,
          fullRequest,
          candidate.runtime,
          {
            structuredTierPlan: allowedModes,
          },
          positiveInteger(request.maxOutputTokens),
        ),
      );
      const call = this.begin(run, step, purpose, fullRequest, candidate);
      const logicalCall = createLogicalCallScope(
        candidate.logicalCallDeadlineMs,
        signal,
      );
      // Physical repair calls are not individually ledgered (one llm_calls
      // row per logical structured call), so repairs are first-class run
      // events and their count lands in the row's details_json.
      let repairAttempts = 0;
      try {
        const result = await withProviderPermit(
          candidate.providerKey,
          logicalCall.signal,
          () =>
            candidate.gateway.generateStructured(fullRequest, validate, {
              signal: logicalCall.signal,
              maxRepairAttempts: structuredMaxRepairAttempts(run),
              allowedModes,
              onAttempt: (event) => {
                if (event.mode === "repair") {
                  repairAttempts += 1;
                  this.runs.appendRunEvent(
                    run.id,
                    step.id,
                    "run.llm.repair_attempt",
                    {
                      purpose,
                      attempt: event.attempt,
                      mode: event.mode,
                      valid: event.valid,
                      issues: event.issues.slice(0, 10),
                    },
                    new Date().toISOString(),
                  );
                }
                this.observe?.(run.id, step.id, {
                  type: "structured.attempt",
                  attempt: event.attempt,
                  mode: event.mode,
                  valid: event.valid,
                  ...(event.issues.length > 0
                    ? { issues: event.issues.slice(0, 10) }
                    : {}),
                });
              },
            }),
        );
        const durationMs = Date.now() - call.started;
        this.calls.complete(call.id, {
          ...(result.response.responseId
            ? { responseId: result.response.responseId }
            : {}),
          finishReason: result.response.finishReason,
          usage: result.usage,
          ttftMs: roundedTimingMs(result.response.timing?.timeToFirstTokenMs),
          durationMs,
          finishedAt: new Date().toISOString(),
          details: {
            repairAttempts,
            physicalAttempts: candidate.physicalAttempts(),
            ...tokenEstimateDetails(fullRequest, result.usage),
            ...timingDetails(result.response.timing).details,
          },
        });
        candidate.recordSnapshot(
          snapshotRuntime(
            run,
            purpose,
            fullRequest,
            candidate.runtime,
            {
              structuredTier: result.mode,
              structuredTierPlan: allowedModes,
            },
            positiveInteger(request.maxOutputTokens),
          ),
        );
        logicalCall.dispose();
        return {
          value: result.value,
          usage: addBudgetUsage(
            failedUsage,
            budgetUsage(
              result.usage,
              durationMs,
              candidate.physicalAttempts(),
              pricingFor(run, candidate.pricingId),
            ),
          ),
          mode: result.mode,
          attempts: result.attempts,
        };
      } catch (error) {
        const scopedError = logicalCall.normalizeError(error, signal);
        logicalCall.dispose();
        this.recordFailure(
          call.id,
          call.started,
          scopedError,
          signal.aborted,
          candidate.physicalAttempts(),
          repairAttempts,
        );
        const normalized = modelStepError(scopedError, signal.aborted, {
          runtime: candidate.runtime,
          request: fullRequest,
        });
        failedUsage = addBudgetUsage(
          failedUsage,
          pricedFailureUsage(
            scopedError,
            normalized,
            Date.now() - call.started,
            candidate.physicalAttempts(),
            pricingFor(run, candidate.pricingId),
          ),
        );
        lastError = { ...normalized, usage: failedUsage };
        if (signal.aborted) break;
      }
    }
    throw lastError!;
  }

  /**
   * Resolves the call target for a purpose: purpose → six-role → assignment
   * role → model_assignments → models → providers. planning/review fallback
   * to writing is resolved by the assignment repository; every other missing
   * assignment is an explicit unavailable/degraded capability.
   */
  private resolveCandidates(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
  ): ResolvedCandidate[] {
    const role = modelRoleForPurpose(purpose);
    const resolved = this.resolveRunAssignment(run, purpose, role);
    if (resolved) {
      const credential = resolveCredentialForEnvironment(
        resolved.provider,
        this.environment,
      );
      if (!credential.ok)
        throw credentialStepError(resolved.provider, credential);
      const physicalAttempts = createPhysicalAttemptCounter();
      return [
        {
          model: resolved.model.modelId,
          gateway: new ModelGateway(
            createModelAdapter(
              this.assignmentAdapterConfig(
                run,
                step,
                resolved.provider,
                credential.apiKey,
                physicalAttempts,
                resolved.model.capabilities,
              ),
            ),
          ),
          callModelId: resolved.model.id,
          callProtocol: resolved.provider.wireApi,
          pricingId: resolved.model.id,
          providerKey: resolved.provider.id,
          runtime: modelRuntime(
            resolved.model,
            resolved.provider.wireApi,
            resolved.provider.id,
          ),
          logicalCallDeadlineMs: resolveRuntimeTimeouts(run, resolved.provider)
            .logicalCallDeadlineMs.value,
          physicalAttempts: () => physicalAttempts.count,
          recordSnapshot: (applied) =>
            this.recordAssignmentSnapshot(
              run,
              purpose,
              role,
              resolved,
              applied,
            ),
        },
      ];
    }
    throw <RunStepError>{
      code: "model.assignment.unavailable",
      message: `No model assignment is available for ${role}`,
      retryable: false,
      details: {
        purpose,
        role,
        assignmentRole: ASSIGNMENT_ROLE_FOR_ROLE[role],
      },
    };
  }

  private resolveRunAssignment(
    run: NarrativeRun,
    purpose: string,
    role: ModelRole,
  ): ResolvedModelAssignment | null {
    return this.resolveSnapshotAssignment(
      run,
      purpose,
      ASSIGNMENT_ROLE_FOR_ROLE[role],
    );
  }

  private resolveSnapshotAssignment(
    run: NarrativeRun,
    purpose: string,
    requestedRole: AssignmentRole,
  ): ResolvedModelAssignment | null {
    const frozen = this.assignmentSnapshots.get(run.id, purpose);
    if (!frozen) {
      // A conversation's model override picks a generation model; it never
      // replaces the embedding model (vectors of another model are useless).
      const override =
        requestedRole === "embedding"
          ? null
          : this.resolvePolicyModelOverride(run);
      if (override) {
        return {
          requestedRole,
          role: requestedRole,
          model: override.model,
          provider: override.provider,
        };
      }
      return this.assignments.resolve(requestedRole);
    }
    const currentModel = this.models.get(frozen.modelId);
    if (!currentModel?.enabled) return null;
    const frozenProviderId =
      typeof frozen.model.providerId === "string"
        ? frozen.model.providerId
        : currentModel.providerId;
    const currentProvider = this.providers.get(frozenProviderId);
    if (!currentProvider?.enabled) return null;
    const model = frozenStoredModel(currentModel, frozen.model);
    const provider = frozenStoredProvider(currentProvider, frozen.provider);
    return {
      requestedRole,
      role: frozen.assignmentRole as AssignmentRole,
      model,
      provider,
    };
  }

  /**
   * Per-conversation model override for assistant turns:
   * `policy.assistantModelId` points at a `models.id` row. A dead override
   * fails loudly (the author re-picks in the sidebar) instead of silently
   * falling back to the role assignment.
   */
  private resolvePolicyModelOverride(run: NarrativeRun): {
    model: StoredModel;
    provider: StoredProvider;
  } | null {
    const modelId = run.policy.assistantModelId;
    if (typeof modelId !== "string" || modelId === "") return null;
    const model = this.models.get(modelId);
    const provider = model ? this.providers.get(model.providerId) : null;
    if (!model?.enabled || !provider?.enabled) {
      throw <RunStepError>{
        code: "model.override.unavailable",
        message: `The model selected for this conversation is unavailable (${modelId}); pick another one in the assistant sidebar`,
        retryable: false,
      };
    }
    return { model, provider };
  }

  private assignmentAdapterConfig(
    run: NarrativeRun,
    step: NarrativeRunStep,
    provider: StoredProvider,
    apiKey: string,
    physicalAttempts: PhysicalAttemptCounter,
    capabilities: Readonly<Record<string, boolean>> = {},
  ): AdapterConfig {
    const config = this.adapterConfig(
      run,
      step,
      {
        protocol: provider.wireApi,
        baseUrl: provider.baseUrl,
        apiKey,
        endpoint: provider.endpoint,
        anthropicVersion: provider.anthropicVersion,
        headers: provider.headers,
        queryParams: provider.queryParams,
      },
      provider,
      physicalAttempts,
    );
    // Only the connection probe records that a Chat Completions model rejects
    // max_tokens; unknown keeps the protocol default.
    return provider.wireApi === "openai-chat" &&
      capabilities.maxCompletionTokens === true
      ? { ...config, chatOutputTokenParameter: "max_completion_tokens" }
      : config;
  }

  private adapterConfig(
    run: NarrativeRun,
    step: NarrativeRunStep,
    base: {
      protocol: ModelProtocol;
      baseUrl: string;
      apiKey: string;
      endpoint: string | null;
      anthropicVersion: string | null;
      headers: Record<string, string>;
      queryParams?: Record<string, string>;
    },
    provider: StoredProvider,
    physicalAttempts?: PhysicalAttemptCounter,
  ): AdapterConfig {
    const timeouts = resolveRuntimeTimeouts(run, provider);
    const requestStartTimeoutMs = timeouts.requestStartTimeoutMs.value;
    const streamIdleTimeoutMs = timeouts.streamIdleTimeoutMs.value;
    const logicalCallDeadlineMs = timeouts.logicalCallDeadlineMs.value;
    return {
      protocol: base.protocol,
      baseUrl: base.baseUrl,
      apiKey: base.apiKey,
      ...(base.endpoint ? { endpoint: base.endpoint } : {}),
      ...(base.anthropicVersion
        ? { anthropicVersion: base.anthropicVersion }
        : {}),
      headers: base.headers,
      ...(base.queryParams === undefined
        ? {}
        : { queryParams: base.queryParams }),
      // Whole-attempt lifetime is bounded only by the logical call deadline.
      // requestStartTimeoutMs independently ends when response headers/the
      // first stream event arrive and must never terminate a healthy stream.
      ...(logicalCallDeadlineMs === null
        ? {}
        : { timeoutMs: logicalCallDeadlineMs }),
      // The Harness is the only retry owner for narrative execution. The LLM
      // transport still supports explicit retries for standalone callers, but
      // this production path always dispatches exactly one request per tier.
      maxRetries: 0,
      ...(this.fetcher ? { fetch: this.fetcher } : {}),
      ...(physicalAttempts === undefined
        ? {}
        : {
            onRequestAttempt: () => {
              physicalAttempts.count += 1;
            },
          }),
      requestStartTimeoutMs,
      streamIdleTimeoutMs,
      ...(logicalCallDeadlineMs === null ? {} : { logicalCallDeadlineMs }),
    };
  }

  /**
   * Records the run model snapshot for an assignment-resolved call. The
   * provider is stored in its masked publicProvider shape, so the raw
   * credential_ref never enters the immutable assignment snapshot.
   */
  private recordAssignmentSnapshot(
    run: NarrativeRun,
    purpose: string,
    role: ModelRole | AssignmentRole,
    resolved: ResolvedModelAssignment,
    applied?: AppliedModelRuntime,
  ): void {
    const id = `model-snapshot-${sha256Hex(`${run.id}\0${purpose}`).slice(0, 24)}`;
    const runtimeEvidence = {
      ...applied,
      timeoutPolicy: resolveRuntimeTimeouts(run, resolved.provider),
    };
    this.assignmentSnapshots.upsert({
      id,
      runId: run.id,
      purpose,
      requestedRole: role,
      assignmentRole: resolved.role,
      modelId: resolved.model.id,
      provider: publicProvider(resolved.provider),
      model: {
        id: resolved.model.id,
        providerId: resolved.model.providerId,
        modelId: resolved.model.modelId,
        taskType: resolved.model.taskType,
        contextWindow: resolved.model.contextWindow,
        maxOutputTokens: resolved.model.maxOutputTokens,
        sampling: resolved.model.sampling,
        capabilities: resolved.model.capabilities,
        metadataSource: resolved.model.metadataSource,
        metadataVerifiedAt: resolved.model.metadataVerifiedAt,
        enabled: resolved.model.enabled,
        createdAt: resolved.model.createdAt,
        updatedAt: resolved.model.updatedAt,
        wireApi: resolved.provider.wireApi,
      },
      applied: runtimeEvidence,
      createdAt: new Date().toISOString(),
    });
  }

  private begin(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: ModelRequest,
    target: { callModelId: string; callProtocol: ModelProtocol },
  ) {
    const id = randomUuid();
    const started = Date.now();
    this.calls.start({
      id,
      projectId: run.projectId,
      runId: run.id,
      stepId: step.id,
      modelId: target.callModelId,
      protocol: target.callProtocol,
      model: request.model,
      purpose,
      requestHash: sha256Hex(stableJson(request)),
      startedAt: new Date(started).toISOString(),
    });
    return { id, started };
  }

  private beginEmbedding(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: { model: string; inputs: readonly string[] },
    target: { callModelId: string; callProtocol: ModelProtocol },
  ) {
    const id = randomUuid();
    const started = Date.now();
    this.calls.start({
      id,
      projectId: run.projectId,
      runId: run.id,
      stepId: step.id,
      modelId: target.callModelId,
      protocol: target.callProtocol,
      model: request.model,
      purpose: `${purpose}:embedding`,
      requestHash: sha256Hex(stableJson(request)),
      startedAt: new Date(started).toISOString(),
    });
    return { id, started };
  }

  private recordFailure(
    id: string,
    started: number,
    error: unknown,
    cancelled: boolean,
    physicalAttempts: number,
    repairAttempts = 0,
  ): void {
    this.calls.fail(
      id,
      safeError(error),
      Date.now() - started,
      new Date().toISOString(),
      cancelled,
      error instanceof StructuredOutputError ? error.usage : undefined,
      { physicalAttempts, repairAttempts },
    );
  }
}
