import type {
  NarrativeRun,
  NarrativeRunStep,
  RunBudgetUsage,
} from "@narralume/domain";
import {
  SqliteManuscriptIndexer,
  SqliteRetrievalRepository,
  type IndexDocumentInput,
  type NarrativeDatabase,
  type PlannedPassage,
} from "@narralume/persistence";

import {
  optionalEmbeddings,
  type EmbeddingDegradation,
} from "./embedding-support.js";
import type { NarrativeModelClient } from "./model-client.js";

/** Inputs per embedding request (the adapter accepts up to 128). */
export const EMBEDDING_BATCH_SIZE = 64;
/**
 * Passages a single context compilation may embed before retrieval. Covers a
 * typical novel in one pass; anything left is picked up by the next run.
 */
export const LAZY_INDEX_MAX_INPUTS = 512;

export interface EmbeddingBatchOutcome {
  /** One entry per input; null when that input was not embedded. */
  vectors: (number[] | null)[];
  model: string | null;
  modelId: string | null;
  usage: RunBudgetUsage;
  warning: { code: string; message: string } | null;
  degradation: EmbeddingDegradation | null;
}

export interface IndexEmbeddingOutcome {
  /** Vectors stored by this pass. */
  embedded: number;
  /** Segments still without a vector for the model after this pass. */
  remaining: number;
  model: string | null;
  modelId: string | null;
  usage: RunBudgetUsage;
  warning: { code: string; message: string } | null;
  degradation: EmbeddingDegradation | null;
}

/** Embeds texts in batches, stopping at the first batch that fails. */
export async function embedInBatches(
  client: NarrativeModelClient,
  run: NarrativeRun,
  step: NarrativeRunStep,
  purpose: string,
  texts: readonly string[],
  signal: AbortSignal,
): Promise<EmbeddingBatchOutcome> {
  const outcome: EmbeddingBatchOutcome = {
    vectors: texts.map(() => null),
    model: null,
    modelId: null,
    usage: zeroUsage(),
    warning: null,
    degradation: null,
  };
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const result = await optionalEmbeddings(
      client,
      run,
      step,
      purpose,
      batch,
      signal,
    );
    outcome.usage = addUsage(outcome.usage, result.usage);
    if (result.degradation || result.warning) {
      outcome.warning = result.warning;
      outcome.degradation = result.degradation;
      break;
    }
    if (outcome.model && result.model && result.model !== outcome.model) {
      // The assignment changed mid-pass; vectors of two models never mix.
      break;
    }
    outcome.model = result.model ?? outcome.model;
    outcome.modelId = result.modelId ?? outcome.modelId;
    batch.forEach((_, index) => {
      const vector = result.vectors[index];
      if (vector && vector.length > 0) outcome.vectors[start + index] = vector;
    });
  }
  return outcome;
}

/**
 * Lazy indexing before retrieval: embeds the project's segments that have
 * no vector for the embedding model assigned to this run (fresh import,
 * edits accepted elsewhere, restored backups, a model switch). A no-op when
 * no embedding model is assigned.
 */
export async function embedPendingSegments(input: {
  database: NarrativeDatabase;
  client: NarrativeModelClient;
  run: NarrativeRun;
  step: NarrativeRunStep;
  purpose: string;
  signal: AbortSignal;
  now: string;
  maxInputs?: number;
}): Promise<IndexEmbeddingOutcome> {
  const empty = emptyIndexOutcome();
  const { client, run } = input;
  if (!client.embed || !(client.hasEmbeddingAssignment?.() ?? false))
    return empty;
  const model = client.embeddingModelName?.(run, input.purpose) ?? null;
  if (!model) return empty;
  const retrieval = new SqliteRetrievalRepository(input.database);
  const maxInputs = input.maxInputs ?? LAZY_INDEX_MAX_INPUTS;
  const batch = retrieval.listSegmentsMissingEmbedding(
    run.projectId,
    model,
    maxInputs,
  );
  if (batch.length === 0) return { ...empty, model };
  const result = await embedInBatches(
    client,
    run,
    input.step,
    input.purpose,
    batch.map((segment) => segment.content),
    input.signal,
  );
  let embedded = 0;
  if (result.model) {
    input.database.transaction(() => {
      batch.forEach((segment, index) => {
        const vector = result.vectors[index];
        if (!vector) return;
        if (
          retrieval.upsertEmbedding({
            segmentId: segment.segmentId,
            model: result.model!,
            embedding: vector,
            updatedAt: input.now,
            expectedContentHash: segment.contentHash,
          })
        )
          embedded += 1;
      });
    });
  }
  return {
    embedded,
    remaining: retrieval.countSegmentsMissingEmbedding(
      run.projectId,
      result.model ?? model,
    ),
    model: result.model ?? model,
    modelId: result.modelId,
    usage: result.usage,
    warning: result.warning,
    degradation: result.degradation,
  };
}

