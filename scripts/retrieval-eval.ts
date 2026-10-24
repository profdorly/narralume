/**
 * Retrieval quality eval (evals/retrieval-v1.json).
 *
 * Builds each fixture book in an in-memory database, indexes it the way the
 * product does and runs every case through SqliteRetrievalRepository.search
 * with the same options the chapter writer uses (limit 8, no rerank). Each
 * case is scored at the chapter level (hit@1/3/8, MRR) under four signal
 * mixes: lexical, lexical+entity, vector and hybrid.
 *
 * Embedders:
 *   --embedder=hash    deterministic hashed bag-of-words vectors (default,
 *                      offline). It only exercises the vector plumbing; it
 *                      is not a semantic model.
 *   --embedder=openai  a real OpenAI-compatible /embeddings endpoint. Sends
 *                      the fixture text (never project data) to the API.
 *                      Key: NARRATIVE_EVAL_EMBEDDING_API_KEY, then
 *                      NARRATIVE_LLM_API_KEY. Base URL:
 *                      NARRATIVE_EVAL_EMBEDDING_BASE_URL, then
 *                      NARRATIVE_LLM_BASE_URL, then api.openai.com.
 *   --model=<name>     embedding model for --embedder=openai
 *                      (default text-embedding-3-small).
 *   --index=passage    index shape: passages (default, what the product
 *                      writes) or "chapter" (one segment per chapter, the
 *                      previous index) for comparison.
 *   --reranker=decisions
 *                      also score "hybrid+rerank": the hybrid candidates
 *                      reranked by OpenAI's Decisions API through the same
 *                      code the product runs. Sends fixture text only.
 *                      Same credentials as --embedder=openai.
 *   --rerank-model=<name>
 *                      Decisions model (default gpt-6-luna).
 *   --check            fail when the offline quality floor regresses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCanonEntity,
  createDocument,
  createOutlineNode,
  createProject,
} from "@narralume/domain";
import type {
  NarrativeRun,
  NarrativeRunStep,
  RunBudgetUsage,
} from "@narralume/domain";
import { generateOpenAIDecisions } from "@narralume/llm";
import {
  limitHitsPerDocument,
  RERANK_CANDIDATES,
  RERANK_MAX_PER_DOCUMENT,
  rerankRetrievalHits,
  RETRIEVAL_LIMIT,
  RETRIEVAL_MAX_PER_DOCUMENT,
  type NarrativeModelClient,
} from "@narralume/narrative";
import {
  LEGACY_DOCUMENT_SOURCE,
  segmentDocumentId,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteManuscriptIndexer,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteStoryRepository,
  type RetrievalHit,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";

type IndexMode = "passage" | "chapter";

interface Dataset {
  version: string;
  corpora: Corpus[];
}

interface Corpus {
  id: string;
  language: string;
  title: string;
  entities: {
    id: string;
    type: "character" | "location" | "item";
    name: string;
    aliases: string[];
  }[];
  chapters: { id: string; title: string; paragraphs: string[] }[];
  cases: EvalCase[];
}

type CaseKind = "keyword" | "paraphrase" | "plan" | "entity" | "noise";

interface EvalCase {
  id: string;
  kind: CaseKind;
  query: string;
  entityIds?: string[];
  relevant: string[];
  evidence?: string;
}

interface Embedder {
  name: string;
  model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

type SignalMix =
  "lexical" | "lexical+entity" | "vector" | "hybrid" | "hybrid+rerank";
const SIGNAL_MIXES: readonly SignalMix[] = [
  "lexical",
  "lexical+entity",
  "vector",
  "hybrid",
];

interface CaseResult {
  corpus: string;
  id: string;
  kind: CaseKind;
  mix: SignalMix;
  rankedChapters: string[];
  firstRelevantRank: number | null;
  hits: number;
  contextChars: number;
  topEvidence: boolean | null;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(
    readFileSync(resolve(root, "evals", "retrieval-v1.json"), "utf8"),
  ) as Dataset;
  const embedder =
    args.embedder === "openai" ? openAiEmbedder(args.model) : hashEmbedder();

  const reranker = args.reranker ? openAiReranker(args.rerankModel) : null;
  const mixes: readonly SignalMix[] = reranker
    ? [...SIGNAL_MIXES, "hybrid+rerank"]
    : SIGNAL_MIXES;
  const results: CaseResult[] = [];
  for (const corpus of dataset.corpora) {
    results.push(
      ...(await evaluateCorpus(corpus, embedder, args.index, reranker)),
    );
  }

  const summary = summarize(results, mixes);
  const report = {
    dataset: dataset.version,
    generatedAt: new Date().toISOString(),
    embedder: { name: embedder.name, model: embedder.model },
    index: args.index,
    reranker: reranker
      ? {
          model: args.rerankModel,
          calls: reranker.usage.calls,
          inputTokens: reranker.usage.inputTokens,
        }
      : null,
    summary,
    results,
  };
  const reportPath = resolve(
    root,
    ".tmp",
    "evals",
    `${dataset.version}-${embedder.name}-${args.index}${reranker ? "-rerank" : ""}.json`,
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    `embedder: ${embedder.name} (${embedder.model}) · index: ${args.index}${
      reranker
        ? ` · reranker: ${args.rerankModel} (${reranker.usage.calls} calls, ${reranker.usage.inputTokens} input tokens)`
        : ""
    }`,
  );
  printSummary(summary, mixes);
  console.log(`report: ${reportPath}`);

  if (args.check) {
    const failures = checkFloor(summary, args.index);
    if (failures.length > 0) {
      console.error(
        `retrieval quality floor failed:\n- ${failures.join("\n- ")}`,
      );
      process.exitCode = 1;
    }
  }
}

async function evaluateCorpus(
  corpus: Corpus,
  embedder: Embedder,
  indexMode: IndexMode,
  reranker: Reranker | null,
): Promise<CaseResult[]> {
  const database = new NodeNarrativeDatabase();
  try {
    database.migrate();
    const now = "2026-10-01T00:00:00.000Z";
    const projectId = `eval-${corpus.id}`;
    new SqliteProjectRepository(database).insert(
      createProject({ id: projectId, title: corpus.title, now }),
    );
    const canon = new SqliteCanonRepository(database);
    for (const entity of corpus.entities) {
      canon.insertEntity(
        createCanonEntity({
          id: entity.id,
          projectId,
          type: entity.type,
          name: entity.name,
          aliases: entity.aliases,
          now,
        }),
      );
    }
    // The book as the product stores it: outline chapters bound to
    // manuscript documents with one committed version each.
    const story = new SqliteStoryRepository(database);
    const documents = new SqliteDocumentRepository(database);
    const root = story.insertOutlineNode(
      createOutlineNode({
        id: `${projectId}:book`,
        projectId,
        parent: null,
        kind: "book",
        ordinal: 0,
        title: corpus.title,
        now,
      }),
    );
    const chapterOfDocument = new Map<string, string>();
    corpus.chapters.forEach((chapter, ordinal) => {
      const node = story.insertOutlineNode(
        createOutlineNode({
          id: `${projectId}:${chapter.id}`,
          projectId,
          parent: root,
          kind: "chapter",
          ordinal,
          title: chapter.title,
          now,
        }),
      );
      const document = documents.insert(
        createDocument({
          id: `doc-${chapter.id}`,
          projectId,
          kind: "chapter",
          title: chapter.title,
          outlineNodeId: node.id,
          now,
        }),
      );
      documents.appendVersion(projectId, document.id, {
        id: `version-${chapter.id}`,
        content: chapter.paragraphs.join("\n\n"),
        source: "eval",
        expectedCurrentVersionId: null,
        now,
      });
      chapterOfDocument.set(document.id, chapter.id);
    });

    const retrieval = new SqliteRetrievalRepository(database);
    if (indexMode === "passage") {
      new SqliteManuscriptIndexer(database).syncProject(projectId, now);
    } else {
      // The previous index: one segment per chapter, no entity links.
      corpus.chapters.forEach((chapter) => {
        retrieval.upsertSegment({
          id: `document:doc-${chapter.id}:current`,
          projectId,
          sourceType: LEGACY_DOCUMENT_SOURCE,
          sourceId: `doc-${chapter.id}`,
          title: chapter.title,
          content: chapter.paragraphs.join("\n\n"),
          authority: "confirmed",
          metadata: { documentId: `doc-${chapter.id}` },
          entityIds: [],
          createdAt: now,
          updatedAt: now,
        });
      });
    }
    const pending = retrieval.listSegmentsMissingEmbedding(
      projectId,
      embedder.model,
      10_000,
    );
    const vectors = await embedder.embed(
      pending.map((segment) => segment.content),
    );
    pending.forEach((segment, index) => {
      retrieval.upsertEmbedding({
        segmentId: segment.segmentId,
        model: embedder.model,
        embedding: vectors[index]!,
        updatedAt: now,
        expectedContentHash: segment.contentHash,
      });
    });

    const queries = corpus.cases.map((entry) => entry.query);
    const queryVectors = await embedder.embed(
      queries.map((query) => query || " "),
    );
    const results: CaseResult[] = [];
    for (const [index, entry] of corpus.cases.entries()) {
      for (const mix of SIGNAL_MIXES) {
        const useLexical = mix !== "vector";
        const useEntity = mix === "lexical+entity" || mix === "hybrid";
        const useVector = mix === "vector" || mix === "hybrid";
        const hits = retrieval.search(
          projectId,
          useLexical ? entry.query : "",
          {
            entityIds: useEntity ? (entry.entityIds ?? []) : [],
            limit: RETRIEVAL_LIMIT,
            rerank: false,
            ...(indexMode === "passage"
              ? { maxPerDocument: RETRIEVAL_MAX_PER_DOCUMENT }
              : {}),
            ...(useVector && entry.query
              ? {
                  queryEmbedding: queryVectors[index]!,
                  embeddingModel: embedder.model,
                }
              : {}),
          },
        );
        results.push(scoreCase(corpus, entry, mix, hits, chapterOfDocument));
      }
      if (reranker) {
        // What the chapter writer does with a rerank model assigned.
        const candidates = retrieval.search(projectId, entry.query, {
          entityIds: entry.entityIds ?? [],
          limit: RERANK_CANDIDATES,
          rerank: false,
          maxPerDocument: RERANK_MAX_PER_DOCUMENT,
          ...(entry.query
            ? {
                queryEmbedding: queryVectors[index]!,
                embeddingModel: embedder.model,
              }
            : {}),
        });
        const reranked = await rerankRetrievalHits({
          client: reranker.client,
          run: EVAL_RUN,
          step: EVAL_STEP,
          purpose: "retrieval-eval-rerank",
          task: entry.query || corpus.title,
          language: corpus.language,
          hits: candidates,
          signal: new AbortController().signal,
        });
        if (reranked.warning)
          throw new Error(
            `Rerank failed: ${reranked.warning.code} ${reranked.warning.message}`,
          );
        results.push(
          scoreCase(
            corpus,
            entry,
            "hybrid+rerank",
            limitHitsPerDocument(
              reranked.hits,
              RETRIEVAL_MAX_PER_DOCUMENT,
            ).slice(0, RETRIEVAL_LIMIT),
            chapterOfDocument,
          ),
        );
      }
    }
    return results;
  } finally {
    database.close();
  }
}

function scoreCase(
  corpus: Corpus,
  entry: EvalCase,
  mix: SignalMix,
  hits: readonly RetrievalHit[],
  chapterOfDocument: ReadonlyMap<string, string>,
): CaseResult {
  const rankedChapters: string[] = [];
  for (const hit of hits) {
    const documentId = segmentDocumentId(hit) ?? hit.sourceId;
    const chapter = chapterOfDocument.get(documentId) ?? documentId;
    if (!rankedChapters.includes(chapter)) rankedChapters.push(chapter);
  }
  const firstIndex = rankedChapters.findIndex((chapter) =>
    entry.relevant.includes(chapter),
  );
  const top = hits[0];
  return {
    corpus: corpus.id,
    id: entry.id,
    kind: entry.kind,
    mix,
    rankedChapters,
    firstRelevantRank: firstIndex >= 0 ? firstIndex + 1 : null,
    hits: hits.length,
    contextChars: hits.reduce((total, hit) => total + hit.content.length, 0),
    topEvidence:
      entry.evidence && top ? top.content.includes(entry.evidence) : null,
  };
}

interface MixSummary {
  cases: number;
  hitAt1: number;
  hitAt3: number;
  hitAt8: number;
  mrr: number;
  avgContextChars: number;
  evidenceAt1: number | null;
}

type Summary = Record<
  SignalMix,
  Partial<Record<CaseKind | "all", MixSummary>> & {
    noiseHits: number;
  }
>;

function summarize(
  results: readonly CaseResult[],
  mixes: readonly SignalMix[],
): Summary {
  const summary = {} as Summary;
  for (const mix of mixes) {
    const forMix = results.filter((result) => result.mix === mix);
    const scored = forMix.filter((result) => result.kind !== "noise");
    const entry: Summary[SignalMix] = {
      noiseHits: forMix
        .filter((result) => result.kind === "noise")
        .reduce((total, result) => total + result.hits, 0),
    };
    entry.all = mixSummary(scored);
    for (const kind of ["keyword", "paraphrase", "plan", "entity"] as const) {
      const ofKind = scored.filter((result) => result.kind === kind);
      if (ofKind.length > 0) entry[kind] = mixSummary(ofKind);
    }
    summary[mix] = entry;
  }
  return summary;
}

function mixSummary(results: readonly CaseResult[]): MixSummary {
  const rate = (predicate: (result: CaseResult) => boolean) =>
    round(results.filter(predicate).length / Math.max(1, results.length));
  const withEvidence = results.filter((result) => result.topEvidence !== null);
  return {
    cases: results.length,
    hitAt1: rate((result) => (result.firstRelevantRank ?? 99) <= 1),
    hitAt3: rate((result) => (result.firstRelevantRank ?? 99) <= 3),
    hitAt8: rate((result) => (result.firstRelevantRank ?? 99) <= 8),
    mrr: round(
      results.reduce(
        (total, result) =>
          total + (result.firstRelevantRank ? 1 / result.firstRelevantRank : 0),
        0,
      ) / Math.max(1, results.length),
    ),
    avgContextChars: Math.round(
      results.reduce((total, result) => total + result.contextChars, 0) /
        Math.max(1, results.length),
    ),
    evidenceAt1:
      withEvidence.length > 0
        ? round(
            withEvidence.filter((result) => result.topEvidence).length /
              withEvidence.length,
          )
        : null,
  };
}

function printSummary(summary: Summary, mixes: readonly SignalMix[]): void {
  const rows: string[] = [];
  rows.push(
    "mix             kind        cases  hit@1  hit@3  hit@8   MRR   ctxChars  evid@1",
  );
  for (const mix of mixes) {
    const entry = summary[mix];
    for (const kind of [
      "all",
      "keyword",
      "paraphrase",
      "plan",
      "entity",
    ] as const) {
      const value = entry[kind];
      if (!value) continue;
      rows.push(
        [
          mix.padEnd(15),
          kind.padEnd(11),
          String(value.cases).padStart(5),
          value.hitAt1.toFixed(2).padStart(6),
          value.hitAt3.toFixed(2).padStart(6),
          value.hitAt8.toFixed(2).padStart(6),
          value.mrr.toFixed(2).padStart(6),
          String(value.avgContextChars).padStart(9),
          (value.evidenceAt1 === null ? "-" : value.evidenceAt1.toFixed(2))
            .toString()
            .padStart(7),
        ].join(" "),
      );
    }
    rows.push(`${mix.padEnd(15)} noise hits: ${entry.noiseHits}`);
  }
  console.log(rows.join("\n"));
}

/**
 * Offline floor for the deterministic embedder. It guards the lexical and
 * entity fixes and the vector plumbing; semantic quality needs a real model.
 * The previous chapter index has no floor (it is only a comparison point).
 */
