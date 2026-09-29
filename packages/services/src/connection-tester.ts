import {
  ModelError,
  ModelGateway,
  createModelAdapter,
  isMaxTokensUnsupportedError,
  isSamplingParameterUnsupportedError,
  type AdapterConfig,
  type FetchLike,
  type ModelProtocol,
  type ModelRequest,
  type ModelResponse,
} from "@narralume/llm";

/**
 * Reasoning effort of every probe request. Narrative task workers send a
 * reasoning effort ("low" or "medium"; the assistant omits it only when the
 * author turns reasoning off), and chapter workers send "low" together with
 * a temperature. Some models accept temperature/top_p only at particular
 * efforts, so the probe measures that chapter request shape; a model that
 * rejects reasoning effort altogether fails the probe as it fails chapter
 * tasks.
 */
export const PROBE_REASONING_EFFORT = "low" as const;

/**
 * Output budget of every probe request. It is the whole completion budget,
 * reasoning tokens included (max_completion_tokens, Responses
 * max_output_tokens), so a reasoning model needs room to finish reasoning
 * before it emits the short probe answer.
 */
export const PROBE_MAX_OUTPUT_TOKENS = 1_024;

export interface ConnectionTestOptions {
  includeStreaming: boolean;
  includeTools: boolean;
  includeStructuredOutput: boolean;
}

/** Winning structured-output tier of the probe, cheapest first. */
export type StructuredProbeCapability =
  "native" | "json-mode" | "prompt" | "none";

/**
 * Request shape the provider accepted in the text stage (sent with
 * PROBE_REASONING_EFFORT), stored as the model capabilities of the same name.
 * - samplingParameters: false when temperature/top_p had to be omitted.
 * - maxCompletionTokens: true when the output limit had to be sent as
 *   max_completion_tokens (openai-chat only; always false elsewhere).
 */
export interface ProbeRequestCapabilities {
  samplingParameters: boolean;
  maxCompletionTokens: boolean;
}

export interface ConnectionTestStage {
  stage: "text" | "stream" | "tool" | "structured-output";
  status: "passed" | "failed" | "unsupported" | "skipped";
  latencyMs: number;
  detail: string;
  /** Set only on the structured-output stage. */
  capability?: StructuredProbeCapability;
  /**
   * Set only on the text stage, once the provider accepted a text request
   * (HTTP success), even when the response then fails the text check.
   */
  requestCapabilities?: ProbeRequestCapabilities;
}

export interface ConnectionTestProfile {
  id: string;
  name: string;
  protocol: ModelProtocol;
  baseUrl: string;
  endpoint: string | null;
  model: string;
  apiKeyEnv: string;
  anthropicVersion: string | null;
  extraHeaders: Readonly<Record<string, string>>;
  capabilities: Readonly<Record<string, boolean>>;
  queryParams?: Readonly<Record<string, string>>;
}

