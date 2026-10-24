import { describe, expect, it, vi } from "vitest";

import {
  generateOpenAIDecisions,
  MAX_DECISION_QUESTIONS,
} from "../src/decisions.js";
import type { AdapterConfig } from "../src/types.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config(fetcher: AdapterConfig["fetch"]): AdapterConfig {
  return {
    protocol: "openai-responses",
    baseUrl: "https://api.example/v1",
    // A chat/responses endpoint override must not redirect Decisions calls.
    endpoint: "responses",
    apiKey: "secret-key",
    ...(fetcher ? { fetch: fetcher } : {}),
  };
}

describe("generateOpenAIDecisions", () => {
  it("posts typed questions to /decisions and parses answers in order", async () => {
    const fetcher = vi.fn(async () =>
      json({
        model: "gpt-6-luna",
        answers: [
          { type: "predicate", name: "p1", probability: 0.92 },
          { type: "refusal", name: "p2" },
          {
            type: "choice",
            name: "kind",
            choice: "scene",
            confidence: 0.8,
            probabilities: [{ value: "scene", probability: 0.9 }],
          },
          {
            type: "score",
            name: "weight",
            score: 1.4,
            confidence: 0.5,
            probabilities: [],
          },
        ],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
          output_tokens: 0,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 120,
        },
      }),
    );
    const result = await generateOpenAIDecisions(
      config(fetcher),
      "gpt-6-luna",
      {
        input: "Tarefa: escrever o capítulo 8.",
        questions: [
          { type: "predicate", name: "p1", instructions: "Trecho 1?" },
          { type: "predicate", name: "p2", instructions: "Trecho 2?" },
          {
            type: "choice",
            name: "kind",
            instructions: "Tipo?",
            choices: [{ value: "scene" }, { value: "summary" }],
          },
          {
            type: "score",
            name: "weight",
            instructions: "Peso?",
            levels: [{ label: "baixo" }, { label: "médio" }, { label: "alto" }],
          },
        ],
        promptCacheKey: "project-1:chapter-rerank",
      },
    );
    expect(result).toEqual({
      answers: [
        { type: "predicate", name: "p1", probability: 0.92 },
        { type: "refusal", name: "p2" },
        { type: "choice", name: "kind", choice: "scene", confidence: 0.8 },
        { type: "score", name: "weight", score: 1.4, confidence: 0.5 },
      ],
      usage: {
        inputTokens: 120,
        outputTokens: 0,
        totalTokens: 120,
        cachedInputTokens: 40,
        reasoningTokens: 0,
      },
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(url)).toBe("https://api.example/v1/decisions");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer secret-key",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      model: "gpt-6-luna",
      input: "Tarefa: escrever o capítulo 8.",
      questions: [
        { type: "predicate", name: "p1", instructions: "Trecho 1?" },
        { type: "predicate", name: "p2", instructions: "Trecho 2?" },
        {
          type: "choice",
          name: "kind",
          instructions: "Tipo?",
          choices: [{ value: "scene" }, { value: "summary" }],
        },
        {
          type: "score",
          name: "weight",
          instructions: "Peso?",
          levels: [{ label: "baixo" }, { label: "médio" }, { label: "alto" }],
        },
      ],
      prompt_cache_key: "project-1:chapter-rerank",
    });
  });

  it("rejects question counts outside 1–400 and duplicate names before sending", async () => {
    const fetcher = vi.fn();
    const predicate = (name: string) => ({
      type: "predicate" as const,
      name,
      instructions: "?",
    });
    await expect(
      generateOpenAIDecisions(config(fetcher), "gpt-6-luna", {
        input: "x",
        questions: [],
      }),
    ).rejects.toMatchObject({ category: "invalid_request" });
    await expect(
      generateOpenAIDecisions(config(fetcher), "gpt-6-luna", {
        input: "x",
        questions: Array.from({ length: MAX_DECISION_QUESTIONS + 1 }, (_, i) =>
          predicate(`p${i}`),
        ),
      }),
    ).rejects.toMatchObject({ category: "invalid_request" });
    await expect(
      generateOpenAIDecisions(config(fetcher), "gpt-6-luna", {
        input: "x",
        questions: [predicate("same"), predicate("same")],
      }),
    ).rejects.toMatchObject({ category: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats missing or mismatched answers as protocol errors", async () => {
    const question = {
      type: "predicate" as const,
      name: "p1",
      instructions: "?",
    };
    for (const body of [
      { usage: {} },
      { answers: [] },
      { answers: [{ type: "predicate", name: "other", probability: 0.5 }] },
      { answers: [{ type: "score", name: "p1", score: 1, confidence: 1 }] },
      { answers: [{ type: "predicate", name: "p1" }] },
    ]) {
      await expect(
        generateOpenAIDecisions(
          config(vi.fn(async () => json(body))),
          "gpt-6-luna",
          { input: "x", questions: [question] },
        ),
      ).rejects.toMatchObject({ category: "protocol" });
    }
  });

  it("surfaces HTTP errors from the provider", async () => {
    await expect(
      generateOpenAIDecisions(
        config(
          vi.fn(async () =>
            json(
              {
                error: {
                  message: "Incorrect API key provided",
                  code: "invalid_api_key",
                },
              },
              401,
            ),
          ),
        ),
        "gpt-6-luna",
        {
          input: "x",
          questions: [{ type: "predicate", name: "p1", instructions: "?" }],
        },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