function checkFloor(summary: Summary, index: IndexMode): string[] {
  if (index !== "passage") return [];
  const failures: string[] = [];
  const expectAtLeast = (
    label: string,
    value: number | undefined,
    min: number,
  ) => {
    if (value === undefined || value < min)
      failures.push(`${label} = ${value ?? "n/a"} (expected >= ${min})`);
  };
  expectAtLeast("lexical keyword hit@3", summary.lexical.keyword?.hitAt3, 0.9);
  expectAtLeast("lexical keyword MRR", summary.lexical.keyword?.mrr, 0.75);
  expectAtLeast(
    "lexical+entity entity hit@1",
    summary["lexical+entity"].entity?.hitAt1,
    1,
  );
  expectAtLeast("hybrid keyword hit@3", summary.hybrid.keyword?.hitAt3, 0.9);
  expectAtLeast("hybrid plan hit@3", summary.hybrid.plan?.hitAt3, 0.75);
  if (summary.lexical.noiseHits > 0)
    failures.push(
      `lexical noise hits = ${summary.lexical.noiseHits} (expected 0)`,
    );
  return failures;
}

function hashEmbedder(dimensions = 512): Embedder {
  return {
    name: "hash",
    model: `eval-hash-${dimensions}`,
    async embed(texts) {
      return texts.map((text) => hashVector(text, dimensions));
    },
  };
}

