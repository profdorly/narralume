import {
  createDocument,
  createOutlineNode,
  createProject,
  type NarrativeRun,
  type NarrativeRunStep,
} from "@narralume/domain";
import {
  SqliteDocumentRepository,
  SqliteManuscriptIndexer,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteStoryRepository,
  type RetrievalHit,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chapterRetrievalQuery,
  EMBEDDING_BATCH_SIZE,
  embedInBatches,
  embedPendingSegments,
  embedPlannedPassages,
  indexDocumentWithEmbeddings,
  retrievalContextSources,
  type NarrativeModelClient,
} from "../src/index.js";

const now = "2026-10-01T00:00:00.000Z";
const run = {
  id: "run-1",
  projectId: "p1",
  policy: {},
} as unknown as NarrativeRun;
const step = {
  id: "run-1:context",
  runId: "run-1",
} as unknown as NarrativeRunStep;
const signal = new AbortController().signal;

let database: NodeNarrativeDatabase;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "O Farol", now }),
  );
  const story = new SqliteStoryRepository(database);
  const book = story.insertOutlineNode(
    createOutlineNode({
      id: "book",
      projectId: "p1",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "O Farol",
      now,
    }),
  );
  story.insertOutlineNode(
    createOutlineNode({
      id: "node-c1",
      projectId: "p1",
      parent: book,
      kind: "chapter",
      ordinal: 0,
      title: "Capítulo 1",
      now,
    }),
  );
  new SqliteDocumentRepository(database).insert(
    createDocument({
      id: "c1",
      projectId: "p1",
      kind: "chapter",
      title: "Capítulo 1",
      outlineNodeId: "node-c1",
      now,
    }),
  );
});

afterEach(() => database.close());

function fakeClient(
  options: { model?: string | null; failOnCall?: number } = {},
) {
  const calls: { purpose: string; inputs: readonly string[] }[] = [];
  const model = options.model === undefined ? "fake-embedding" : options.model;
  const client = {
    text: async () => {
      throw new Error("not used");
    },
    structured: async () => {
      throw new Error("not used");
    },
    hasEmbeddingAssignment: () => model !== null,
    embeddingModelName: () => model,
    async embed(
      _run: NarrativeRun,
      _step: NarrativeRunStep,
      purpose: string,
      request: { inputs: readonly string[] },
    ) {
      calls.push({ purpose, inputs: request.inputs });
      if (options.failOnCall === calls.length)
        throw {
          code: "model.network",
          message: "upstream down",
          retryable: true,
        };
      return {
        vectors: request.inputs.map((input) => [input.length, 1]),
        model: model!,
        modelId: `${model}-id`,
        usage: {
          inputTokens: request.inputs.length,
          outputTokens: 0,
          calls: 1,
          costUsd: 0,
          wallTimeMs: 1,
        },
      };
    },
  } as unknown as NarrativeModelClient;
  return { client, calls };
}

const scene = (label: string) =>
  Array.from(
    { length: 6 },
    (_, index) =>
      `${label} ${index}: ${"A neblina cobria o cais e as redes molhadas. ".repeat(8)}`,
  ).join("\n\n");

function commitVersion(versionId: string, content: string) {
  new SqliteDocumentRepository(database).appendVersion("p1", "c1", {
    id: versionId,
    content,
    source: "test",
    now,
  });
}

async function embedAndIndex(
  client: NarrativeModelClient,
  versionId: string,
  content: string,
) {
  commitVersion(versionId, content);
  const indexer = new SqliteManuscriptIndexer(database);
  const embeddings = await embedPlannedPassages({
    database,
    client,
    run,
    step,
    purpose: "chapter-index",
    passages: indexer.planPassages("c1", "Capítulo 1", content),
    signal,
  });
  return indexDocumentWithEmbeddings(
    database,
    { projectId: "p1", documentId: "c1", versionId, now },
    embeddings,
  );
}

describe("commit-time passage embedding", () => {
  it("embeds every passage once and only changed passages after an edit", async () => {
    const { client, calls } = fakeClient();
    const original = `${scene("Um")}\n\n* * *\n\n${scene("Dois")}`;
    const first = await embedAndIndex(client, "v1", original);
    expect(first.passages).toBeGreaterThan(1);
    expect(first.embedded).toBe(first.passages);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.inputs).toHaveLength(first.passages);

    const second = await embedAndIndex(
      client,
      "v2",
      `${scene("Um")}\n\n* * *\n\n${scene("Dois")} Fim.`,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.inputs.length).toBeLessThan(first.passages);
    expect(calls[1]!.inputs.length).toBe(second.embedded);
    const retrieval = new SqliteRetrievalRepository(database);
    expect(retrieval.embeddingCounts("p1")).toMatchObject({
      segments: second.passages,
      embedded: second.passages,
    });
  });

  it("indexes without vectors and makes no call when no embedding model is assigned", async () => {
    const { client, calls } = fakeClient({ model: null });
    const result = await embedAndIndex(client, "v1", scene("Um"));
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ embedded: 0 });
    expect(result.passages).toBeGreaterThan(0);
  });
});