export interface PassageEmbeddings {
  vectors: ReadonlyMap<string, number[]>;
  model: string | null;
  modelId: string | null;
  usage: RunBudgetUsage;
  warning: { code: string; message: string } | null;
}

/**
 * Commit-time embedding of the passages a document version will be cut
 * into. Passages that already hold a vector of the assigned model (unchanged
 * text) are skipped, so an edit only pays for the passages it touched.
 */
export async function embedPlannedPassages(input: {
  database: NarrativeDatabase;
  client: NarrativeModelClient;
  run: NarrativeRun;
  step: NarrativeRunStep;
  purpose: string;
  passages: readonly PlannedPassage[];
  signal: AbortSignal;
}): Promise<PassageEmbeddings> {
  const model =
    input.client.embeddingModelName?.(input.run, input.purpose) ?? null;
  const already = model
    ? new SqliteRetrievalRepository(input.database).embeddedSegmentIds(
        input.passages,
        model,
      )
    : new Set<string>();
  const todo = input.passages.filter(
    (passage) => !already.has(passage.segmentId),
  );
  const result = await embedInBatches(
    input.client,
    input.run,
    input.step,
    input.purpose,
    todo.map((passage) => passage.text),
    input.signal,
  );
  const vectors = new Map<string, number[]>();
  todo.forEach((passage, index) => {
    const vector = result.vectors[index];
    if (vector) vectors.set(passage.segmentId, vector);
  });
  return {
    vectors,
    model: result.model,
    modelId: result.modelId,
    usage: result.usage,
    warning: result.warning,
  };
}

/**
 * Writes the passages of a document version and stores the vectors computed
 * for them by embedPlannedPassages. Call inside the commit transaction.
 */
export function indexDocumentWithEmbeddings(
  database: NarrativeDatabase,
  input: IndexDocumentInput,
  embeddings: PassageEmbeddings | null,
): { passages: number; embedded: number } {
  const indexed = new SqliteManuscriptIndexer(database).indexDocument(input);
  let embedded = 0;
  if (embeddings?.model) {
    const retrieval = new SqliteRetrievalRepository(database);
    for (const passage of indexed.passages) {
      const vector = embeddings.vectors.get(passage.segmentId);
      if (!vector) continue;
      if (
        retrieval.upsertEmbedding({
          segmentId: passage.segmentId,
          model: embeddings.model,
          embedding: vector,
          updatedAt: input.now,
          expectedContentHash: passage.contentHash,
        })
      )
        embedded += 1;
    }
  }
  return { passages: indexed.passages.length, embedded };
}

function emptyIndexOutcome(): IndexEmbeddingOutcome {
  return {
    embedded: 0,
    remaining: 0,
    model: null,
    modelId: null,
    usage: zeroUsage(),
    warning: null,
    degradation: null,
  };
}

function addUsage(left: RunBudgetUsage, right: RunBudgetUsage): RunBudgetUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    calls: left.calls + right.calls,
    costUsd: left.costUsd + right.costUsd,
    wallTimeMs: left.wallTimeMs + right.wallTimeMs,
  };
}

export function addBudgetUsage(
  ...usages: readonly RunBudgetUsage[]
): RunBudgetUsage {
  return usages.reduce(addUsage, zeroUsage());
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
