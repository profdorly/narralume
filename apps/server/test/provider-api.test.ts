import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop();
    await resource?.app.close();
    resource?.database.close();
  }
});

async function setup() {
  const database = new NodeNarrativeDatabase();
  const environment = {
    NARRATIVE_LLM_API_KEY: "server-only-test-key",
    NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
    NARRATIVE_LLM_MODEL: "test-model",
    NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
    NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
  };
  const app = await buildApp({
    config,
    database,
    environment,
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

async function createProvider(
  app: Awaited<ReturnType<typeof buildApp>>,
  credentialRef = "raw-secret-key-abcdef",
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/providers",
    payload: {
      name: "自建 Provider",
      wireApi: "openai-chat",
      baseUrl: "https://custom.example.com/v1",
      credentialRef,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as {
    id: string;
    credentialRef: string;
    updatedAt: string;
  };
}

describe("provider/model/assignment API", () => {
  it("creates and updates providers without ever exposing the raw credential", async () => {
    const { app } = await setup();
    const created = await createProvider(app);
    expect(created.credentialRef).toBe("••••cdef");

    const listed = await app.inject({ method: "GET", url: "/api/providers" });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain("raw-secret-key-abcdef");
    const row = (listed.json() as { id: string; credentialRef: string }[]).find(
      (provider) => provider.id === created.id,
    )!;
    expect(row.credentialRef).toBe("••••cdef");

    // Omitting credentialRef keeps the stored credential.
    const updated = await app.inject({
      method: "PUT",
      url: `/api/providers/${created.id}`,
      payload: {
        name: "自建 Provider（改名）",
        wireApi: "openai-chat",
        baseUrl: "https://custom.example.com/v2",
        expectedUpdatedAt: created.updatedAt,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      id: created.id,
      name: "自建 Provider（改名）",
      baseUrl: "https://custom.example.com/v2",
      credentialRef: "••••cdef",
    });

    // A short replacement credential is fully masked.
    const rotated = await app.inject({
      method: "PUT",
      url: `/api/providers/${created.id}`,
      payload: {
        name: "自建 Provider（改名）",
        wireApi: "openai-chat",
        baseUrl: "https://custom.example.com/v2",
        credentialRef: "short",
        expectedUpdatedAt: updated.json().updatedAt,
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().credentialRef).toBe("••••••••");
    expect(rotated.body).not.toContain("short");

    const stale = await app.inject({
      method: "PUT",
      url: `/api/providers/${created.id}`,
      payload: {
        name: "旧页面覆盖",
        wireApi: "openai-chat",
        baseUrl: "https://stale.example.com/v1",
        expectedUpdatedAt: created.updatedAt,
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "provider.version.conflict" },
    });

    const missing = await app.inject({
      method: "PUT",
      url: "/api/providers/does-not-exist",
      payload: {
        name: "不存在",
        wireApi: "openai-chat",
        baseUrl: "https://custom.example.com/v1",
        expectedUpdatedAt: "missing",
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "provider.not_found" },
    });
  });

  it("requires a credentialRef when creating a provider", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "缺密钥",
        wireApi: "openai-chat",
        baseUrl: "https://custom.example.com/v1",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "provider.credential.required" },
    });
  });

  it("manages models with duplicate and reference checks", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);

    const missingProvider = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: "nope", modelId: "m" },
    });
    expect(missingProvider.statusCode).toBe(404);
    expect(missingProvider.json()).toMatchObject({
      error: { code: "provider.not_found" },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: {
        providerId: provider.id,
        modelId: "writer-v1",
        taskType: "writing",
        contextWindow: 32_000,
        maxOutputTokens: 8_000,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      metadataSource: "manual",
      metadataVerifiedAt: expect.any(String),
    });
    const createdModel = created.json() as { id: string; updatedAt: string };
    const modelId = createdModel.id;

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: "model.duplicate" },
    });

    const filtered = await app.inject({
      method: "GET",
      url: `/api/models?providerId=${provider.id}`,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toEqual([
      expect.objectContaining({ id: modelId, modelId: "writer-v1" }),
    ]);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/models/${modelId}`,
      payload: {
        providerId: provider.id,
        modelId: "writer-v1",
        taskType: "writing",
        contextWindow: 64_000,
        maxOutputTokens: 16_000,
        enabled: true,
        expectedUpdatedAt: createdModel.updatedAt,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ id: modelId, enabled: true });

    const staleModel = await app.inject({
      method: "PUT",
      url: `/api/models/${modelId}`,
      payload: {
        providerId: provider.id,
        modelId: "writer-v1",
        taskType: "writing",
        contextWindow: 1_000,
        maxOutputTokens: 1_000,
        enabled: true,
        expectedUpdatedAt: createdModel.updatedAt,
      },
    });
    expect(staleModel.statusCode, staleModel.body).toBe(409);
    expect(staleModel.json()).toMatchObject({
      error: { code: "model.version.conflict" },
    });

    // Assignments reference the model and block its deletion.
    const assigned = await app.inject({
      method: "PUT",
      url: "/api/assignments/writing",
      payload: { modelId },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json()).toMatchObject({ role: "writing", modelId });

    for (const role of ["planning", "review"] as const) {
      const inheritedModel = await app.inject({
        method: "PUT",
        url: `/api/assignments/${role}`,
        payload: { modelId },
      });
      expect(inheritedModel.statusCode, inheritedModel.body).toBe(200);
      expect(inheritedModel.json()).toMatchObject({ role, modelId });
    }

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/models/${modelId}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "model.assignment_in_use" },
    });

    const removedAssignment = await app.inject({
      method: "DELETE",
      url: "/api/assignments/writing",
    });
    expect(removedAssignment.statusCode).toBe(204);
    for (const role of ["planning", "review"] as const) {
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/assignments/${role}`,
      });
      expect(removed.statusCode).toBe(204);
    }

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/models/${modelId}`,
    });
    expect(deleted.statusCode).toBe(204);

    const missingAssignment = await app.inject({
      method: "PUT",
      url: "/api/assignments/review",
      payload: { modelId: "missing-model" },
    });
    expect(missingAssignment.statusCode).toBe(422);
    expect(missingAssignment.json()).toMatchObject({
      error: { code: "assignment.model.not_found" },
    });
  });

  it("refuses to delete environment-managed providers and models", async () => {
    const { app } = await setup();
    const provider = await app.inject({
      method: "DELETE",
      url: "/api/providers/environment-chat",
    });
    expect(provider.statusCode).toBe(409);
    expect(provider.json()).toMatchObject({
      error: { code: "provider.environment_managed" },
    });
    const model = await app.inject({
      method: "DELETE",
      url: "/api/models/environment-chat",
    });
    expect(model.statusCode).toBe(409);
    expect(model.json()).toMatchObject({
      error: { code: "model.environment_managed" },
    });
  });

  it("blocks provider deletion while its models are assignment targets", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const model = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: {
        providerId: provider.id,
        modelId: "writer-v1",
        contextWindow: 64_000,
        maxOutputTokens: 16_000,
      },
    });
    const modelId = (model.json() as { id: string }).id;
    await app.inject({
      method: "PUT",
      url: "/api/assignments/writing",
      payload: { modelId },
    });
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/providers/${provider.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "provider.assignment_in_use" },
    });
  });

  it("blocks provider deletion while it still owns an unassigned model", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "unassigned-v1" },
    });

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/providers/${provider.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "provider.models_in_use" },
    });
  });

  it("probes a provider/model pair and reports credential failures without network", async () => {
    const { app } = await setup();
    const missingProvider = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { providerId: "nope", modelId: "nope" },
    });
    expect(missingProvider.statusCode).toBe(404);
    expect(missingProvider.json()).toMatchObject({
      error: { code: "provider.not_found" },
    });

    const provider = await createProvider(app, "env:NARRATIVE_UNSET_PROBE_KEY");
    const model = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    const modelId = (model.json() as { id: string }).id;

    const missingModel = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { providerId: provider.id, modelId: "nope" },
    });
    expect(missingModel.statusCode).toBe(404);
    expect(missingModel.json()).toMatchObject({
      error: { code: "model.not_found" },
    });

    const probed = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { providerId: provider.id, modelId },
    });
    expect(probed.statusCode, probed.body).toBe(200);
    expect(probed.json()).toMatchObject({
      providerId: provider.id,
      modelId,
      stages: [
        {
          stage: "text",
          status: "failed",
          detail:
            "Environment variable NARRATIVE_UNSET_PROBE_KEY is not configured",
        },
      ],
    });
  });

  it("probe refreshes capability flags but never rewrites wireApi or modelId", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const modelId = (created.json() as { id: string }).id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        if (body.stream === true) return probeStreamResponse();
        if (Array.isArray(body.tools)) {
          return probeChatResponse({
            id: "chatcmpl-tool",
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "echo_probe",
                        arguments: '{"value":"lantern"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          });
        }
        if (body.response_format)
          return probeChatResponse(probeText('{"ok":true}'));
        return probeChatResponse(probeText("OK"));
      }),
    );
    try {
      const probed = await app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: { providerId: provider.id, modelId },
      });
      expect(probed.statusCode, probed.body).toBe(200);
      const stages = (
        probed.json() as { stages: { stage: string; status: string }[] }
      ).stages;
      expect(stages).toEqual([
        expect.objectContaining({ stage: "text", status: "passed" }),
        expect.objectContaining({ stage: "stream", status: "passed" }),
        expect.objectContaining({ stage: "tool", status: "passed" }),
        expect.objectContaining({
          stage: "structured-output",
          status: "passed",
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    // The probe must only touch capability flags: wire identity is unchanged.
    const providers = await app.inject({
      method: "GET",
      url: "/api/providers",
    });
    const storedProvider = (
      providers.json() as Array<Record<string, unknown>>
    ).find((candidate) => candidate.id === provider.id)!;
    expect(storedProvider).toMatchObject({
      wireApi: "openai-chat",
      baseUrl: "https://custom.example.com/v1",
    });
    const models = await app.inject({ method: "GET", url: "/api/models" });
    const storedModel = (models.json() as Array<Record<string, unknown>>).find(
      (candidate) => candidate.id === modelId,
    )!;
    expect(storedModel.modelId).toBe("writer-v1");
    expect(storedModel.capabilities).toMatchObject({
      streaming: true,
      tools: true,
      structuredOutput: true,
      structuredOutputNative: true,
      structuredOutputJsonMode: false,
      samplingParameters: true,
      maxCompletionTokens: false,
    });
  });

  it("probe measures streaming, tools and structured output without a rejected reasoning effort", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "gpt-general" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const modelId = (created.json() as { id: string }).id;

    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        bodies.push(body);
        if ("reasoning_effort" in body) {
          // OpenAI non-reasoning chat models.
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
                type: "invalid_request_error",
                param: "reasoning_effort",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return probeAllStagesResponse(body);
      }),
    );
    try {
      const probed = await app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: { providerId: provider.id, modelId },
      });
      expect(probed.statusCode, probed.body).toBe(200);
      const stages = (
        probed.json() as { stages: { stage: string; status: string }[] }
      ).stages;
      // Chapter tasks send the effort, so the text stage fails and says so.
      expect(stages).toEqual([
        expect.objectContaining({
          stage: "text",
          status: "failed",
          detail: expect.stringContaining(
            'reasoning effort "low" rejected: chapter, import and other narrative tasks send a reasoning effort',
          ),
        }),
        expect.objectContaining({ stage: "stream", status: "passed" }),
        expect.objectContaining({ stage: "tool", status: "passed" }),
        expect.objectContaining({
          stage: "structured-output",
          status: "passed",
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
    for (const body of bodies.slice(1)) {
      expect(body).not.toHaveProperty("reasoning_effort");
    }

    // The effort rejection is no evidence against streaming, tools or
    // structured output, which runs without an effort (the assistant with
    // reasoning off) rely on.
    const models = await app.inject({ method: "GET", url: "/api/models" });
    expect(
      (
        models.json() as Array<{
          id: string;
          capabilities: Record<string, boolean>;
        }>
      ).find((candidate) => candidate.id === modelId)?.capabilities,
    ).toEqual({
      streaming: true,
      tools: true,
      structuredOutput: true,
      structuredOutputNative: true,
      structuredOutputJsonMode: false,
      samplingParameters: true,
      maxCompletionTokens: false,
    });
  });

  it("probe records the request shape a reasoning model accepts", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "gpt-reasoner" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const modelId = (created.json() as { id: string }).id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        const rejected =
          "temperature" in body
            ? "Unsupported parameter: 'temperature' is not supported with this model."
            : "max_tokens" in body
              ? "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
              : null;
        if (rejected !== null) {
          return new Response(
            JSON.stringify({
              error: { message: rejected, type: "invalid_request_error" },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return probeChatResponse(probeText("OK"));
      }),
    );
    try {
      const probed = await app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: {
          providerId: provider.id,
          modelId,
          includeStreaming: false,
          includeTools: false,
          includeStructuredOutput: false,
        },
      });
      expect(probed.statusCode, probed.body).toBe(200);
      expect(probed.json()).toMatchObject({
        stages: [
          {
            stage: "text",
            status: "passed",
            requestCapabilities: {
              samplingParameters: false,
              maxCompletionTokens: true,
            },
          },
          { stage: "stream", status: "skipped" },
          { stage: "tool", status: "skipped" },
          { stage: "structured-output", status: "skipped" },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const models = await app.inject({ method: "GET", url: "/api/models" });
    const storedModel = (models.json() as Array<Record<string, unknown>>).find(
      (candidate) => candidate.id === modelId,
    )!;
    expect(storedModel.capabilities).toMatchObject({
      samplingParameters: false,
      maxCompletionTokens: true,
    });
  });

  it("probe leaves request-shape flags unchanged without an accepted text request", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: {
        providerId: provider.id,
        modelId: "gpt-reasoner",
        capabilities: { samplingParameters: false, maxCompletionTokens: true },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const modelId = (created.json() as { id: string }).id;
    const unprobed = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "gpt-unprobed" },
    });
    expect(unprobed.statusCode, unprobed.body).toBe(201);
    const unprobedId = (unprobed.json() as { id: string }).id;

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Incorrect API key" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    try {
      for (const id of [modelId, unprobedId]) {
        const probed = await app.inject({
          method: "POST",
          url: "/api/providers/test",
          payload: {
            providerId: provider.id,
            modelId: id,
            includeStreaming: false,
            includeTools: false,
            includeStructuredOutput: false,
          },
        });
        expect(probed.statusCode, probed.body).toBe(200);
        expect(probed.json()).toMatchObject({
          stages: [{ stage: "text", status: "failed" }, {}, {}, {}],
        });
        expect(
          (probed.json() as { stages: Record<string, unknown>[] }).stages[0],
        ).not.toHaveProperty("requestCapabilities");
      }
    } finally {
      vi.unstubAllGlobals();
    }

    const models = (
      await app.inject({ method: "GET", url: "/api/models" })
    ).json() as Array<{ id: string; capabilities: Record<string, boolean> }>;
    expect(
      models.find((candidate) => candidate.id === modelId)?.capabilities,
    ).toMatchObject({ samplingParameters: false, maxCompletionTokens: true });
    const unprobedCapabilities = models.find(
      (candidate) => candidate.id === unprobedId,
    )?.capabilities;
    expect(unprobedCapabilities).not.toHaveProperty("samplingParameters");
    expect(unprobedCapabilities).not.toHaveProperty("maxCompletionTokens");
  });

  it("probe writes maxCompletionTokens only for Chat Completions providers", async () => {
    const { app } = await setup();
    const providerResponse = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "Responses Provider",
        wireApi: "openai-responses",
        baseUrl: "https://custom.example.com/v1",
        credentialRef: "raw-secret-key-abcdef",
      },
    });
    expect(providerResponse.statusCode, providerResponse.body).toBe(201);
    const provider = providerResponse.json() as { id: string };
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "responses-writer" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const modelId = (created.json() as { id: string }).id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        probeChatResponse({
          id: "resp-probe",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK" }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        }),
      ),
    );
    try {
      const probed = await app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: {
          providerId: provider.id,
          modelId,
          includeStreaming: false,
          includeTools: false,
          includeStructuredOutput: false,
        },
      });
      expect(probed.statusCode, probed.body).toBe(200);
      expect(probed.json()).toMatchObject({
        stages: [{ stage: "text", status: "passed" }, {}, {}, {}],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const models = (
      await app.inject({ method: "GET", url: "/api/models" })
    ).json() as Array<{ id: string; capabilities: Record<string, boolean> }>;
    const capabilities = models.find(
      (candidate) => candidate.id === modelId,
    )?.capabilities;
    expect(capabilities).toMatchObject({ samplingParameters: true });
    expect(capabilities).not.toHaveProperty("maxCompletionTokens");
  });

  it("probe records the accepted request shape even when the text stage then fails", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "gpt-reasoner" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const modelId = (created.json() as { id: string }).id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        if ("temperature" in body) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "Unsupported parameter: 'temperature' is not supported with this model.",
                type: "invalid_request_error",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        // Accepted, but the whole budget went to reasoning.
        return probeChatResponse({
          id: "chatcmpl-empty",
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 2, completion_tokens: 1024 },
        });
      }),
    );
    try {
      const probed = await app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: {
          providerId: provider.id,
          modelId,
          includeStreaming: false,
          includeTools: false,
          includeStructuredOutput: false,
        },
      });
      expect(probed.statusCode, probed.body).toBe(200);
      expect(probed.json()).toMatchObject({
        stages: [
          {
            stage: "text",
            status: "failed",
            detail: expect.stringContaining(
              "temperature omitted: the model rejects sampling parameters, so runs omit temperature and top_p",
            ),
            requestCapabilities: {
              samplingParameters: false,
              maxCompletionTokens: false,
            },
          },
          {},
          {},
          {},
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const models = (
      await app.inject({ method: "GET", url: "/api/models" })
    ).json() as Array<{ id: string; capabilities: Record<string, boolean> }>;
    expect(
      models.find((candidate) => candidate.id === modelId)?.capabilities,
    ).toMatchObject({ samplingParameters: false, maxCompletionTokens: false });
  });

  it("clears probe-written capability flags when a model is re-pointed", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const otherProvider = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "Gateway Provider",
        wireApi: "openai-chat",
        baseUrl: "https://gateway.example.com/v1",
        credentialRef: "raw-secret-key-ghijkl",
      },
    });
    expect(otherProvider.statusCode, otherProvider.body).toBe(201);
    const otherProviderId = (otherProvider.json() as { id: string }).id;
    const probed = {
      streaming: true,
      tools: false,
      structuredOutput: true,
      structuredOutputNative: false,
      structuredOutputJsonMode: true,
      samplingParameters: false,
      maxCompletionTokens: true,
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: {
        providerId: provider.id,
        modelId: "gpt-reasoner",
        capabilities: { ...probed, reasoning: true },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    let model = created.json() as {
      id: string;
      updatedAt: string;
      capabilities: Record<string, boolean>;
    };
    const edit = async (change: {
      providerId?: string;
      modelId?: string;
      capabilities?: Record<string, boolean>;
    }) => {
      const response = await app.inject({
        method: "PUT",
        url: `/api/models/${model.id}`,
        payload: {
          providerId: change.providerId ?? provider.id,
          modelId: change.modelId ?? "gpt-reasoner",
          taskType: "writing",
          contextWindow: 64_000,
          maxOutputTokens: 8_000,
          // The settings form round-trips the stored capabilities.
          capabilities: change.capabilities ?? model.capabilities,
          enabled: true,
          expectedUpdatedAt: model.updatedAt,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      model = response.json() as typeof model;
      return model.capabilities;
    };

    // Same identity: the round-tripped flags are kept.
    expect(await edit({})).toEqual({ ...probed, reasoning: true });
    // New upstream model: every probe-written flag returns to unknown, flags
    // the probe never writes stay.
    expect(await edit({ modelId: "gpt-general" })).toEqual({ reasoning: true });
    // Same identity again: explicitly submitted flags are stored as given.
    expect(
      await edit({
        modelId: "gpt-general",
        capabilities: { ...probed, reasoning: true },
      }),
    ).toEqual({ ...probed, reasoning: true });
    // New provider for the same upstream model name: cleared as well.
    expect(
      await edit({ providerId: otherProviderId, modelId: "gpt-general" }),
    ).toEqual({ reasoning: true });
  });

  it("clears probe-written flags of a Provider's models when its base URL, endpoint or wire API changes", async () => {
    const { app } = await setup();
    let provider = await createProvider(app);
    const otherProvider = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "Gateway Provider",
        wireApi: "openai-chat",
        baseUrl: "https://gateway.example.com/v1",
        credentialRef: "raw-secret-key-ghijkl",
      },
    });
    expect(otherProvider.statusCode, otherProvider.body).toBe(201);
    const otherProviderId = (otherProvider.json() as { id: string }).id;
    const probed = {
      streaming: true,
      tools: false,
      structuredOutput: true,
      structuredOutputNative: false,
      structuredOutputJsonMode: true,
      samplingParameters: false,
      maxCompletionTokens: true,
    };
    const createModel = async (providerId: string, modelId: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/models",
        payload: {
          providerId,
          modelId,
          capabilities: { ...probed, reasoning: true },
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      return (response.json() as { id: string }).id;
    };
    const writer = await createModel(provider.id, "gpt-writer");
    const planner = await createModel(provider.id, "gpt-planner");
    const elsewhere = await createModel(otherProviderId, "gpt-writer");
    const stored = async () =>
      new Map(
        (
          (await app.inject({ method: "GET", url: "/api/models" })).json() as {
            id: string;
            updatedAt: string;
            capabilities: Record<string, boolean>;
          }[]
        ).map((model) => [model.id, model]),
      );
    const reprobe = async (id: string) => {
      const model = (await stored()).get(id)!;
      const response = await app.inject({
        method: "PUT",
        url: `/api/models/${id}`,
        payload: {
          providerId: provider.id,
          modelId: id === writer ? "gpt-writer" : "gpt-planner",
          taskType: "writing",
          capabilities: { ...probed, reasoning: true },
          enabled: true,
          expectedUpdatedAt: model.updatedAt,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const editProvider = async (change: {
      name?: string;
      wireApi?: string;
      baseUrl?: string;
      endpoint?: string | null;
    }) => {
      const response = await app.inject({
        method: "PUT",
        url: `/api/providers/${provider.id}`,
        payload: {
          name: change.name ?? "自建 Provider",
          wireApi: change.wireApi ?? "openai-chat",
          baseUrl: change.baseUrl ?? "https://custom.example.com/v1",
          endpoint: change.endpoint ?? null,
          expectedUpdatedAt: provider.updatedAt,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      provider = response.json() as typeof provider;
    };

    // Same transport: flags and model versions are kept.
    const before = await stored();
    await editProvider({ name: "改名 Provider" });
    let after = await stored();
    for (const id of [writer, planner, elsewhere]) {
      expect(after.get(id)).toEqual(before.get(id));
    }

    // New base URL: every model under the Provider returns to unknown for the
    // probe-written flags and gets a new version; other Providers' models
    // keep theirs.
    await editProvider({ baseUrl: "https://proxy.example.com/v1" });
    after = await stored();
    expect(after.get(writer)?.capabilities).toEqual({ reasoning: true });
    expect(after.get(planner)?.capabilities).toEqual({ reasoning: true });
    expect(after.get(writer)?.updatedAt).not.toBe(
      before.get(writer)?.updatedAt,
    );
    expect(after.get(elsewhere)).toEqual(before.get(elsewhere));

    // New endpoint and new wire API clear them as well.
    await reprobe(writer);
    await editProvider({
      baseUrl: "https://proxy.example.com/v1",
      endpoint: "/chat/completions",
    });
    expect((await stored()).get(writer)?.capabilities).toEqual({
      reasoning: true,
    });
    await reprobe(writer);
    await editProvider({
      baseUrl: "https://proxy.example.com/v1",
      endpoint: "/chat/completions",
      wireApi: "openai-responses",
    });
    expect((await stored()).get(writer)?.capabilities).toEqual({
      reasoning: true,
    });
  });

  it("allows changing a Provider's base URL after one of its models has run history and clears its probe-written flags", async () => {
    const { app, database } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: {
        providerId: provider.id,
        modelId: "gpt-writer",
        capabilities: {
          reasoning: true,
          streaming: true,
          samplingParameters: false,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const model = created.json() as { id: string; updatedAt: string };
    database.raw
      .prepare(
        `INSERT INTO llm_calls(
           id, model_id, protocol, model, purpose, request_hash, status,
           started_at
         ) VALUES (?, ?, 'openai-chat', 'gpt-writer', 'chapter-draft', 'h',
           'completed', ?)`,
      )
      .run("call-history", model.id, new Date().toISOString());

    // A mistyped base URL stays fixable even though the model has run
    // history; runs in progress keep their frozen snapshots.
    const edited = await app.inject({
      method: "PUT",
      url: `/api/providers/${provider.id}`,
      payload: {
        name: "自建 Provider",
        wireApi: "openai-chat",
        baseUrl: "https://proxy.example.com/v1",
        expectedUpdatedAt: provider.updatedAt,
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({
      baseUrl: "https://proxy.example.com/v1",
    });
    const models = (
      await app.inject({ method: "GET", url: "/api/models" })
    ).json() as { id: string; updatedAt: string; capabilities: object }[];
    const stored = models.find((candidate) => candidate.id === model.id);
    expect(stored?.capabilities).toEqual({ reasoning: true });
    expect(stored?.updatedAt).not.toBe(model.updatedAt);
  });

  it("refuses the write-back of a probe that measured a Provider's previous base URL", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const model = created.json() as { id: string };

    let markStarted!: () => void;
    let releaseProbe!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        markStarted();
        await gate;
        return probeChatResponse(probeText("OK"));
      }),
    );
    try {
      const probing = app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: {
          providerId: provider.id,
          modelId: model.id,
          includeStreaming: false,
          includeTools: false,
          includeStructuredOutput: false,
        },
      });
      await started;
      const edited = await app.inject({
        method: "PUT",
        url: `/api/providers/${provider.id}`,
        payload: {
          name: "自建 Provider",
          wireApi: "openai-chat",
          baseUrl: "https://proxy.example.com/v1",
          expectedUpdatedAt: provider.updatedAt,
        },
      });
      expect(edited.statusCode, edited.body).toBe(200);
      releaseProbe();

      const result = await probing;
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json()).toMatchObject({
        error: { code: "model.version.conflict" },
      });
      const listed = await app.inject({ method: "GET", url: "/api/models" });
      expect(
        listed
          .json()
          .find((candidate: { id: string }) => candidate.id === model.id),
      ).toMatchObject({ capabilities: {} });
    } finally {
      releaseProbe();
      vi.unstubAllGlobals();
    }
  });

  it("does not overwrite a model edited while its connection probe is running (CR-48)", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const model = created.json() as { id: string; updatedAt: string };

    let markStarted!: () => void;
    let releaseProbe!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        markStarted();
        await gate;
        return probeChatResponse(probeText("OK"));
      }),
    );
    try {
      const probing = app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: {
          providerId: provider.id,
          modelId: model.id,
          includeStreaming: false,
          includeTools: false,
          includeStructuredOutput: false,
        },
      });
      await started;
      const edited = await app.inject({
        method: "PUT",
        url: `/api/models/${model.id}`,
        payload: {
          providerId: provider.id,
          modelId: "writer-v1",
          taskType: "writing",
          contextWindow: 64_000,
          maxOutputTokens: 8_000,
          enabled: true,
          expectedUpdatedAt: model.updatedAt,
        },
      });
      expect(edited.statusCode, edited.body).toBe(200);
      releaseProbe();

      const result = await probing;
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json()).toMatchObject({
        error: { code: "model.version.conflict" },
      });
      const listed = await app.inject({ method: "GET", url: "/api/models" });
      expect(
        listed
          .json()
          .find((candidate: { id: string }) => candidate.id === model.id),
      ).toMatchObject({
        contextWindow: 64_000,
        maxOutputTokens: 8_000,
        capabilities: {},
      });
    } finally {
      releaseProbe();
      vi.unstubAllGlobals();
    }
  });
});

function probeText(content: string) {
  return {
    id: "chatcmpl-probe",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

function probeChatResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Chat Completions replies for every probe stage of an accepted request. */
function probeAllStagesResponse(body: Record<string, unknown>): Response {
  if (body.stream === true) return probeStreamResponse();
  if (Array.isArray(body.tools)) {
    return probeChatResponse({
      id: "chatcmpl-tool",
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "echo_probe",
                  arguments: '{"value":"lantern"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
  }
  return probeChatResponse(
    probeText(body.response_format ? '{"ok":true}' : "OK"),
  );
}

function probeStreamResponse(): Response {
  const frames = [
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      choices: [{ delta: { content: "OK" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(new TextEncoder().encode(frames.join("")), {
    headers: { "content-type": "text/event-stream" },
  });
}
