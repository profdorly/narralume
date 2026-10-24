import type {
  NarrativeRun,
  NarrativeRunStep,
  RunBudgetUsage,
  RunStepError,
} from "@narralume/domain";
import type { DecisionQuestion } from "@narralume/llm";
import type { RetrievalHit } from "@narralume/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import { throwIfAborted } from "./project-guard.js";
import { promptLanguageOf } from "./prompt-language.js";

/**
 * Second retrieval stage: the model assigned to the "rerank" role (OpenAI's
 * Decisions API) reads each candidate passage next to the task and estimates
 * how likely it is that the writer needs it. Candidates come from the hybrid
 * search (words, entities, vectors); the reranker only reorders and filters
 * them, so it never adds text the search did not find.
 */

/** Candidates the hybrid search hands to the reranker. */
export const RERANK_CANDIDATES = 32;
/** Passages per chapter among the candidates (the final cut keeps two). */
export const RERANK_MAX_PER_DOCUMENT = 3;
/** Below this probability a candidate is left out of the context. */
export const RERANK_MIN_PROBABILITY = 0.05;
/** Text of each candidate shown to the reranker. */
export const RERANK_MAX_CANDIDATE_CHARS = 3_000;
/** Ranking value of a candidate the model declined to judge. */
const REFUSAL_PROBABILITY = 0.5;

export interface RerankDegradation {
  capability: "rerank";
  reason: string;
}

export interface RetrievalRerankOutcome {
  /** Candidates in the order to use them; filtered when the rerank ran. */
  hits: RetrievalHit[];
  /** True when the reranker judged the candidates. */
  applied: boolean;
  scored: number;
  /** Candidates left out for scoring below RERANK_MIN_PROBABILITY. */
  dropped: number;
  /** Probability of every judged candidate (null: refused), by hit id. */
  scores: { id: string; probability: number | null }[];
  model: string | null;
  modelId: string | null;
  usage: RunBudgetUsage;
  warning: { code: string; message: string } | null;
  /** Set when a reranker is assigned but the call failed. */
  degradation: RerankDegradation | null;
}

/** True when a rerank model is assigned and the client can call it. */
export function hasRetrievalReranker(client: NarrativeModelClient): boolean {
  return Boolean(client.decide) && (client.hasRerankAssignment?.() ?? false);
}

export async function rerankRetrievalHits(input: {
  client: NarrativeModelClient;
  run: NarrativeRun;
  step: NarrativeRunStep;
  purpose: string;
  /** What is about to be written (the retrieval query). */
  task: string;
  language: string | null | undefined;
  hits: readonly RetrievalHit[];
  signal: AbortSignal;
}): Promise<RetrievalRerankOutcome> {
  throwIfAborted(input.signal);
  const passthrough = (
    extra: Partial<RetrievalRerankOutcome> = {},
  ): RetrievalRerankOutcome => ({
    hits: [...input.hits],
    applied: false,
    scored: 0,
    dropped: 0,
    scores: [],
    model: null,
    modelId: null,
    usage: zeroUsage(),
    warning: null,
    degradation: null,
    ...extra,
  });
  if (input.hits.length === 0 || !input.task.trim()) return passthrough();
  if (!hasRetrievalReranker(input.client) || !input.client.decide)
    return passthrough();

  const copy = rerankCopy(input.language);
  const questions: DecisionQuestion[] = input.hits.map((hit, index) => ({
    type: "predicate",
    name: `c${index + 1}`,
    instructions: `${copy.question}\n\n${copy.header(hit)}\n${truncate(hit.content)}`,
  }));
  try {
    const result = await input.client.decide(
      input.run,
      input.step,
      input.purpose,
      { input: copy.input(input.task.trim()), questions },
      input.signal,
    );
    throwIfAborted(input.signal);
    const ranked = input.hits.map((hit, index) => {
      const answer = result.answers[index];
      const probability =
        answer?.type === "predicate" ? answer.probability : null;
      return { hit, index, probability };
    });
    ranked.sort(
      (left, right) =>
        (right.probability ?? REFUSAL_PROBABILITY) -
          (left.probability ?? REFUSAL_PROBABILITY) || left.index - right.index,
    );
    const kept = ranked.filter(
      ({ probability }) =>
        probability === null || probability >= RERANK_MIN_PROBABILITY,
    );
    return {
      hits: kept.map(({ hit, probability }) => ({
        ...hit,
        rerankScore: probability,
        reasons: hit.reasons.includes("rerank")
          ? hit.reasons
          : [...hit.reasons, "rerank"],
      })),
      applied: true,
      scored: ranked.length,
      dropped: ranked.length - kept.length,
      scores: ranked.map(({ hit, probability }) => ({
        id: hit.id,
        probability,
      })),
      model: result.model,
      modelId: result.modelId,
      usage: result.usage,
      warning: null,
      degradation: null,
    };
  } catch (error) {
    throwIfAborted(input.signal);
    const structured = isRunStepError(error) ? error : null;
    const warning = {
      code: structured?.code ?? "rerank.failed",
      message:
        structured?.message ??
        (error instanceof Error ? error.message : String(error)),
    };
    return passthrough({
      usage: structured?.usage ?? zeroUsage(),
      warning,
      degradation: { capability: "rerank", reason: warning.code },
    });
  }
}