const HASH_STOPWORDS = new Set(
  (
    "a o as os um uma uns umas de do da dos das no na nos nas em por para com sem que se " +
    "e ou mas como mais quando onde ele ela eles elas lhe seu sua the of and to in on at for " +
    "with from by an is was were be been his her their he she it its that this as not had have"
  ).split(" "),
);

function hashVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const counts = new Map<string, number>();
  const words = text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !HASH_STOPWORDS.has(word));
  for (const word of words) {
    const stem = word.slice(0, 6);
    counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }
  for (const [stem, count] of counts) {
    const hash = fnv1a(stem);
    const sign = (hash >>> 16) & 1 ? 1 : -1;
    vector[hash % dimensions]! += sign * (1 + Math.log(count));
  }
  if (!vector.some((value) => value !== 0)) vector[0] = 1;
  return vector;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function openAiEmbedder(model: string): Embedder {
  const { apiKey, baseUrl } = openAiCredentials("--embedder=openai");
  return {
    name: `openai-${model}`,
    model,
    async embed(texts) {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += 64) {
        const response = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: texts.slice(start, start + 64),
            encoding_format: "float",
          }),
        });
        if (!response.ok) {
          // Report the status and error code only; upstream bodies can echo
          // parts of the credential.
          const body = (await response.json().catch(() => null)) as {
            error?: { code?: unknown; type?: unknown };
          } | null;
          const code = body?.error?.code ?? body?.error?.type ?? "unknown";
          throw new Error(
            `Embedding request failed: HTTP ${response.status} (${String(code)})`,
          );
        }
        const body = (await response.json()) as {
          data: { index: number; embedding: number[] }[];
        };
        vectors.push(
          ...body.data
            .sort((left, right) => left.index - right.index)
            .map((entry) => entry.embedding),
        );
      }
      return vectors;
    },
  };
}

