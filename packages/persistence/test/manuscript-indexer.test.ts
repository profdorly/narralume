import {
  createCanonEntity,
  createDocument,
  createOutlineNode,
  createProject,
  type OutlineNode,
} from "@narralume/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DOCUMENT_PASSAGE_SOURCE,
  LEGACY_DOCUMENT_SOURCE,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteManuscriptIndexer,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteStoryRepository,
} from "../src/index.js";
import { NodeNarrativeDatabase } from "../src/node.js";

const now = "2026-10-01T00:00:00.000Z";
const later = "2026-10-02T00:00:00.000Z";

let database: NodeNarrativeDatabase;
let documents: SqliteDocumentRepository;
let retrieval: SqliteRetrievalRepository;
let indexer: SqliteManuscriptIndexer;
let canon: SqliteCanonRepository;
let story: SqliteStoryRepository;
let book: OutlineNode;

const longScene = (label: string, paragraphs = 6) =>
  Array.from(
    { length: paragraphs },
    (_, index) =>
      `${label} parágrafo ${index}: ${"Helena caminhou pelo cais molhado enquanto a neblina cobria as redes. ".repeat(6)}`,
  ).join("\n\n");

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "O Farol", now }),
  );
  story = new SqliteStoryRepository(database);
  documents = new SqliteDocumentRepository(database);
  retrieval = new SqliteRetrievalRepository(database);
  indexer = new SqliteManuscriptIndexer(database);
  canon = new SqliteCanonRepository(database);
  book = story.insertOutlineNode(
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
  canon.insertEntity(
    createCanonEntity({
      id: "helena",
      projectId: "p1",
      type: "character",
      name: "Helena Prates",
      aliases: ["Helena"],
      now,
    }),
  );
  canon.insertEntity(
    createCanonEntity({
      id: "tomas",
      projectId: "p1",
      type: "character",
      name: "Tomás",
      aliases: [],
      now,
    }),
  );
});

afterEach(() => database.close());

function chapter(id: string, ordinal: number, content: string) {
  const node = story.insertOutlineNode(
    createOutlineNode({
      id: `node-${id}`,
      projectId: "p1",
      parent: book,
      kind: "chapter",
      ordinal,
      title: `Capítulo ${ordinal + 1}`,
      now,
    }),
  );
  const document = documents.insert(
    createDocument({
      id,
      projectId: "p1",
      kind: "chapter",
      title: `Capítulo ${ordinal + 1}`,
      outlineNodeId: node.id,
      now,
    }),
  );
  const version = documents.appendVersion("p1", id, {
    id: `${id}-v1`,
    content,
    source: "test",
    expectedCurrentVersionId: null,
    now,
  });
  return { node, document, version };
}

function passages(documentId: string) {
  return retrieval
    .listSegments("p1", {
      sourceTypes: [DOCUMENT_PASSAGE_SOURCE],
      documentId,
    })
    .sort(
      (left, right) =>
        Number(left.metadata.passageIndex) -
        Number(right.metadata.passageIndex),
    );
}