/** Keeps at most `max` hits per manuscript document, preserving order. */
export function limitHitsPerDocument(
  hits: readonly RetrievalHit[],
  max: number,
): RetrievalHit[] {
  const counts = new Map<string, number>();
  return hits.filter((hit) => {
    const documentId = hit.metadata.documentId;
    if (typeof documentId !== "string" || !documentId) return true;
    const count = counts.get(documentId) ?? 0;
    if (count >= max) return false;
    counts.set(documentId, count + 1);
    return true;
  });
}

function rerankCopy(language: string | null | undefined) {
  const english = promptLanguageOf(language) === "en";
  const position = (hit: RetrievalHit) => {
    const index = hit.metadata.passageIndex;
    const count = hit.metadata.passageCount;
    return typeof index === "number" && typeof count === "number"
      ? { index: index + 1, count }
      : null;
  };
  if (english)
    return {
      input: (task: string) =>
        `You are judging passages already written in a book for the author of the next part.\nWhat is being written now:\n${task}`,
      question:
        "Does this passage hold something the writer must have at hand to keep continuity in what is being written now: events, facts, what a character knows or feels, objects, places, or clues that come back now? Judge by content, not by word overlap.",
      header: (hit: RetrievalHit) => {
        const at = position(hit);
        const title = hit.title || hit.sourceType;
        return at
          ? `Passage from “${title}” (${at.index} of ${at.count}):`
          : `Passage from “${title}”:`;
      },
    };
  return {
    input: (task: string) =>
      `Você vai julgar trechos já escritos de um livro para quem vai escrever a próxima parte.\nO que será escrito agora:\n${task}`,
    question:
      "Este trecho traz algo que quem vai escrever precisa ter à mão para manter a continuidade do que será escrito agora: acontecimentos, fatos, o que um personagem sabe ou sente, objetos, lugares ou pistas que voltam agora? Julgue pelo conteúdo, não pela semelhança de palavras.",
    header: (hit: RetrievalHit) => {
      const at = position(hit);
      const title = hit.title || hit.sourceType;
      return at
        ? `Trecho de “${title}” (${at.index} de ${at.count}):`
        : `Trecho de “${title}”:`;
    },
  };
}

function truncate(content: string): string {
  return content.length > RERANK_MAX_CANDIDATE_CHARS
    ? `${content.slice(0, RERANK_MAX_CANDIDATE_CHARS)}…`
    : content;
}

function isRunStepError(value: unknown): value is RunStepError {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as RunStepError).code === "string" &&
    typeof (value as RunStepError).message === "string"
  );
}

function zeroUsage(): RunBudgetUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
}