interface Reranker {
  client: NarrativeModelClient;
  usage: RunBudgetUsage;
}

const EVAL_RUN = {
  id: "retrieval-eval",
  projectId: "retrieval-eval",
  policy: {},
} as unknown as NarrativeRun;
const EVAL_STEP = {
  id: "retrieval-eval:rerank",
  runId: "retrieval-eval",
} as unknown as NarrativeRunStep;

/**
 * A model client that only offers `decide`, backed by the real Decisions
 * API. The product's rerankRetrievalHits builds the questions.
 */
function openAiReranker(model: string): Reranker {
  const { apiKey, baseUrl } = openAiCredentials("--reranker=decisions");
  const usage: RunBudgetUsage = {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
  const client = {
    text: () => Promise.reject(new Error("not used")),
    structured: () => Promise.reject(new Error("not used")),
    hasRerankAssignment: () => true,
    async decide(
      _run: NarrativeRun,
      _step: NarrativeRunStep,
      _purpose: string,
      request: Parameters<typeof generateOpenAIDecisions>[2],
    ) {
      const started = Date.now();
      try {
        const result = await generateOpenAIDecisions(
          { protocol: "openai-responses", baseUrl, apiKey, timeoutMs: 120_000 },
          model,
          request,
        );
        const callUsage = {
          inputTokens: result.usage.inputTokens,
          outputTokens: 0,
          calls: 1,
          costUsd: 0,
          wallTimeMs: Date.now() - started,
        };
        usage.inputTokens += callUsage.inputTokens;
        usage.calls += 1;
        usage.wallTimeMs += callUsage.wallTimeMs;
        return {
          answers: result.answers,
          model,
          modelId: model,
          usage: callUsage,
        };
      } catch (error) {
        // Report the status and error code only, never the provider body.
        const status =
          error && typeof error === "object" && "status" in error
            ? String((error as { status: unknown }).status)
            : "?";
        throw {
          code: "eval.rerank.failed",
          message: `Decisions request failed (HTTP ${status})`,
          retryable: false,
        };
      }
    },
  } as unknown as NarrativeModelClient;
  return { client, usage };
}

function openAiCredentials(flag: string): { apiKey: string; baseUrl: string } {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(root, file);
    if (existsSync(path)) process.loadEnvFile(path);
  }
  const apiKey =
    process.env.NARRATIVE_EVAL_EMBEDDING_API_KEY ??
    process.env.NARRATIVE_LLM_API_KEY;
  const baseUrl = (
    process.env.NARRATIVE_EVAL_EMBEDDING_BASE_URL ??
    process.env.NARRATIVE_LLM_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/+$/u, "");
  if (!apiKey)
    throw new Error(
      `Set NARRATIVE_EVAL_EMBEDDING_API_KEY (or NARRATIVE_LLM_API_KEY) to use ${flag}`,
    );
  return { apiKey, baseUrl };
}

