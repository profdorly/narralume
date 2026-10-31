import { createProject } from "@lapis/domain";
import { buildChapterRecipe } from "@lapis/harness";
import type { AssignmentRole, ModelTaskType } from "@lapis/domain";
import {
  SqliteAssignmentRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
} from "@lapis/persistence";
import { NodeNarrativeDatabase } from "@lapis/persistence/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayNarrativeModelClient,
  optionalEmbeddings,
} from "../src/index.js";

const NOW = "2026-08-11T00:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function seedAssignment(
  database: NodeNarrativeDatabase,
  input: {
    role?: AssignmentRole;
    taskType?: ModelTaskType;
    modelRowId?: string;
    modelId?: string;
    providerId?: string;
    credentialRef?: string;
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    providerEnabled?: boolean;
    modelEnabled?: boolean;
    capabilities?: Record<string, boolean>;
    sampling?: Record<string, unknown>;
    wireApi?: "openai-chat" | "openai-responses" | "anthropic-messages";
  } = {},
): void {
  const role = input.role ?? "writing";
  const providerId = input.providerId ?? `provider-${role}`;
  const modelRowId = input.modelRowId ?? `model-${role}`;
  new SqliteProviderRepository(database).upsert({
    id: providerId,
    name: providerId,
    wireApi: input.wireApi ?? "openai-chat",
    baseUrl: `https://${providerId}.example/v1`,
    endpoint: null,
    credentialRef: input.credentialRef ?? "raw-secret-key-123456",
    anthropicVersion: null,
    headers: {},
    queryParams: {},
    requestStartTimeoutMs: null,
    streamIdleTimeoutMs: null,
    enabled: input.providerEnabled ?? true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  new SqliteModelRepository(database).upsert({
    id: modelRowId,
    providerId,
    modelId: input.modelId ?? `${role}-wire-model`,
    taskType: input.taskType ?? role,
    contextWindow:
      input.contextWindow === undefined ? 128_000 : input.contextWindow,
    maxOutputTokens:
      input.maxOutputTokens === undefined ? 32_000 : input.maxOutputTokens,
    sampling: input.sampling ?? { temperature: 0.4 },
    capabilities: input.capabilities ?? {},
    enabled: input.modelEnabled ?? true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  new SqliteAssignmentRepository(database).set(role, modelRowId, NOW);
}

function createRun(
  database: NodeNarrativeDatabase,
  id: string,
  policy: Record<string, unknown> = {},
) {
  const projectId = `${id}-project`;
  new SqliteProjectRepository(database).insert(
    createProject({ id: projectId, title: "远潮", now: NOW }),
  );
  const recipe = buildChapterRecipe(id, 0);
  const runs = new SqliteRunRepository(database);
  runs.create({
    id,
    projectId,
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    targetOutlineNodeId: null,
    policy: {
      contextWindow: 128_000,
      draftMaxOutputTokens: 32_000,
      reviewMaxOutputTokens: 24_000,
      planningMaxOutputTokens: 24_000,
      settlementMaxOutputTokens: 24_000,
      logicalCallDeadlineMs: 60_000,
      maxRepairAttempts: 1,
      explicitPolicyFields: [],
      ...policy,
    },
    steps: recipe.steps,
    now: NOW,
  });
  runs.leaseNext("worker", NOW, 30_000);
  const step = runs.startStep(id, `${id}:context`, NOW);
  return { runs, step };
}

function chatResponse(text = "续写", finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      usage: { prompt_tokens: 18, completion_tokens: 3, total_tokens: 21 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("GatewayNarrativeModelClient B1 assignment runtime", () => {
  it("uses only the role assignment and persists masked model/applied snapshots", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      modelRowId: "model-a",
      modelId: "assigned-model",
    });
    const { runs, step } = createRun(database, "run-a");
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return chatResponse("assignment 链路");
      }),
    );

    const result = await new GatewayNarrativeModelClient(database, {}).text(
      runs.getRun("run-a")!,
      step,
      "chapter-draft",
      {
        messages: [{ role: "user", content: "继续" }],
        maxOutputTokens: 64_000,
      },
      new AbortController().signal,
    );

    expect(result.text).toBe("assignment 链路");
    expect(requests[0]).toMatchObject({
      model: "assigned-model",
      max_tokens: 32_000,
    });
    const snapshot = database.raw
      .prepare(
        `SELECT requested_role, assignment_role, model_id, provider_json,
                model_json, applied_json
         FROM model_assignment_snapshots WHERE run_id = ?`,
      )
      .get("run-a") as Record<string, string>;
    expect(snapshot).toMatchObject({
      requested_role: "drafting",
      assignment_role: "writing",
      model_id: "model-a",
    });
    expect(JSON.parse(snapshot.provider_json)).toMatchObject({
      credentialRef: "••••3456",
    });
    expect(JSON.parse(snapshot.applied_json)).toMatchObject({
      policyContextWindow: 128_000,
      modelContextWindow: 128_000,
      modelMaxOutputTokens: 32_000,
      maxOutputTokens: 32_000,
      contextWindowPolicySource: "quality-preset:standard",
      contextWindowAppliedBy: "policy",
      maxOutputTokensAppliedBy: ["role-policy", "model"],
      modelMetadataSource: "manual",
      timeoutPolicy: {
        requestStartTimeoutMs: { value: 120_000, source: "built-in" },
        streamIdleTimeoutMs: { value: 120_000, source: "built-in" },
      },
    });
    expect(JSON.parse(snapshot.model_json)).toMatchObject({
      metadataSource: "manual",
      metadataVerifiedAt: null,
    });
    expect(
      database.raw
        .prepare(
          "SELECT model_id, model, details_json FROM llm_calls WHERE run_id = ?",
        )
        .get("run-a"),
    ).toMatchObject({ model_id: "model-a", model: "assigned-model" });
    const details = JSON.parse(
      (
        database.raw
          .prepare("SELECT details_json FROM llm_calls WHERE run_id = ?")
          .get("run-a") as { details_json: string }
      ).details_json,
    ) as Record<string, unknown>;
    expect(details).toMatchObject({
      estimatedInputTokens: expect.any(Number),
      actualInputTokens: 18,
      inputEstimateErrorTokens: expect.any(Number),
    });
    database.close();
  });

  it("uses bounded policy defaults when physical model limits are unknown", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      contextWindow: null,
      maxOutputTokens: null,
    });
    const { runs, step } = createRun(database, "run-unknown-limits", {
      contextWindow: 64_000,
      draftMaxOutputTokens: 12_000,
    });
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return chatResponse("未知上限仍可调用");
      }),
    );

    const result = await new GatewayNarrativeModelClient(database, {}).text(
      runs.getRun("run-unknown-limits")!,
      step,
      "chapter-draft",
      {
        messages: [{ role: "user", content: "继续" }],
        maxOutputTokens: 20_000,
      },
      new AbortController().signal,
    );

    expect(result.text).toBe("未知上限仍可调用");
    expect(requests[0]).toMatchObject({ max_tokens: 12_000 });
    database.close();
  });

  it("omits temperature and top_p for models probed as rejecting sampling parameters", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, { capabilities: { samplingParameters: false } });
    const { runs, step } = createRun(database, "run-no-sampling");
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        return chatResponse(
          "response_format" in body ||
            JSON.stringify(body.messages).includes("JSON")
            ? '{"ok":true}'
            : "推理模型续写",
        );
      }),
    );
    const client = new GatewayNarrativeModelClient(database, {});
    const run = runs.getRun("run-no-sampling")!;

    const result = await client.text(
      run,
      step,
      "chapter-draft",
      {
        messages: [{ role: "user", content: "继续" }],
        temperature: 0.82,
        topP: 0.9,
        reasoningEffort: "low",
      },
      new AbortController().signal,
    );
    await client.structured(
      run,
      step,
      "chapter-review",
      {
        messages: [{ role: "user", content: "审稿" }],
        temperature: 0.2,
        reasoningEffort: "low",
      },
      {
        name: "probe",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
      (value) =>
        (value as { ok?: unknown }).ok === true
          ? { success: true as const, data: value }
          : { success: false as const, issues: ["ok must be true"] },
      new AbortController().signal,
    );

    expect(result.text).toBe("推理模型续写");
    expect(requests).toHaveLength(2);
    for (const body of requests) {
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body).toMatchObject({ reasoning_effort: "low" });
    }
    const applied = database.raw
      .prepare(
        "SELECT applied_json FROM model_assignment_snapshots WHERE run_id = ? AND purpose = ?",
      )
      .get("run-no-sampling", "chapter-draft") as { applied_json: string };
    expect(JSON.parse(applied.applied_json)).toMatchObject({
      sampling: { reasoningEffort: "low" },
      capabilities: { samplingParameters: false },
    });
    expect(JSON.parse(applied.applied_json).sampling).not.toHaveProperty(
      "temperature",
    );
    database.close();
  });

  it("keeps sampling parameters while the capability is unknown", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database);
    const { runs, step } = createRun(database, "run-sampling-unknown");
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return chatResponse();
      }),
    );
    const client = new GatewayNarrativeModelClient(database, {});

    await client.text(
      runs.getRun("run-sampling-unknown")!,
      step,
      "chapter-draft",
      { messages: [{ role: "user", content: "继续" }], topP: 0.9 },
      new AbortController().signal,
    );
    await client.text(
      runs.getRun("run-sampling-unknown")!,
      step,
      "chapter-review",
      {
        messages: [{ role: "user", content: "审稿" }],
        temperature: 0.65,
      },
      new AbortController().signal,
    );

    // The model default (0.4) applies unless the worker overrides it.
    expect(requests[0]).toMatchObject({
      temperature: 0.4,
      top_p: 0.9,
      max_tokens: 32_000,
    });
    expect(requests[1]).toMatchObject({ temperature: 0.65 });
    expect(requests[1]).not.toHaveProperty("max_completion_tokens");
    database.close();
  });

  it("sends max_completion_tokens for Chat Completions models probed as requiring it", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      capabilities: { samplingParameters: true, maxCompletionTokens: true },
    });
    const { runs, step } = createRun(database, "run-completion-tokens");
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return chatResponse();
      }),
    );

    await new GatewayNarrativeModelClient(database, {}).text(
      runs.getRun("run-completion-tokens")!,
      step,
      "chapter-draft",
      {
        messages: [{ role: "user", content: "继续" }],
        maxOutputTokens: 8_000,
      },
      new AbortController().signal,
    );

    expect(requests[0]).toMatchObject({
      max_completion_tokens: 8_000,
      temperature: 0.4,
    });
    expect(requests[0]).not.toHaveProperty("max_tokens");
    database.close();
  });

  it.each([
    [
      "sampling_parameters_unsupported",
      "Unsupported parameter: 'temperature' is not supported with this model.",
      "rejects temperature/top_p",
    ],
    [
      "max_tokens_unsupported",
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      "requires max_completion_tokens",
    ],
  ])(
    "points unprobed request constraints at the connection probe without retrying (%s)",
    async (requestConstraint, providerMessage, hint) => {
      const database = new NodeNarrativeDatabase();
      database.migrate();
      seedAssignment(database);
      const { runs, step } = createRun(database, `run-${requestConstraint}`);
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: providerMessage,
                type: "invalid_request_error",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new GatewayNarrativeModelClient(database, {}).text(
          runs.getRun(`run-${requestConstraint}`)!,
          step,
          "chapter-draft",
          { messages: [{ role: "user", content: "继续" }] },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: "model.invalid_request",
        retryable: false,
        message: expect.stringContaining(`${hint}; run Probe on it`),
        details: { requestConstraint },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      database.close();
    },
  );

  it.each([
    [
      "openai-responses",
      () =>
        new Response(
          JSON.stringify({
            id: "resp-1",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "推理模型续写" }],
              },
            ],
            usage: { input_tokens: 18, output_tokens: 3, total_tokens: 21 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
    [
      "anthropic-messages",
      () =>
        new Response(
          JSON.stringify({
            id: "msg-1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "推理模型续写" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 18, output_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
  ] as const)(
    "omits sampling parameters on %s for models probed as rejecting them",
    async (wireApi, reply) => {
      const database = new NodeNarrativeDatabase();
      database.migrate();
      seedAssignment(database, {
        wireApi,
        capabilities: { samplingParameters: false },
      });
      const { runs, step } = createRun(database, `run-no-sampling-${wireApi}`);
      const requests: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          requests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return reply();
        }),
      );

      const result = await new GatewayNarrativeModelClient(database, {}).text(
        runs.getRun(`run-no-sampling-${wireApi}`)!,
        step,
        "chapter-draft",
        {
          messages: [{ role: "user", content: "继续" }],
          temperature: 0.82,
          topP: 0.9,
          reasoningEffort: "low",
        },
        new AbortController().signal,
      );

      expect(result.text).toBe("推理模型续写");
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("temperature");
      expect(requests[0]).not.toHaveProperty("top_p");
      expect(requests[0]).not.toHaveProperty("max_completion_tokens");
      expect(requests[0]).toMatchObject(
        wireApi === "openai-responses"
          ? { reasoning: { effort: "low" }, max_output_tokens: 32_000 }
          : { output_config: { effort: "low" }, max_tokens: 32_000 },
      );
      database.close();
    },
  );

  it.each(["openai-responses", "anthropic-messages"] as const)(
    "points unprobed sampling rejections on %s at the connection probe",
    async (wireApi) => {
      const database = new NodeNarrativeDatabase();
      database.migrate();
      seedAssignment(database, { wireApi });
      const { runs, step } = createRun(database, `run-rejected-${wireApi}`);
      const requests: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          requests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return new Response(
            JSON.stringify({
              error: {
                message: "temperature: this parameter is not supported",
                type: "invalid_request_error",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }),
      );

      await expect(
        new GatewayNarrativeModelClient(database, {}).text(
          runs.getRun(`run-rejected-${wireApi}`)!,
          step,
          "chapter-draft",
          {
            messages: [{ role: "user", content: "继续" }],
            reasoningEffort: "low",
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: "model.invalid_request",
        retryable: false,
        message: expect.stringContaining(
          "rejects temperature/top_p; run Probe on it",
        ),
        details: { requestConstraint: "sampling_parameters_unsupported" },
      });
      // Unknown keeps the model default temperature and never retries.
      expect(requests).toHaveLength(1);
      expect(requests[0]).toHaveProperty("temperature", 0.4);
      database.close();
    },
  );

  it.each([
    [
      "sampling_parameters_outside_probe_evidence",
      { samplingParameters: true },
      "Unsupported parameter: 'temperature' is not supported with this model.",
      'rejected temperature/top_p at reasoning effort "medium" although its connection probe accepted temperature; the probe evidence does not cover this request',
      undefined,
    ],
    [
      "sampling_parameters_outside_probe_evidence",
      { samplingParameters: true },
      "Unsupported parameter: 'top_p' is not supported with this model.",
      'rejected temperature/top_p at reasoning effort "medium" although its connection probe accepted temperature (the probe does not send top_p); the probe evidence does not cover this request',
      { temperature: 0.4, topP: 0.9 },
    ],
    [
      "max_tokens_outside_probe_evidence",
      { samplingParameters: true, maxCompletionTokens: false },
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      'rejected max_tokens at reasoning effort "medium" although its connection probe accepted it',
      undefined,
    ],
  ])(
    "does not send the author back to the probe when it already recorded acceptance (%s)",
    async (
      requestConstraint,
      capabilities,
      providerMessage,
      hint,
      sampling,
    ) => {
      const database = new NodeNarrativeDatabase();
      database.migrate();
      seedAssignment(database, {
        capabilities,
        ...(sampling === undefined ? {} : { sampling }),
      });
      const { runs, step } = createRun(database, `run-${requestConstraint}`);
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: providerMessage,
                type: "invalid_request_error",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const failure = await new GatewayNarrativeModelClient(database, {})
        .text(
          runs.getRun(`run-${requestConstraint}`)!,
          step,
          "chapter-draft",
          {
            messages: [{ role: "user", content: "继续" }],
            reasoningEffort: "medium",
          },
          new AbortController().signal,
        )
        .then(
          () => null,
          (error: unknown) => error as { message: string },
        );

      expect(failure).toMatchObject({
        code: "model.invalid_request",
        retryable: false,
        message: expect.stringContaining(hint),
        details: { requestConstraint },
      });
      expect(failure?.message).not.toContain("run Probe");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      database.close();
    },
  );

  it("keeps the capabilities a run froze before the probe and honors them in later runs", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database);
    const before = createRun(database, "run-before-probe");
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return chatResponse();
      }),
    );
    const client = new GatewayNarrativeModelClient(database, {});
    const draft = (runId: string, step: typeof before.step) =>
      client.text(
        before.runs.getRun(runId)!,
        step,
        "chapter-draft",
        {
          messages: [{ role: "user", content: "继续" }],
          temperature: 0.82,
          reasoningEffort: "low",
        },
        new AbortController().signal,
      );

    // The first call freezes the (run, purpose) snapshot with unknown flags.
    await draft("run-before-probe", before.step);
    // The connection probe then records the request constraints.
    const models = new SqliteModelRepository(database);
    const model = models.get("model-writing")!;
    models.upsert({
      ...model,
      capabilities: { samplingParameters: false, maxCompletionTokens: true },
      updatedAt: "2026-08-11T00:00:01.000Z",
    });
    await draft("run-before-probe", before.step);
    const after = createRun(database, "run-after-probe");
    await draft("run-after-probe", after.step);

    expect(requests).toHaveLength(3);
    for (const body of requests.slice(0, 2)) {
      expect(body).toMatchObject({ temperature: 0.82, max_tokens: 32_000 });
      expect(body).not.toHaveProperty("max_completion_tokens");
    }
    expect(requests[2]).not.toHaveProperty("temperature");
    expect(requests[2]).not.toHaveProperty("max_tokens");
    expect(requests[2]).toMatchObject({
      max_completion_tokens: 32_000,
      reasoning_effort: "low",
    });
    database.close();
  });

  it.each([
    [32_000, 32_000],
    [128_000, 128_000],
    [256_000, 256_000],
    [1_000_000, 256_000],
  ])("clamps a %i model to the policy work window %i", (physical, expected) => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      contextWindow: physical,
      maxOutputTokens: 64_000,
    });
    const { runs } = createRun(database, `run-context-${physical}`, {
      contextWindow: 256_000,
    });
    const client = new GatewayNarrativeModelClient(database, {});
    expect(
      client.effectiveContextWindow(
        runs.getRun(`run-context-${physical}`)!,
        "chapter-draft",
      ),
    ).toBe(expected);
    database.close();
  });

  it("uses a 1M model window when the run explicitly requests 1M", () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
    });
    const { runs } = createRun(database, "run-context-million", {
      contextWindow: 1_000_000,
      explicitPolicyFields: ["contextWindow"],
    });
    const client = new GatewayNarrativeModelClient(database, {});
    expect(
      client.effectiveContextWindow(
        runs.getRun("run-context-million")!,
        "chapter-draft",
      ),
    ).toBe(1_000_000);
    database.close();
  });

  it("freezes independent planning, writing, and review assignments for context materialization", () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      role: "writing",
      taskType: "writing",
      modelRowId: "model-writing",
      modelId: "wire-writing",
    });
    seedAssignment(database, {
      role: "planning",
      taskType: "planning",
      modelRowId: "model-planning",
      modelId: "wire-planning",
    });
    seedAssignment(database, {
      role: "review",
      taskType: "review",
      modelRowId: "model-review",
      modelId: "wire-review",
    });
    const { runs } = createRun(database, "run-purpose-assignments");
    const run = runs.getRun("run-purpose-assignments")!;
    const client = new GatewayNarrativeModelClient(database, {});

    const keys = [
      client.contextMaterializationKey(run, "scene-plan"),
      client.contextMaterializationKey(run, "chapter-draft"),
      client.contextMaterializationKey(run, "semantic-review"),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(
      database.raw
        .prepare(
          `SELECT purpose, requested_role, assignment_role, model_id
           FROM model_assignment_snapshots WHERE run_id = ? ORDER BY purpose`,
        )
        .all(run.id),
    ).toEqual([
      {
        purpose: "chapter-draft",
        requested_role: "drafting",
        assignment_role: "writing",
        model_id: "model-writing",
      },
      {
        purpose: "scene-plan",
        requested_role: "planning",
        assignment_role: "planning",
        model_id: "model-planning",
      },
      {
        purpose: "semantic-review",
        requested_role: "review",
        assignment_role: "review",
        model_id: "model-review",
      },
    ]);
    database.close();
  });

  it("keeps the first per-purpose assignment snapshot across retries", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, {
      providerId: "provider-a",
      modelRowId: "model-a",
      modelId: "wire-a",
    });
    const { runs, step } = createRun(database, "run-frozen-assignment");
    const requestedModels: string[] = [];
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        requestedUrls.push(String(input));
        requestedModels.push(
          String((JSON.parse(String(init?.body)) as { model: string }).model),
        );
        return chatResponse();
      }),
    );
    const client = new GatewayNarrativeModelClient(database, {});
    await client.text(
      runs.getRun("run-frozen-assignment")!,
      step,
      "chapter-draft",
      { messages: [{ role: "user", content: "第一次" }] },
      new AbortController().signal,
    );
    seedAssignment(database, {
      providerId: "provider-b",
      modelRowId: "model-b",
      modelId: "wire-b",
    });
    const models = new SqliteModelRepository(database);
    const original = models.get("model-a")!;
    models.upsert({
      ...original,
      providerId: "provider-b",
      modelId: "wire-a-mutated",
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
      updatedAt: "2026-08-11T01:00:00.000Z",
    });
    expect(
      client.effectiveContextWindow(
        runs.getRun("run-frozen-assignment")!,
        "chapter-draft",
      ),
    ).toBe(128_000);
    expect(
      client.effectiveOutputLimit(
        runs.getRun("run-frozen-assignment")!,
        "chapter-draft",
      ),
    ).toBe(32_000);
    await client.text(
      runs.getRun("run-frozen-assignment")!,
      step,
      "chapter-draft",
      { messages: [{ role: "user", content: "重试" }] },
      new AbortController().signal,
    );

    expect(requestedModels).toEqual(["wire-a", "wire-a"]);
    expect(requestedUrls).toEqual([
      "https://provider-a.example/v1/chat/completions",
      "https://provider-a.example/v1/chat/completions",
    ]);
    database.close();
  });

  it.each(["length", "context_length"] as const)(
    "surfaces the %s finish reason for worker-level recovery",
    async (finishReason) => {
      const database = new NodeNarrativeDatabase();
      database.migrate();
      seedAssignment(database);
      const { runs, step } = createRun(database, "run-output-limit");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => chatResponse("未完正文", finishReason)),
      );
      const result = await new GatewayNarrativeModelClient(database, {}).text(
        runs.getRun("run-output-limit")!,
        step,
        "chapter-draft",
        { messages: [{ role: "user", content: "继续" }] },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ text: "未完正文", finishReason });
      database.close();
    },
  );

  it("falls planning/review back to writing but never falls embedding back", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database);
    const assignments = new SqliteAssignmentRepository(database);
    expect(assignments.resolve("planning")?.role).toBe("writing");
    expect(assignments.resolve("review")?.role).toBe("writing");
    expect(assignments.resolve("embedding")).toBeNull();
    const { runs, step } = createRun(database, "run-degrade");
    const outcome = await optionalEmbeddings(
      new GatewayNarrativeModelClient(database, {}),
      runs.getRun("run-degrade")!,
      step,
      "chapter-index",
      ["文本"],
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      vectors: [],
      modelId: null,
      degradation: {
        capability: "embedding",
        reason: "embedding_not_configured",
      },
    });
    database.close();
  });

  it("rejects a missing assignment credential before dispatch", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, { credentialRef: "env:MISSING_MODEL_KEY" });
    const { runs, step } = createRun(database, "run-credential");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new GatewayNarrativeModelClient(database, {}).text(
        runs.getRun("run-credential")!,
        step,
        "chapter-draft",
        { messages: [{ role: "user", content: "继续" }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "model.credential.missing_env" });
    expect(fetchMock).not.toHaveBeenCalled();
    database.close();
  });

  it("resolves relay:demo credential to a dummy key (D5)", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database, { credentialRef: "relay:demo" });
    const { runs, step } = createRun(database, "run-relay");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await new GatewayNarrativeModelClient(database, {}).text(
      runs.getRun("run-relay")!,
      step,
      "chapter-draft",
      { messages: [{ role: "user", content: "继续" }] },
      new AbortController().signal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    // 浏览器端只持哑 key；中继剥掉它并注入真实 key（真实 key 不在库中）。
    expect(headers.authorization).toBe("Bearer relay:demo");
    database.close();
  });
});

