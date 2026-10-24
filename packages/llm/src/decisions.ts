import { ModelError } from "./error.js";
import { postJson, readJsonObject } from "./transport.js";
import type { AdapterConfig, NormalizedUsage } from "./types.js";

/**
 * Client for OpenAI's Decisions API (POST /v1/decisions): typed answers
 * (probability, choice or score) about shared evidence, without generated
 * text. Only input tokens are billed.
 * https://developers.openai.com/api/docs/guides/decisions
 */

/** Documented request limit (1–400 questions). */
export const MAX_DECISION_QUESTIONS = 400;

export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | {
      type: "choice";
      name: string;
      instructions: string;
      choices: readonly { value: string; description?: string }[];
    }
  | {
      type: "score";
      name: string;
      instructions: string;
      levels: readonly { label: string; description?: string }[];
    };

export type DecisionAnswer =
  | { type: "predicate"; name: string | null; probability: number }
  | {
      type: "choice";
      name: string | null;
      choice: string | boolean;
      confidence: number;
    }
  | {
      type: "score";
      name: string | null;
      score: number;
      confidence: number;
    }
  /** The model declined this question; the others can still be answered. */
  | { type: "refusal"; name: string | null };

export interface DecisionRequest {
  /** Shared evidence for every question. */
  input: string;
  questions: readonly DecisionQuestion[];
  promptCacheKey?: string;
}

export interface DecisionResult {
  /** One answer per question, in question order. */
  answers: DecisionAnswer[];
  usage: NormalizedUsage;
}

export async function generateOpenAIDecisions(
  config: AdapterConfig,
  model: string,
  request: DecisionRequest,
  signal?: AbortSignal,
): Promise<DecisionResult> {
  const count = request.questions.length;
  if (count === 0 || count > MAX_DECISION_QUESTIONS)
    throw new ModelError(
      `Decision question count must be between 1 and ${MAX_DECISION_QUESTIONS}`,
      { category: "invalid_request" },
    );
  if (
    new Set(request.questions.map((question) => question.name)).size !== count
  )
    throw new ModelError("Decision question names must be unique", {
      category: "invalid_request",
    });
  // The Decisions endpoint is fixed; a provider's chat/responses endpoint
  // override does not apply to it.
  const { endpoint: _ignoredEndpoint, ...decisionConfig } = config;
  void _ignoredEndpoint;
  const { response } = await postJson(
    decisionConfig,
    "decisions",
    {
      model,
      input: request.input,
      questions: request.questions,
      ...(request.promptCacheKey
        ? { prompt_cache_key: request.promptCacheKey.slice(0, 64) }
        : {}),
    },
    {
      ...(signal ? { signal } : {}),
      headers: { authorization: `Bearer ${config.apiKey}` },
    },
  );
  const body = await readJsonObject(response);
  if (!Array.isArray(body.answers))
    throw new ModelError("Decision response is missing answers", {
      category: "protocol",
    });
  if (body.answers.length !== count)
    throw new ModelError(
      "Decision response answer count does not match the question count",
      { category: "protocol" },
    );
  const answers = body.answers.map((entry, index) =>
    parseAnswer(entry, request.questions[index]!),
  );
  return { answers, usage: parseUsage(body.usage) };
}

function parseAnswer(
  entry: unknown,
  question: DecisionQuestion,
): DecisionAnswer {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw protocolError("Decision answer is not an object");
  const record = entry as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : null;
  if (name !== null && name !== question.name)
    throw protocolError("Decision answers are out of question order");
  if (record.type === "refusal") return { type: "refusal", name };
  if (record.type !== question.type)
    throw protocolError(
      `Decision answer type ${String(record.type)} does not match question type ${question.type}`,
    );
  switch (question.type) {
    case "predicate":
      return {
        type: "predicate",
        name,
        probability: unitInterval(record.probability, "probability"),
      };
    case "choice": {
      const choice = record.choice;
      if (typeof choice !== "string" && typeof choice !== "boolean")
        throw protocolError("Decision choice answer is missing its choice");
      return {
        type: "choice",
        name,
        choice,
        confidence: unitInterval(record.confidence, "confidence"),
      };
    }
    case "score": {
      if (typeof record.score !== "number" || !Number.isFinite(record.score))
        throw protocolError("Decision score answer is missing its score");
      return {
        type: "score",
        name,
        score: record.score,
        confidence: unitInterval(record.confidence, "confidence"),
      };
    }
  }
}

function unitInterval(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw protocolError(`Decision answer is missing its ${field}`);
  return Math.min(1, Math.max(0, value));
}

function parseUsage(value: unknown): NormalizedUsage {
  const usage =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const details =
    usage.input_tokens_details &&
    typeof usage.input_tokens_details === "object" &&
    !Array.isArray(usage.input_tokens_details)
      ? (usage.input_tokens_details as Record<string, unknown>)
      : {};
  const outputDetails =
    usage.output_tokens_details &&
    typeof usage.output_tokens_details === "object" &&
    !Array.isArray(usage.output_tokens_details)
      ? (usage.output_tokens_details as Record<string, unknown>)
      : {};
  const inputTokens = count(usage.input_tokens);
  const outputTokens = count(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: count(usage.total_tokens) || inputTokens + outputTokens,
    cachedInputTokens: count(details.cached_tokens),
    reasoningTokens: count(outputDetails.reasoning_tokens),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function protocolError(message: string): ModelError {
  return new ModelError(message, { category: "protocol" });
}
