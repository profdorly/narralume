import type { FetchLike } from "@lapis/llm";
import { describe, expect, it, vi } from "vitest";

import {
  PROBE_MAX_OUTPUT_TOKENS,
  PROBE_REASONING_EFFORT,
  testModelConnection,
  type ConnectionTestProfile,
} from "@lapis/services";

describe("model connection capability fallback", () => {
  it("sends provider query parameters on connection probes", async () => {
    const urls: string[] = [];
    const fetch = vi.fn<FetchLike>(async (input) => {
      urls.push(String(input));
      return json({
        id: "chat-text",
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
    });
    const profile: ConnectionTestProfile = {
      id: "test-query",
      name: "test",
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      endpoint: null,
      model: "query-model",
      apiKeyEnv: "TEST_KEY",
      anthropicVersion: null,
      extraHeaders: {},
      queryParams: { "api-version": "2026-08-01" },
      capabilities: {},
    };

    const stages = await testModelConnection(
      profile,
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: false,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({ stage: "text", status: "passed" });
    expect(urls).toEqual([
      "https://api.example.com/v1/chat/completions?api-version=2026-08-01",
    ]);
  });

  it("falls back from forced tools and native schemas while keeping strict local validation", async () => {
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (
        body.tool_choice &&
        JSON.stringify(body.tool_choice).includes("echo_probe")
      ) {
        return json(
          {
            error: {
              message: "Thinking mode does not support this tool_choice",
            },
          },
          400,
        );
      }
      if (body.tools) {
        return json({
          id: "chat-tool",
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
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        });
      }
      if (body.response_format) {
        return json(
          {
            error: { message: "This response_format type is unavailable now" },
          },
          400,
        );
      }
      const isJsonFallback = JSON.stringify(body.messages).includes(
        "Return exactly one JSON value",
      );
      return json({
        id: "chat-text",
        choices: [
          {
            message: { content: isJsonFallback ? '{"ok":true}' : "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
    });
    const profile: ConnectionTestProfile = {
      id: "test-chat",
      name: "test",
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      endpoint: null,
      model: "thinking-model",
      apiKeyEnv: "TEST_KEY",
      anthropicVersion: null,
      extraHeaders: {},
      capabilities: {},
    };

    const stages = await testModelConnection(
      profile,
      {
        includeStreaming: false,
        includeTools: true,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages).toEqual([
      expect.objectContaining({ stage: "text", status: "passed" }),
      expect.objectContaining({ stage: "stream", status: "skipped" }),
      expect.objectContaining({
        stage: "tool",
        status: "passed",
        detail: expect.stringContaining("auto fallback"),
      }),
      expect.objectContaining({
        stage: "structured-output",
        status: "passed",
        detail: expect.stringContaining("strict local validation fallback"),
        capability: "prompt",
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("reports json-mode capability when only json_object passes", async () => {
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const format = body.response_format as { type?: string } | undefined;
      if (format?.type === "json_schema") {
        return json(
          { error: { message: "response_format json_schema unavailable" } },
          400,
        );
      }
      if (format?.type === "json_object") {
        return json({
          id: "chat-json-mode",
          choices: [
            { message: { content: '{"ok":true}' }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        });
      }
      return json({
        id: "chat-text",
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
    });
    const profile: ConnectionTestProfile = {
      id: "test-chat-json-mode",
      name: "test",
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      endpoint: null,
      model: "json-mode-model",
      apiKeyEnv: "TEST_KEY",
      anthropicVersion: null,
      extraHeaders: {},
      capabilities: {},
    };

    const stages = await testModelConnection(
      profile,
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages).toEqual([
      expect.objectContaining({ stage: "text", status: "passed" }),
      expect.objectContaining({ stage: "stream", status: "skipped" }),
      expect.objectContaining({ stage: "tool", status: "skipped" }),
      expect.objectContaining({
        stage: "structured-output",
        status: "passed",
        detail: expect.stringContaining("json_object"),
        capability: "json-mode",
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("omits sampling parameters after the text stage for models that reject them", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("temperature" in body || "top_p" in body) {
        return json(
          {
            error: {
              message:
                "Unsupported parameter: 'temperature' is not supported with this model.",
              type: "invalid_request_error",
              param: "temperature",
              code: "unsupported_parameter",
            },
          },
          400,
        );
      }
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: true,
        includeTools: true,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages).toEqual([
      expect.objectContaining({
        stage: "text",
        status: "passed",
        detail: expect.stringContaining(
          "temperature omitted: the model rejects sampling parameters, so runs omit temperature and top_p",
        ),
        requestCapabilities: {
          samplingParameters: false,
          maxCompletionTokens: false,
        },
      }),
      expect.objectContaining({ stage: "stream", status: "passed" }),
      expect.objectContaining({
        stage: "tool",
        status: "passed",
        detail: expect.stringContaining("forced"),
      }),
      expect.objectContaining({
        stage: "structured-output",
        status: "passed",
        capability: "native",
      }),
    ]);
    // Rejected text request, retried text request, then one request per stage.
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(bodies[0]).toHaveProperty("temperature", 0);
    for (const body of bodies.slice(1)) {
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body.max_tokens).toEqual(expect.any(Number));
    }
  });

  it("switches Chat Completions probes to max_completion_tokens when max_tokens is rejected", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("max_tokens" in body) return maxTokensRejected();
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: true,
        includeTools: true,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages.map((stage) => stage.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    expect(stages[0]).toMatchObject({
      detail: expect.stringContaining(
        "max_completion_tokens sent: model rejects max_tokens",
      ),
      requestCapabilities: {
        samplingParameters: true,
        maxCompletionTokens: true,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(bodies[0]).toHaveProperty("max_tokens", PROBE_MAX_OUTPUT_TOKENS);
    for (const body of bodies.slice(1)) {
      expect(body).not.toHaveProperty("max_tokens");
      expect(body.max_completion_tokens).toEqual(expect.any(Number));
      expect(body).toHaveProperty("temperature", 0);
    }
  });

  it("adjusts both request constraints before probing the remaining stages", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("max_tokens" in body) return maxTokensRejected();
      if ("temperature" in body) {
        return json(
          {
            error: {
              message:
                "Unsupported parameter: 'temperature' is not supported with this model.",
            },
          },
          400,
        );
      }
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: true,
        includeTools: true,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages.map((stage) => stage.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    expect(stages[0]).toMatchObject({
      detail: expect.stringMatching(
        /max_completion_tokens sent: model rejects max_tokens; temperature omitted: the model rejects sampling parameters/,
      ),
      requestCapabilities: {
        samplingParameters: false,
        maxCompletionTokens: true,
      },
    });
    // Two rejected text requests, the accepted one, then one per stage.
    expect(fetch).toHaveBeenCalledTimes(6);
    for (const body of bodies.slice(2)) {
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("temperature");
      expect(body.max_completion_tokens).toEqual(expect.any(Number));
    }
  });

  it("does not switch the output-token field outside Chat Completions", async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      json(
        {
          error: {
            message:
              "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        },
        400,
      ),
    );

    const stages = await testModelConnection(
      reasoningProfile("openai-responses"),
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: false,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({ stage: "text", status: "failed" });
    expect(stages[0]).not.toHaveProperty("requestCapabilities");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("probes every stage with the chapter-worker request shape", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: true,
        includeTools: true,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages.map((stage) => stage.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    expect(stages[0]).toMatchObject({
      requestCapabilities: {
        samplingParameters: true,
        maxCompletionTokens: false,
      },
    });
    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect(body).toMatchObject({
        reasoning_effort: PROBE_REASONING_EFFORT,
        temperature: 0,
        max_tokens: PROBE_MAX_OUTPUT_TOKENS,
      });
    }
  });

  it("detects sampling rejections that depend on the reasoning effort", async () => {
    // GPT-5.1-style: temperature is accepted only at reasoning effort "none",
    // so a bare probe request would pass while every chapter call fails.
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (
        "temperature" in body &&
        body.reasoning_effort !== undefined &&
        body.reasoning_effort !== "none"
      ) {
        return samplingRejected();
      }
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: false,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({
      stage: "text",
      status: "passed",
      requestCapabilities: {
        samplingParameters: false,
        maxCompletionTokens: false,
      },
    });
    expect(bodies[0]).toMatchObject({
      reasoning_effort: "low",
      temperature: 0,
    });
    expect(bodies[1]).toMatchObject({ reasoning_effort: "low" });
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("detects extended-thinking temperature constraints passed on by gateways", async () => {
    // A gateway that maps the reasoning effort to Anthropic extended thinking.
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("reasoning_effort" in body && "temperature" in body) {
        return json(
          {
            error: {
              message:
                "`temperature` may only be set to 1 when thinking is enabled.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: false,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({
      stage: "text",
      status: "passed",
      requestCapabilities: {
        samplingParameters: false,
        maxCompletionTokens: false,
      },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ reasoning_effort: "low" });
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("fails the text stage on a reasoning effort rejection and probes the other stages without it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("reasoning_effort" in body) return effortRejected();
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: true,
        includeTools: true,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    // Chapter tasks send the effort and fail the same way, so the text stage
    // fails; the request without it measured the request shape.
    expect(stages[0]).toMatchObject({
      stage: "text",
      status: "failed",
      requestCapabilities: {
        samplingParameters: true,
        maxCompletionTokens: false,
      },
    });
    expect(stages[0]?.detail).toContain(EFFORT_REJECTED);
    expect(stages[0]?.detail).toContain(
      `reasoning effort "${PROBE_REASONING_EFFORT}" rejected: chapter, import and other narrative tasks send a reasoning effort, so they are rejected the same way`,
    );
    expect(stages[0]?.detail).toContain(
      "without it the provider accepted the request and returned 2 characters",
    );
    // Streaming, tools and structured output are measured, not inferred from
    // the effort rejection.
    expect(stages.slice(1)).toEqual([
      expect.objectContaining({ stage: "stream", status: "passed" }),
      expect.objectContaining({ stage: "tool", status: "passed" }),
      expect.objectContaining({
        stage: "structured-output",
        status: "passed",
        capability: "native",
      }),
    ]);
    for (const stage of stages.slice(1)) {
      expect(stage.detail).toContain(
        "sent without reasoning effort, which the provider rejects",
      );
    }
    // Rejected text request, retried text request, then one per stage.
    expect(bodies).toHaveLength(5);
    expect(bodies[0]).toMatchObject({
      reasoning_effort: PROBE_REASONING_EFFORT,
      temperature: 0,
    });
    for (const body of bodies.slice(1)) {
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).toHaveProperty("temperature", 0);
    }
  });

  it("keeps adjusting the request shape after dropping a rejected reasoning effort", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("reasoning_effort" in body) return effortRejected();
      if ("temperature" in body) return samplingRejected();
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: true,
        includeTools: false,
        includeStructuredOutput: false,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({
      stage: "text",
      status: "failed",
      requestCapabilities: {
        samplingParameters: false,
        maxCompletionTokens: false,
      },
    });
    expect(stages[0]?.detail).toContain(
      `reasoning effort "${PROBE_REASONING_EFFORT}" rejected`,
    );
    expect(stages[0]?.detail).toContain(
      "temperature omitted: the model rejects sampling parameters, so runs omit temperature and top_p",
    );
    expect(stages.map((stage) => stage.status)).toEqual([
      "failed",
      "passed",
      "skipped",
      "skipped",
    ]);
    // Skipped stages keep their plain detail.
    expect(stages[2]?.detail).toBe("Probe not requested");
    expect(bodies).toHaveLength(4);
    expect(bodies[3]).not.toHaveProperty("reasoning_effort");
    expect(bodies[3]).not.toHaveProperty("temperature");
  });

  it("records no request shape when the request without reasoning effort is not accepted either", async () => {
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if ("reasoning_effort" in body) return effortRejected();
      return json({ error: { message: "The model does not exist" } }, 404);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: false,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({ stage: "text", status: "failed" });
    expect(stages[0]?.detail).toContain("The model does not exist");
    expect(stages[0]?.detail).toContain(
      `reasoning effort "${PROBE_REASONING_EFFORT}" rejected`,
    );
    expect(stages[0]).not.toHaveProperty("requestCapabilities");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "openai-responses",
      "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      (body: Record<string, unknown>) => "reasoning" in body,
      () =>
        json({
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
    ],
    [
      "anthropic-messages",
      "output_config.effort: Extra inputs are not permitted",
      (body: Record<string, unknown>) => "output_config" in body,
      () =>
        json({
          id: "msg-probe",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
    ],
  ] as const)(
    "drops a rejected reasoning effort field on %s",
    async (protocol, message, sendsEffort, reply) => {
      const bodies: Record<string, unknown>[] = [];
      const fetch = vi.fn<FetchLike>(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (sendsEffort(body)) {
          return json(
            { error: { message, type: "invalid_request_error" } },
            400,
          );
        }
        return reply();
      });

      const stages = await testModelConnection(
        reasoningProfile(protocol),
        {
          includeStreaming: false,
          includeTools: false,
          includeStructuredOutput: false,
        },
        { TEST_KEY: "secret" },
        { fetch },
      );

      expect(stages[0]).toMatchObject({
        stage: "text",
        status: "failed",
        detail: expect.stringContaining(
          `reasoning effort "${PROBE_REASONING_EFFORT}" rejected`,
        ),
        requestCapabilities: {
          samplingParameters: true,
          maxCompletionTokens: false,
        },
      });
      expect(bodies).toHaveLength(2);
      expect(sendsEffort(bodies[0]!)).toBe(true);
      expect(sendsEffort(bodies[1]!)).toBe(false);
      expect(bodies[1]).toHaveProperty("temperature", 0);
    },
  );

  it("keeps request-shape evidence when an accepted adjusted request returns no text", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("temperature" in body) return samplingRejected();
      if (body.stream !== true && !body.tools && !body.response_format) {
        // A reasoning model that spent the whole budget on reasoning.
        return json({
          id: "chat-empty",
          choices: [{ message: { content: "" }, finish_reason: "length" }],
          usage: { prompt_tokens: 2, completion_tokens: 1_024 },
        });
      }
      return reasoningModelReply(body);
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: true,
        includeTools: true,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({
      stage: "text",
      status: "failed",
      requestCapabilities: {
        samplingParameters: false,
        maxCompletionTokens: false,
      },
    });
    expect(stages[0]?.detail).toContain(
      "The response contains no text; finish reason: length",
    );
    expect(stages[0]?.detail).toContain(
      "temperature omitted: the model rejects sampling parameters, so runs omit temperature and top_p",
    );
    expect(stages.slice(1).map((stage) => stage.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    for (const body of bodies.slice(1)) {
      expect(body).not.toHaveProperty("temperature");
    }
  });

  it("reports the adjustment but records no request shape when the adjusted request is not accepted", async () => {
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if ("temperature" in body) return samplingRejected();
      return new Response(
        JSON.stringify({ error: { message: "Rate limit reached" } }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        },
      );
    });

    const stages = await testModelConnection(
      reasoningProfile("openai-chat"),
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: false,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({
      stage: "text",
      status: "failed",
      detail: expect.stringContaining(
        "temperature omitted: the model rejects sampling parameters, so runs omit temperature and top_p",
      ),
    });
    expect(stages[0]?.detail).toContain("Rate limit reached");
    expect(stages[0]).not.toHaveProperty("requestCapabilities");
  });

  it.each([
    [
      "openai-responses",
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          reasoning: { effort: PROBE_REASONING_EFFORT },
          max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
        });
      },
      () =>
        json({
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
    ],
    [
      "anthropic-messages",
      (body: Record<string, unknown>) => {
        expect(body).toMatchObject({
          output_config: { effort: PROBE_REASONING_EFFORT },
          max_tokens: PROBE_MAX_OUTPUT_TOKENS,
        });
      },
      () =>
        json({
          id: "msg-probe",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
    ],
  ] as const)(
    "omits sampling parameters for %s models that reject them",
    async (protocol, expectShape, reply) => {
      const bodies: Record<string, unknown>[] = [];
      const fetch = vi.fn<FetchLike>(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if ("temperature" in body) {
          return json(
            {
              error: {
                message: "temperature: this parameter is not supported",
              },
            },
            400,
          );
        }
        return reply();
      });

      const stages = await testModelConnection(
        reasoningProfile(protocol),
        {
          includeStreaming: false,
          includeTools: false,
          includeStructuredOutput: false,
        },
        { TEST_KEY: "secret" },
        { fetch },
      );

      expect(stages[0]).toMatchObject({
        stage: "text",
        status: "passed",
        detail: expect.stringContaining(
          "temperature omitted: the model rejects sampling parameters, so runs omit temperature and top_p",
        ),
        requestCapabilities: {
          samplingParameters: false,
          maxCompletionTokens: false,
        },
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty("temperature", 0);
      expect(bodies[1]).not.toHaveProperty("temperature");
      expect(bodies[1]).not.toHaveProperty("top_p");
      expect(bodies[1]).not.toHaveProperty("max_completion_tokens");
      for (const body of bodies) expectShape(body);
    },
  );
});

function samplingRejected(): Response {
  return json(
    {
      error: {
        message:
          "Unsupported parameter: 'temperature' is not supported with this model.",
        type: "invalid_request_error",
        param: "temperature",
        code: "unsupported_parameter",
      },
    },
    400,
  );
}

/** OpenAI's rejection of reasoning_effort by a non-reasoning model. */
const EFFORT_REJECTED =
  "Unsupported parameter: 'reasoning_effort' is not supported with this model.";

function effortRejected(): Response {
  return json(
    {
      error: {
        message: EFFORT_REJECTED,
        type: "invalid_request_error",
        param: "reasoning_effort",
        code: "unsupported_parameter",
      },
    },
    400,
  );
}

function reasoningProfile(
  protocol: ConnectionTestProfile["protocol"],
): ConnectionTestProfile {
  return {
    id: `test-reasoning-${protocol}`,
    name: "test",
    protocol,
    baseUrl: "https://api.example.com/v1",
    endpoint: null,
    model: "reasoning-model",
    apiKeyEnv: "TEST_KEY",
    anthropicVersion: null,
    extraHeaders: {},
    capabilities: {},
  };
}

function maxTokensRejected(): Response {
  return json(
    {
      error: {
        message:
          "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        type: "invalid_request_error",
        param: "max_tokens",
        code: "unsupported_parameter",
      },
    },
    400,
  );
}

/** Chat Completions replies for every probe stage of an accepted request. */
function reasoningModelReply(body: Record<string, unknown>): Response {
  if (body.stream === true) {
    return new Response(
      [
        `data: ${JSON.stringify({ id: "chat-stream", choices: [{ delta: { content: "OK" } }] })}\n\n`,
        `data: ${JSON.stringify({ id: "chat-stream", choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  if (body.tools) {
    return json({
      id: "chat-tool",
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
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
  }
  return json({
    id: "chat-text",
    choices: [
      {
        message: { content: body.response_format ? '{"ok":true}' : "OK" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 2 },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