function parseArgs(argv: readonly string[]) {
  let embedderName: "hash" | "openai" = "hash";
  let model = "text-embedding-3-small";
  let index: IndexMode = "passage";
  let reranker: "decisions" | null = null;
  let rerankModel = "gpt-6-luna";
  let check = false;
  for (const argument of argv) {
    if (argument === "--check") check = true;
    else if (argument.startsWith("--embedder=")) {
      const value = argument.slice("--embedder=".length);
      if (value !== "hash" && value !== "openai")
        throw new Error(`Unknown embedder: ${value}`);
      embedderName = value;
    } else if (argument.startsWith("--model=")) {
      model = argument.slice("--model=".length).trim() || model;
    } else if (argument.startsWith("--reranker=")) {
      const value = argument.slice("--reranker=".length);
      if (value !== "decisions") throw new Error(`Unknown reranker: ${value}`);
      reranker = value;
    } else if (argument.startsWith("--rerank-model=")) {
      rerankModel =
        argument.slice("--rerank-model=".length).trim() || rerankModel;
    } else if (argument.startsWith("--index=")) {
      const value = argument.slice("--index=".length);
      if (value !== "passage" && value !== "chapter")
        throw new Error(`Unknown index shape: ${value}`);
      index = value;
    } else {
      throw new Error(
        "Usage: tsx scripts/retrieval-eval.ts [--embedder=hash|openai] [--model=name] [--index=passage|chapter] [--reranker=decisions] [--rerank-model=name] [--check]",
      );
    }
  }
  return { embedder: embedderName, model, index, reranker, rerankModel, check };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

await main();