describe("GatewayNarrativeModelClient decisions (rerank role)", () => {
  const decisionRequest = {
    input: "O que será escrito agora: capítulo 8",
    questions: [
      {
        type: "predicate" as const,
        name: "c1",
        instructions: "Este trecho importa?",
      },
    ],
  };

  it("calls /decisions with the rerank assignment and records the call", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database);
    seedAssignment(database, {
      role: "rerank",
      modelRowId: "model-rerank",
      modelId: "gpt-6-luna",
      wireApi: "openai-responses",
    });
    // A conversation model override never replaces the rerank model.
    const { runs, step } = createRun(database, "run-rerank", {
      assistantModelId: "model-writing",
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "gpt-6-luna",
            answers: [{ type: "predicate", name: "c1", probability: 0.83 }],
            usage: {
              input_tokens: 64,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 0,
              total_tokens: 64,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GatewayNarrativeModelClient(database, {});
    expect(client.hasRerankAssignment()).toBe(true);
    const result = await client.decide(
      runs.getRun("run-rerank")!,
      step,
      "context-retrieval-rerank",
      decisionRequest,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      answers: [{ type: "predicate", name: "c1", probability: 0.83 }],
      model: "gpt-6-luna",
      modelId: "model-rerank",
      usage: { inputTokens: 64, outputTokens: 0, calls: 1 },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe("https://provider-rerank.example/v1/decisions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-6-luna",
      questions: decisionRequest.questions,
    });
    expect(
      database.raw
        .prepare(
          "SELECT model_id, model, purpose, status FROM llm_calls WHERE run_id = ?",
        )
        .all("run-rerank"),
    ).toEqual([
      {
        model_id: "model-rerank",
        model: "gpt-6-luna",
        purpose: "context-retrieval-rerank:rerank",
        status: "completed",
      },
    ]);
    database.close();
  });

  it("refuses without a rerank assignment or on an Anthropic provider", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    seedAssignment(database);
    const { runs, step } = createRun(database, "run-no-rerank");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new GatewayNarrativeModelClient(database, {});
    expect(client.hasRerankAssignment()).toBe(false);
    await expect(
      client.decide(
        runs.getRun("run-no-rerank")!,
        step,
        "context-retrieval-rerank",
        decisionRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "model.rerank_assignment.unavailable" });

    seedAssignment(database, {
      role: "rerank",
      modelRowId: "model-rerank",
      modelId: "gpt-6-luna",
      wireApi: "anthropic-messages",
    });
    await expect(
      client.decide(
        runs.getRun("run-no-rerank")!,
        step,
        "context-retrieval-rerank",
        decisionRequest,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "model.rerank_profile.unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    database.close();
  });
});