export async function testModelConnection(
  profile: ConnectionTestProfile,
  options: ConnectionTestOptions,
  environment: Readonly<Record<string, string | undefined>> = {},
  dependencies: { fetch?: FetchLike } = {},
): Promise<ConnectionTestStage[]> {
  const apiKey = environment[profile.apiKeyEnv]?.trim();
  if (!apiKey) {
    return [
      {
        stage: "text",
        status: "failed",
        latencyMs: 0,
        detail: `Environment variable ${profile.apiKeyEnv} is not configured`,
      },
    ];
  }

  const adapterConfig = (maxCompletionTokens: boolean): AdapterConfig => ({
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    apiKey,
    ...(profile.endpoint === null ? {} : { endpoint: profile.endpoint }),
    ...(profile.anthropicVersion === null
      ? {}
      : { anthropicVersion: profile.anthropicVersion }),
    ...(maxCompletionTokens
      ? { chatOutputTokenParameter: "max_completion_tokens" as const }
      : {}),
    headers: profile.extraHeaders,
    ...(profile.queryParams === undefined
      ? {}
      : { queryParams: profile.queryParams }),
    timeoutMs: 45_000,
    maxRetries: 1,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  });
  let gateway = new ModelGateway(createModelAdapter(adapterConfig(false)));
  let base: ModelRequest = {
    model: profile.model,
    instructions:
      "This is a connection probe. Follow the requested output exactly.",
    messages: [{ role: "user", content: "Reply with exactly OK." }],
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    // The chapter-worker request shape: a reasoning effort together with a
    // temperature, so samplingParameters describes what runs actually send.
    reasoningEffort: PROBE_REASONING_EFFORT,
    temperature: 0,
  };
  // Request-shape evidence gathered by the text stage. It counts as evidence
  // once the provider accepts a request, whether or not the response then
  // passes the text check. Every later stage reuses the accepted shape so a
  // model that rejects sampling parameters or max_tokens (e.g. OpenAI
  // reasoning models) is probed on its capabilities.
  const requestCapabilities: ProbeRequestCapabilities = {
    samplingParameters: true,
    maxCompletionTokens: false,
  };
  let requestAccepted = false;
  // Adjustments and explanations, reported in the text stage detail whether
  // the stage passes or fails.
  const notes: string[] = [];
  const stages: ConnectionTestStage[] = [];

  const textStage = await runStage("text", async () => {
    let response: ModelResponse | undefined;
    // Bounded: each request constraint is adjusted at most once, so at most
    // two extra requests follow the first one.
    while (response === undefined) {
      try {
        response = await gateway.generate(base, { stream: false });
      } catch (error) {
        if (
          requestCapabilities.samplingParameters &&
          isSamplingParameterUnsupportedError(error)
        ) {
          requestCapabilities.samplingParameters = false;
          base = withoutSamplingParameters(base);
          notes.push(
            "temperature/top_p omitted: model rejects sampling parameters",
          );
        } else if (
          profile.protocol === "openai-chat" &&
          !requestCapabilities.maxCompletionTokens &&
          isMaxTokensUnsupportedError(error)
        ) {
          requestCapabilities.maxCompletionTokens = true;
          gateway = new ModelGateway(createModelAdapter(adapterConfig(true)));
          notes.push("max_completion_tokens sent: model rejects max_tokens");
        } else {
          if (isReasoningEffortRejection(error)) {
            notes.push(
              `the probe sends reasoning effort "${PROBE_REASONING_EFFORT}" like chapter tasks do, so tasks on this model are rejected the same way`,
            );
          }
          throw error;
        }
      }
    }
    requestAccepted = true;
    if (!response.text.trim()) {
      throw new Error(
        `The response contains no text; finish reason: ${response.finishReason}`,
      );
    }
    return `Received ${response.text.trim().length} characters; finish reason: ${response.finishReason}`;
  });
  stages.push({
    ...textStage,
    ...(notes.length === 0
      ? {}
      : { detail: `${textStage.detail} (${notes.join("; ")})` }),
    ...(requestAccepted
      ? { requestCapabilities: { ...requestCapabilities } }
      : {}),
  });

  stages.push(
    options.includeStreaming
      ? await runStage("stream", async () => {
          let deltas = 0;
          let characters = 0;
          for await (const event of gateway.stream(base, { stream: true })) {
            if (event.type === "error") throw new Error(event.error.message);
            if (event.type === "text.delta") {
              deltas += 1;
              characters += event.text.length;
            }
          }
          if (deltas === 0) throw new Error("No text deltas received");
          return `Received ${deltas} text deltas, ${characters} characters in total`;
        })
      : skipped("stream"),
  );

  stages.push(
    options.includeTools
      ? await runStage("tool", async () => {
          const toolRequest: ModelRequest = {
            ...base,
            maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
            messages: [
              {
                role: "user",
                content:
                  'You must call echo_probe once with {"value":"lantern"}. Do not answer in text.',
              },
            ],
            tools: [
              {
                name: "echo_probe",
                description:
                  "Echo a value for an API capability test. Always use this tool for this probe.",
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["value"],
                  properties: { value: { type: "string", const: "lantern" } },
                },
                strict: true,
              },
            ],
            toolChoice: { name: "echo_probe" },
          };
          let forcedChoice = true;
          const response = await gateway
            .generate(toolRequest, { stream: false })
            .catch(async (error: unknown) => {
              if (!isToolChoiceCompatibilityError(error)) throw error;
              forcedChoice = false;
              return gateway.generate(
                { ...toolRequest, toolChoice: "auto" },
                { stream: false },
              );
            });
          const call = response.toolCalls.find(
            (candidate) => candidate.name === "echo_probe",
          );
          if (!call)
            throw new Error(
              "The model did not return the echo_probe tool call",
            );
          return `Tool call and JSON arguments parsed (${forcedChoice ? "forced" : "auto fallback"}; call id ${call.callId.length} chars)`;
        })
      : skipped("tool"),
  );

  stages.push(
    options.includeStructuredOutput
      ? await runStructuredOutputStage(gateway, base)
      : skipped("structured-output"),
  );

  return stages;
}

