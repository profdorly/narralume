import type { NarrativeRun, NarrativeRunStep } from "@lapis/domain";
import type { DecisionRequest } from "@lapis/llm";
import type { RetrievalHit } from "@lapis/persistence";
import { describe, expect, it, vi } from "vitest";

import {
  hasRetrievalReranker,
  limitHitsPerDocument,
  RERANK_MAX_CANDIDATE_CHARS,
  rerankRetrievalHits,
  type NarrativeModelClient,
} from "../src/index.js";

const run = {
  id: "run-1",
  projectId: "p1",
  policy: {},
} as unknown as NarrativeRun;
const step = {
  id: "run-1:context",
  runId: "run-1",
} as unknown as NarrativeRunStep;
const now = "2026-10-24T00:00:00.000Z";

function hit(id: string, documentId: string | null, content = `Texto ${id}.`) {
  return {
    id,
    projectId: "p1",
    sourceType: documentId ? "document_passage" : "narrative_memory",
    sourceId: id,
    title: documentId ? `Capítulo ${documentId}` : "Memória",
    content,
    authority: "confirmed",
    metadata: documentId
      ? { documentId, passageIndex: 0, passageCount: 2 }
      : {},
    entityIds: [],
    createdAt: now,
    updatedAt: now,
    lexicalRank: null,
    vectorRank: null,
    entityScore: 0,
    vectorScore: 0,
    rerankScore: null,
    score: 0,
    reasons: ["fts"],
  } satisfies RetrievalHit;
}

function client(
  answer: (request: DecisionRequest) => unknown[],
  options: { assigned?: boolean; fail?: unknown } = {},
) {
  const decide = vi.fn(
    async (
      _run: NarrativeRun,
      _step: NarrativeRunStep,
      _purpose: string,
      request: DecisionRequest,
    ) => {
      if (options.fail) throw options.fail;
      return {
        answers: answer(request),
        model: "gpt-6-luna",
        modelId: "model-rerank",
        usage: {
          inputTokens: 500,
          outputTokens: 0,
          calls: 1,
          costUsd: 0.00005,
          wallTimeMs: 120,
        },
      };
    },
  );
  return {
    decide,
    model: {
      text: vi.fn(),
      structured: vi.fn(),
      hasRerankAssignment: () => options.assigned ?? true,
      decide,
    } as unknown as NarrativeModelClient,
  };
}

const predicates =
  (...probabilities: (number | null)[]) =>
  () =>
    probabilities.map((probability, index) =>
      probability === null
        ? { type: "refusal", name: `c${index + 1}` }
        : { type: "predicate", name: `c${index + 1}`, probability },
    );

describe("rerankRetrievalHits", () => {
  it("orders candidates by probability, drops the irrelevant and keeps refusals neutral", async () => {
    const { model, decide } = client(predicates(0.2, 0.9, 0.01, null, 0.6));
    const outcome = await rerankRetrievalHits({
      client: model,
      run,
      step,
      purpose: "context-retrieval-rerank",
      task: "Capítulo 8\nHelena entra na gruta com a chave.",
      language: "pt-BR",
      hits: [
        hit("a", "c1"),
        hit("b", "c2"),
        hit("c", "c3"),
        hit("d", null),
        hit("e", "c5"),
      ],
      signal: new AbortController().signal,
    });
    expect(outcome.hits.map((entry) => [entry.id, entry.rerankScore])).toEqual([
      ["b", 0.9],
      ["e", 0.6],
      ["d", null],
      ["a", 0.2],
    ]);
    expect(outcome.hits[0]!.reasons).toEqual(["fts", "rerank"]);
    expect(outcome).toMatchObject({
      applied: true,
      scored: 5,
      dropped: 1,
      model: "gpt-6-luna",
      modelId: "model-rerank",
      usage: { inputTokens: 500, calls: 1 },
      warning: null,
      degradation: null,
    });

    const request = decide.mock.calls[0]![3];
    expect(request.input).toContain("O que será escrito agora:");
    expect(request.input).toContain("Helena entra na gruta com a chave.");
    expect(request.questions).toHaveLength(5);
    expect(request.questions[0]).toMatchObject({
      type: "predicate",
      name: "c1",
    });
    expect(request.questions[0]!.instructions).toContain(
      "Trecho de “Capítulo c1” (1 de 2):",
    );
    expect(request.questions[3]!.instructions).toContain(
      "Trecho de “Memória”:",
    );
  });

  it("writes the questions in English for English projects and truncates long candidates", async () => {
    const { model, decide } = client(predicates(0.5));
    await rerankRetrievalHits({
      client: model,
      run,
      step,
      purpose: "cocreate-retrieval-rerank",
      task: "Chapter 3",
      language: "en",
      hits: [hit("long", "c1", "x".repeat(RERANK_MAX_CANDIDATE_CHARS + 500))],
      signal: new AbortController().signal,
    });
    const request = decide.mock.calls[0]![3];
    expect(request.input).toContain("What is being written now:");
    const instructions = request.questions[0]!.instructions;
    expect(instructions).toContain("Passage from “Capítulo c1” (1 of 2):");
    expect(instructions.endsWith(`${"x".repeat(10)}…`)).toBe(true);
    expect(instructions.length).toBeLessThan(RERANK_MAX_CANDIDATE_CHARS + 600);
  });

  it("passes the candidates through without a call when no reranker is assigned", async () => {
    const { model, decide } = client(predicates(1), { assigned: false });
    expect(hasRetrievalReranker(model)).toBe(false);
    const hits = [hit("a", "c1"), hit("b", "c2")];
    const outcome = await rerankRetrievalHits({
      client: model,
      run,
      step,
      purpose: "context-retrieval-rerank",
      task: "Capítulo 2",
      language: "pt-BR",
      hits,
      signal: new AbortController().signal,
    });
    expect(decide).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      hits,
      applied: false,
      scored: 0,
      degradation: null,
      warning: null,
    });
  });

  it("falls back to the search order and reports a degradation when the call fails", async () => {
    const failure = {
      code: "model.http_401",
      message: "Incorrect API key",
      retryable: false,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        calls: 1,
        costUsd: 0,
        wallTimeMs: 90,
      },
    };
    const { model } = client(predicates(), { fail: failure });
    const hits = [hit("a", "c1"), hit("b", "c2")];
    const outcome = await rerankRetrievalHits({
      client: model,
      run,
      step,
      purpose: "context-retrieval-rerank",
      task: "Capítulo 2",
      language: "pt-BR",
      hits,
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      hits,
      applied: false,
      warning: { code: "model.http_401", message: "Incorrect API key" },
      degradation: { capability: "rerank", reason: "model.http_401" },
      usage: { calls: 1, wallTimeMs: 90 },
    });
  });

  it("rethrows when the run is cancelled during the call", async () => {
    const controller = new AbortController();
    const { model } = client(() => {
      controller.abort();
      return [];
    });
    await expect(
      rerankRetrievalHits({
        client: model,
        run,
        step,
        purpose: "context-retrieval-rerank",
        task: "Capítulo 2",
        language: "pt-BR",
        hits: [hit("a", "c1")],
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });
});

describe("limitHitsPerDocument", () => {
  it("keeps the first hits of each document and every hit without one", () => {
    expect(
      limitHitsPerDocument(
        [
          hit("a1", "a"),
          hit("m1", null),
          hit("a2", "a"),
          hit("b1", "b"),
          hit("a3", "a"),
          hit("m2", null),
        ],
        2,
      ).map((entry) => entry.id),
    ).toEqual(["a1", "m1", "a2", "b1", "m2"]);
  });
});