describe("SqliteManuscriptIndexer", () => {
  it("indexes a chapter as passages linked to the entities they name", () => {
    const { version } = chapter(
      "c1",
      0,
      `${longScene("Um")}\n\n* * *\n\nTomás acendeu a lanterna verde.`,
    );
    const result = indexer.indexDocument({
      projectId: "p1",
      documentId: "c1",
      settlementEntityIds: ["tomas", "missing-entity"],
      now,
    });
    const stored = passages("c1");
    expect(result.passages.length).toBe(stored.length);
    expect(stored.length).toBeGreaterThan(1);
    expect(stored.every((segment) => segment.authority === "confirmed")).toBe(
      true,
    );
    expect(stored[0]!.metadata).toMatchObject({
      documentId: "c1",
      documentVersionId: version.id,
      outlineNodeId: "node-c1",
      passageIndex: 0,
      passageCount: stored.length,
    });
    // Named entities get full weight; settlement entities a reduced link.
    expect(stored[0]!.entityIds).toEqual(["helena", "tomas"]);
    const last = stored[stored.length - 1]!;
    expect(last.content).toBe("Tomás acendeu a lanterna verde.");
    expect(last.entityIds).toEqual(["tomas"]);
    expect(
      retrieval.search("p1", "", { entityIds: ["tomas"], limit: 1 })[0]
        ?.content,
    ).toBe("Tomás acendeu a lanterna verde.");
  });

  it("keeps vectors of unchanged passages when a chapter is edited", () => {
    chapter("c1", 0, `${longScene("Um")}\n\n* * *\n\n${longScene("Dois")}`);
    const first = indexer.indexDocument({
      projectId: "p1",
      documentId: "c1",
      now,
    });
    for (const passage of first.passages)
      retrieval.upsertEmbedding({
        segmentId: passage.segmentId,
        model: "test-embedding",
        embedding: [1, 0, 0],
        updatedAt: now,
      });
    documents.appendVersion("p1", "c1", {
      id: "c1-v2",
      content: `${longScene("Um")}\n\n* * *\n\n${longScene("Dois")} Fim novo.`,
      source: "test",
      now: later,
    });
    const second = indexer.indexDocument({
      projectId: "p1",
      documentId: "c1",
      now: later,
    });
    const kept = new Set(first.passages.map((passage) => passage.segmentId));
    const unchanged = second.passages.filter((passage) =>
      kept.has(passage.segmentId),
    );
    const changed = second.passages.filter(
      (passage) => !kept.has(passage.segmentId),
    );
    expect(unchanged.length).toBeGreaterThan(0);
    expect(changed.length).toBeGreaterThan(0);
    expect(second.removed).toBe(first.passages.length - unchanged.length);
    const embedded = retrieval.embeddedSegmentIds(
      second.passages,
      "test-embedding",
    );
    expect([...embedded].sort()).toEqual(
      unchanged.map((passage) => passage.segmentId).sort(),
    );
    expect(
      retrieval
        .listSegmentsMissingEmbedding("p1", "test-embedding", 100)
        .map((segment) => segment.segmentId)
        .sort(),
    ).toEqual(changed.map((passage) => passage.segmentId).sort());
    expect(
      passages("c1").every(
        (segment) => segment.metadata.documentVersionId === "c1-v2",
      ),
    ).toBe(true);
  });

  it("syncs legacy whole-chapter segments, edits and orphans in one pass", () => {
    chapter("c1", 0, longScene("Um"));
    chapter("c2", 1, longScene("Dois"));
    chapter("c3", 2, "   ");
    retrieval.upsertSegment({
      id: "document:c1:current",
      projectId: "p1",
      sourceType: LEGACY_DOCUMENT_SOURCE,
      sourceId: "c1",
      title: "Capítulo 1",
      content: longScene("Um"),
      authority: "confirmed",
      metadata: { documentId: "c1", documentVersionId: "c1-v1" },
      entityIds: [],
      createdAt: now,
      updatedAt: now,
    });
    retrieval.upsertSegment({
      id: "document:gone:current",
      projectId: "p1",
      sourceType: LEGACY_DOCUMENT_SOURCE,
      sourceId: "gone",
      title: "Apagado",
      content: "Texto de um documento que não existe mais.",
      authority: "confirmed",
      metadata: { documentId: "gone" },
      entityIds: [],
      createdAt: now,
      updatedAt: now,
    });
    expect(indexer.status("p1")).toMatchObject({
      documents: 3,
      indexedDocuments: 1,
      passages: 0,
      legacySegments: 2,
    });

    expect(indexer.syncProject("p1", later)).toEqual({
      indexed: 2,
      relinked: 0,
      removed: 2,
    });
    expect(
      retrieval.listSegments("p1", { sourceTypes: [LEGACY_DOCUMENT_SOURCE] }),
    ).toEqual([]);
    expect(passages("c1").length).toBeGreaterThan(0);
    expect(passages("c2").length).toBeGreaterThan(0);
    expect(passages("c3")).toEqual([]);
    expect(indexer.status("p1")).toMatchObject({
      documents: 3,
      indexedDocuments: 3,
      legacySegments: 0,
    });
    // Nothing changed: a second sync is a no-op.
    expect(indexer.syncProject("p1", later)).toEqual({
      indexed: 0,
      relinked: 0,
      removed: 0,
    });
  });

  it("relinks entities after canon changes and re-chunks renamed chapters", () => {
    chapter("c1", 0, "Marta serviu o café na taberna.");
    indexer.syncProject("p1", now);
    expect(passages("c1")[0]!.entityIds).toEqual([]);
    canon.insertEntity(
      createCanonEntity({
        id: "marta",
        projectId: "p1",
        type: "character",
        name: "Marta",
        now: later,
      }),
    );
    expect(indexer.syncProject("p1", later)).toMatchObject({ relinked: 1 });
    expect(passages("c1")[0]!.entityIds).toEqual(["marta"]);

    const document = documents.get("p1", "c1")!;
    database.raw
      .prepare("UPDATE documents SET title = ? WHERE id = ?")
      .run("A Taberna", document.id);
    expect(indexer.syncProject("p1", later)).toMatchObject({ indexed: 1 });
    expect(passages("c1")[0]!.title).toBe("A Taberna");
  });

  it("keeps archived chapters out of search and drops their index on sync", () => {
    const { document } = chapter("c1", 0, "A lanterna verde piscou na torre.");
    indexer.syncProject("p1", now);
    expect(retrieval.search("p1", "lanterna verde")).toHaveLength(1);
    documents.setArchived("p1", "c1", true, document.updatedAt, later);
    expect(retrieval.search("p1", "lanterna verde")).toEqual([]);
    expect(indexer.status("p1").documents).toBe(0);
  });

  it("removes the index of a document that lost its version or outline node", () => {
    chapter("c1", 0, "A lanterna verde piscou na torre.");
    indexer.syncProject("p1", now);
    database.raw
      .prepare("UPDATE documents SET outline_node_id = NULL WHERE id = 'c1'")
      .run();
    expect(indexer.syncProject("p1", later).removed).toBe(1);
    expect(passages("c1")).toEqual([]);
  });
});
