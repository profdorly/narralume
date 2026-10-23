import { createDocument, createProject } from "@narralume/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  segmentContentHash,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
} from "../src/index.js";
import { NodeNarrativeDatabase } from "../src/node.js";

const now = "2026-10-01T00:00:00.000Z";
let database: NodeNarrativeDatabase;
let retrieval: SqliteRetrievalRepository;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "O Farol", now }),
  );
  retrieval = new SqliteRetrievalRepository(database);
});

afterEach(() => database.close());

function segment(
  id: string,
  content: string,
  options: { documentId?: string; title?: string } = {},
) {
  return retrieval.upsertSegment({
    id,
    projectId: "p1",
    sourceType: "note",
    sourceId: id,
    title: options.title ?? "",
    content,
    authority: "confirmed",
    metadata: options.documentId ? { documentId: options.documentId } : {},
    entityIds: [],
    createdAt: now,
    updatedAt: now,
  });
}

describe("SqliteRetrievalRepository.search", () => {
  it("matches multi-word queries by terms, not as an exact phrase", () => {
    segment(
      "lantern",
      "Era ele quem acendia a lanterna verde no topo do farol.",
    );
    segment("salt", "As salinas ficavam rasas na virada da maré.");
    segment("bell", "O sino de bronze estava coberto por uma lona.");
    const hits = retrieval.search(
      "p1",
      "quem acende a luz verde lá no alto do farol?",
    );
    expect(hits[0]?.id).toBe("lantern");
    expect(hits.map((hit) => hit.id)).not.toContain("bell");
  });

  it("folds accents and inflections", () => {
    segment("notes", "As anotações de Inês falavam do naufrágio.");
    expect(
      retrieval.search("p1", "anotacao da Ines sobre o naufragio")[0]?.id,
    ).toBe("notes");
  });

  it("returns nothing for a bare chapter heading", () => {
    segment("c11", "Capítulo 11 começa com chuva.", { title: "Capítulo 11" });
    expect(retrieval.search("p1", "Capítulo 11")).toEqual([]);
  });

  it("still finds Chinese text through the trigram index", () => {
    segment("zh", "林昭确认铜钥匙属于旧港仓库。");
    segment("other", "完全无关的句子。");
    expect(retrieval.search("p1", "铜钥匙")[0]?.id).toBe("zh");
  });

  it("limits passages per document and excludes pinned documents", () => {
    const documents = new SqliteDocumentRepository(database);
    for (const id of ["doc-a", "doc-b"])
      documents.insert(
        createDocument({
          id,
          projectId: "p1",
          kind: "chapter",
          title: id,
          now,
        }),
      );
    for (let index = 0; index < 4; index += 1)
      segment(`a${index}`, `A lanterna verde piscou ${index} vezes.`, {
        documentId: "doc-a",
      });
    segment("b0", "A lanterna verde voltou a piscar.", { documentId: "doc-b" });
    segment("memory", "Lembrança: a lanterna verde é o sinal.");

    const diverse = retrieval.search("p1", "lanterna verde", {
      maxPerDocument: 2,
    });
    expect(
      diverse.filter((hit) => hit.metadata.documentId === "doc-a"),
    ).toHaveLength(2);
    expect(diverse.map((hit) => hit.id)).toEqual(
      expect.arrayContaining(["b0", "memory"]),
    );

    const excluded = retrieval.search("p1", "lanterna verde", {
      excludeDocumentIds: ["doc-a"],
    });
    expect(excluded.map((hit) => hit.id).sort()).toEqual(["b0", "memory"]);
  });

  it("keeps only vector matches close to the best one", () => {
    const vectors: Record<string, number[]> = {
      best: [1, 0, 0, 0],
      close: [0.95, 0.31, 0, 0],
      far: [0.2, 0.98, 0, 0],
    };
    for (const [id, embedding] of Object.entries(vectors)) {
      segment(id, `Texto ${id}.`);
      retrieval.upsertEmbedding({
        segmentId: id,
        model: "test",
        embedding,
        updatedAt: now,
      });
    }
    const hits = retrieval.search("p1", "", {
      queryEmbedding: [1, 0, 0, 0],
      embeddingModel: "test",
    });
    expect(hits.map((hit) => hit.id)).toEqual(["best", "close"]);
    expect(hits[0]!.vectorScore).toBeCloseTo(1, 5);
    // Another model's vectors never mix in.
    expect(
      retrieval.search("p1", "", {
        queryEmbedding: [1, 0, 0, 0],
        embeddingModel: "other-model",
      }),
    ).toEqual([]);
  });
});

describe("SqliteRetrievalRepository embeddings", () => {
  it("refuses a vector computed from text that changed meanwhile", () => {
    const stored = segment("s1", "Texto original.");
    const staleHash = segmentContentHash(stored.title, stored.content);
    segment("s1", "Texto editado depois.");
    expect(
      retrieval.upsertEmbedding({
        segmentId: "s1",
        model: "test",
        embedding: [1, 0],
        updatedAt: now,
        expectedContentHash: staleHash,
      }),
    ).toBe(false);
    expect(retrieval.embeddingCounts("p1").embedded).toBe(0);
    expect(
      retrieval.upsertEmbedding({
        segmentId: "s1",
        model: "test",
        embedding: [1, 0],
        updatedAt: now,
        expectedContentHash: segmentContentHash("", "Texto editado depois."),
      }),
    ).toBe(true);
    expect(retrieval.embeddingCounts("p1")).toEqual({
      segments: 1,
      embedded: 1,
      models: [{ model: "test", dimensions: 2, segments: 1 }],
    });
  });

  it("lists segments missing a vector of the current model", () => {
    segment("s1", "Um.");
    segment("s2", "Dois.");
    retrieval.upsertEmbedding({
      segmentId: "s1",
      model: "old-model",
      embedding: [1, 0],
      updatedAt: now,
    });
    retrieval.upsertEmbedding({
      segmentId: "s2",
      model: "new-model",
      embedding: [1, 0],
      updatedAt: now,
    });
    expect(
      retrieval
        .listSegmentsMissingEmbedding("p1", "new-model", 10)
        .map((entry) => entry.segmentId),
    ).toEqual(["s1"]);
    expect([
      ...retrieval.embeddedSegmentIds(
        [{ segmentId: "s1" }, { segmentId: "s2" }],
        "new-model",
      ),
    ]).toEqual(["s2"]);
  });
});