describe("embedPendingSegments", () => {
  it("re-embeds the index for a new model and reports what is left", async () => {
    const old = fakeClient({ model: "old-model" });
    await embedAndIndex(old.client, "v1", scene("Um"));
    const total = new SqliteRetrievalRepository(database).embeddingCounts(
      "p1",
    ).segments;

    const next = fakeClient({ model: "new-model" });
    const partial = await embedPendingSegments({
      database,
      client: next.client,
      run,
      step,
      purpose: "context-retrieval-index",
      signal,
      now,
      maxInputs: 1,
    });
    expect(partial).toMatchObject({
      embedded: 1,
      remaining: total - 1,
      model: "new-model",
    });
    const rest = await embedPendingSegments({
      database,
      client: next.client,
      run,
      step,
      purpose: "context-retrieval-index",
      signal,
      now,
    });
    expect(rest).toMatchObject({ embedded: total - 1, remaining: 0 });
    expect(
      new SqliteRetrievalRepository(database).embeddingCounts("p1").models,
    ).toEqual([
      expect.objectContaining({ model: "new-model", segments: total }),
    ]);
  });

  it("is a no-op without an embedding model", async () => {
    const { client, calls } = fakeClient({ model: null });
    commitVersion("v1", scene("Um"));
    new SqliteManuscriptIndexer(database).syncProject("p1", now);
    expect(
      await embedPendingSegments({
        database,
        client,
        run,
        step,
        purpose: "context-retrieval-index",
        signal,
        now,
      }),
    ).toMatchObject({ embedded: 0, remaining: 0, model: null });
    expect(calls).toEqual([]);
  });
});

describe("embedInBatches", () => {
  it("splits large inputs into batches and stops at the first failure", async () => {
    const { client, calls } = fakeClient({ failOnCall: 2 });
    const texts = Array.from(
      { length: EMBEDDING_BATCH_SIZE * 2 + 3 },
      (_, index) => `texto ${index}`,
    );
    const outcome = await embedInBatches(
      client,
      run,
      step,
      "chapter-index",
      texts,
      signal,
    );
    expect(calls.map((call) => call.inputs.length)).toEqual([
      EMBEDDING_BATCH_SIZE,
      EMBEDDING_BATCH_SIZE,
    ]);
    expect(outcome.vectors.filter(Boolean)).toHaveLength(EMBEDDING_BATCH_SIZE);
    expect(outcome.warning).toMatchObject({ code: "model.network" });
    expect(outcome.model).toBe("fake-embedding");
  });
});

describe("chapterRetrievalQuery", () => {
  it("uses the plan, entity names and director notes", () => {
    expect(
      chapterRetrievalQuery({
        title: "Capítulo 8",
        summary: "Helena entra na gruta.",
        goal: "Achar a porta",
        conflict: null,
        outcome: "",
        entityNames: ["Joaquim"],
        steerNotes: ["Mais tensão"],
        previousChapterSummary: "Ignorado quando há plano.",
      }),
    ).toBe(
      "Capítulo 8\nHelena entra na gruta.\nAchar a porta\nMais tensão\nJoaquim",
    );
  });

  it("falls back to the previous chapter summary when the node has no plan", () => {
    expect(
      chapterRetrievalQuery({
        title: "Capítulo 41",
        previousChapterSummary: "Tomás confessa a luz verde.",
      }),
    ).toBe("Capítulo 41\nTomás confessa a luz verde.");
  });
});

describe("retrievalContextSources", () => {
  const hit = (id: string, passageIndex?: number): RetrievalHit => ({
    id,
    projectId: "p1",
    sourceType:
      passageIndex === undefined ? "narrative_memory" : "document_passage",
    sourceId: id,
    title: "Capítulo 2",
    content: `Conteúdo ${id}`,
    authority: "confirmed",
    metadata:
      passageIndex === undefined
        ? {}
        : { documentId: "c2", passageIndex, passageCount: 4 },
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
  });

  it("keeps rank order in ids and priorities and labels passages", () => {
    const sources = retrievalContextSources(
      [hit("zeta", 2), hit("alpha"), hit("mid", 0)],
      {
        idPrefix: "retrieval",
        language: "pt-BR",
        priorityBase: 62,
        authority: () => "confirmed",
      },
    );
    expect(sources.map((source) => source.id)).toEqual([
      "retrieval:01:zeta",
      "retrieval:02:alpha",
      "retrieval:03:mid",
    ]);
    expect([...sources.map((source) => source.id)].sort()).toEqual(
      sources.map((source) => source.id),
    );
    expect(sources.map((source) => source.priority)).toEqual([62, 61, 60]);
    expect(sources[0]!.label).toBe(
      "Trecho recuperado 1 · Capítulo 2 (trecho 3 de 4)",
    );
    expect(sources[1]!.label).toBe("Recuperado 2 · Capítulo 2");
    expect(
      retrievalContextSources([hit("one", 0)], {
        idPrefix: "r",
        language: "en",
        priorityBase: 10,
        authority: () => "reference",
      })[0]!.label,
    ).toBe("Retrieved passage 1 · Capítulo 2 (passage 1 of 4)");
  });
});
