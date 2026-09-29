import type { FetchLike } from "@narralume/llm";
import { describe, expect, it, vi } from "vitest";

import {
  testModelConnection,
  type ConnectionTestProfile,
} from "@narralume/services";

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
          "temperature/top_p omitted: model rejects sampling parameters",
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
    expect(bodies[0]).toHaveProperty("max_tokens", 128);
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
        /max_completion_tokens sent: model rejects max_tokens; temperature\/top_p omitted/,
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
});

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