async function runStructuredOutputStage(
  gateway: ModelGateway,
  base: ModelRequest,
): Promise<ConnectionTestStage> {
  const start = performance.now();
  const finish = (
    status: ConnectionTestStage["status"],
    detail: string,
    capability: StructuredProbeCapability,
  ): ConnectionTestStage => ({
    stage: "structured-output",
    status,
    latencyMs: Math.round(performance.now() - start),
    detail,
    capability,
  });
  const schemaRequest: ModelRequest = {
    ...base,
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: "user",
        content: "Return an object with ok set to true.",
      },
    ],
    responseSchema: {
      name: "connection_probe",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean", const: true } },
      },
    },
  };
  const tierErrors: string[] = [];

  // Probe the format tiers explicitly, cheapest first: native json_schema,
  // then JSON mode (json_object) where the adapter supports it.
  for (const mode of ["native", "json-mode"] as const) {
    if (!gateway.supportsStructuredMode(mode)) continue;
    try {
      const response = await gateway.generate(
        { ...schemaRequest, structuredMode: mode },
        { stream: false },
      );
      if (validateProbe(parseProbeJson(response.text)).success) {
        return finish(
          "passed",
          mode === "native"
            ? "Native JSON Schema output passed"
            : "JSON mode (json_object) output passed",
          mode,
        );
      }
      tierErrors.push(`${mode} output failed strict local validation`);
    } catch (error) {
      tierErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Last resort: schema in the prompt with strict local validation.
  try {
    await gateway.generateStructured(schemaRequest, validateProbe, {
      preferPrompt: true,
      maxRepairAttempts: 0,
    });
    return finish(
      "passed",
      "Schema-in-prompt with strict local validation fallback passed",
      "prompt",
    );
  } catch (error) {
    tierErrors.push(error instanceof Error ? error.message : String(error));
  }

  return finish(
    "failed",
    tierErrors.join("; ") || "Structured output probe failed",
    "none",
  );
}

function parseProbeJson(text: string): unknown {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(match?.[1] ?? trimmed);
}

async function runStage(
  stage: ConnectionTestStage["stage"],
  operation: () => Promise<string>,
): Promise<ConnectionTestStage> {
  const start = performance.now();
  try {
    const detail = await operation();
    return {
      stage,
      status: "passed",
      latencyMs: Math.round(performance.now() - start),
      detail,
    };
  } catch (error) {
    return {
      stage,
      status: "failed",
      latencyMs: Math.round(performance.now() - start),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function skipped(stage: ConnectionTestStage["stage"]): ConnectionTestStage {
  return {
    stage,
    status: "skipped",
    latencyMs: 0,
    detail: "Probe not requested",
  };
}

function isToolChoiceCompatibilityError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return message.includes("tool_choice") || message.includes("tool choice");
}

function withoutSamplingParameters(request: ModelRequest): ModelRequest {
  const adjusted = { ...request };
  delete adjusted.temperature;
  delete adjusted.topP;
  return adjusted;
}

/**
 * True when the provider rejected the request and names the reasoning effort
 * (reasoning_effort, reasoning.effort, output_config.effort). Used only to
 * explain a failed text stage; chapter tasks send an effort on every call.
 */
function isReasoningEffortRejection(error: unknown): boolean {
  return (
    error instanceof ModelError &&
    error.category === "invalid_request" &&
    error.message.toLowerCase().includes("effort")
  );
}

function validateProbe(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).ok === true &&
    Object.keys(value).length === 1
  ) {
    return { success: true as const, data: { ok: true as const } };
  }
  return {
    success: false as const,
    issues: ["Structured result does not match strict {ok:true}"],
  };
}
