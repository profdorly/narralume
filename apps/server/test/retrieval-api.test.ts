import { randomUUID } from "node:crypto";

import { createDocument, createOutlineNode } from "@narralume/domain";
import {
  LEGACY_DOCUMENT_SOURCE,
  SqliteDocumentRepository,
  SqliteRetrievalRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop();
    await resource?.app.close();
    resource?.database.close();
  }
});

async function setup() {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    database,
    environment: {},
    logger: false,
    config: {
      dataDirectory: ".",
      databasePath: ":memory:",
      host: "127.0.0.1",
      port: 4317,
      environment: "test",
    },
  });
  resources.push({ app, database });
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { requestId: randomUUID(), title: "O Farol", premise: null },
  });
  const projectId = (created.json() as { id: string }).id;
  const story = new SqliteStoryRepository(database);
  const root = story
    .listOutline(projectId)
    .find((node) => node.kind === "book")!;
  const now = new Date().toISOString();
  const chapter = (ordinal: number, title: string) => {
    const node = story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId,
        parent: root,
        kind: "chapter",
        ordinal,
        title,
        now,
      }),
    );
    return new SqliteDocumentRepository(database).insert(
      createDocument({
        id: randomUUID(),
        projectId,
        kind: "chapter",
        title,
        outlineNodeId: node.id,
        now,
      }),
    );
  };
  return { app, database, projectId, chapter };
}

describe("retrieval index API", () => {
  it("indexes committed chapters, searches passages and reports the index", async () => {
    const { app, database, projectId, chapter } = await setup();
    const lighthouse = chapter(0, "A Torre");
    const saltpans = chapter(1, "As Salinas");
    for (const [document, content] of [
      [lighthouse, "Era Tomás quem acendia a lanterna verde no alto do farol."],
      [saltpans, "Os botes entravam nas salinas na virada da maré."],
    ] as const) {
      const committed = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/documents/${document.id}/versions`,
        payload: { content, source: "manual", expectedCurrentVersionId: null },
      });
      expect(committed.statusCode, committed.body).toBe(201);
    }

    const status = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/retrieval/index`,
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toEqual({
      documents: 2,
      indexedDocuments: 2,
      passages: 2,
      legacySegments: 0,
      embeddedPassages: 0,
      embeddingModel: null,
      currentModelPassages: 0,
      models: [],
    });

    const search = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/retrieval/search`,
      payload: { query: "quem acende a luz verde do farol", rerank: false },
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json()[0]).toMatchObject({
      sourceType: "document_passage",
      title: "A Torre",
      metadata: { documentId: lighthouse.id },
    });

    // A whole-chapter segment from the previous index is replaced on reindex.
    new SqliteRetrievalRepository(database).upsertSegment({
      id: `document:${saltpans.id}:current`,
      projectId,
      sourceType: LEGACY_DOCUMENT_SOURCE,
      sourceId: saltpans.id,
      title: "As Salinas",
      content: "Os botes entravam nas salinas na virada da maré.",
      authority: "confirmed",
      metadata: { documentId: saltpans.id },
      entityIds: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const reindex = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/retrieval/reindex`,
    });
    expect(reindex.statusCode, reindex.body).toBe(200);
    expect(reindex.json()).toMatchObject({
      indexed: 1,
      removed: 1,
      status: { passages: 2, legacySegments: 0, indexedDocuments: 2 },
    });
  });

  it("returns 404 for the index of an unknown project", async () => {
    const { app } = await setup();
    for (const [method, url] of [
      ["GET", "/api/projects/missing/retrieval/index"],
      ["POST", "/api/projects/missing/retrieval/reindex"],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: "project.not_found" },
      });
    }
  });
});
