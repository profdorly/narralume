import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createProject } from "@lapis/domain";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { SqliteRetrievalRepository, type Migration } from "../src/index.js";
import { NodeNarrativeDatabase } from "../src/node.js";
import { insertLegacyProject } from "./insert-legacy-project.js";

const now = "2026-10-01T00:00:00.000Z";
const databases: NodeNarrativeDatabase[] = [];
let legacyMigrations: Migration[] = [];

beforeAll(async () => {
  const directory = fileURLToPath(
    new URL("../src/migrations/", import.meta.url),
  );
  const modules = await Promise.all(
    readdirSync(directory)
      .filter((name) => /^\d{3}-.+\.ts$/u.test(name))
      .map(
        (name) =>
          import(`${directory}${name}`) as Promise<Record<string, Migration>>,
      ),
  );
  legacyMigrations = modules
    .flatMap((module) => Object.values(module))
    .filter((migration) => migration.version < 50)
    .sort((left, right) => left.version - right.version);
});

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe("migration 050 (binary-segment-vectors)", () => {
  it("converts JSON vectors to Float32 BLOBs and search still finds them", () => {
    const database = new NodeNarrativeDatabase();
    databases.push(database);
    expect(database.migrate(legacyMigrations)).toBe(49);
    insertLegacyProject(
      database,
      createProject({ id: "p1", title: "O Correio das Marés", now }),
    );
    const segments = [
      { id: "near", content: "Inês ergue a carta contra a lamparina." },
      { id: "far", content: "A maré sobe sobre o cais de pedra." },
      { id: "bad", content: "Um vetor gravado com defeito." },
    ];
    const insertSegment = database.raw.prepare(
      `INSERT INTO text_segments(
         id, project_id, source_type, source_id, title, content, authority,
         metadata_json, created_at, updated_at
       ) VALUES (?, 'p1', 'note', ?, '', ?, 'reference', '{}', ?, ?)`,
    );
    for (const segment of segments)
      insertSegment.run(segment.id, segment.id, segment.content, now, now);
    // Vectors written the way version 49 stored them: unit length, as JSON.
    const insertVector = database.raw.prepare(
      `INSERT INTO segment_embeddings(
         segment_id, model, dimensions, embedding_json, content_hash, updated_at
       ) VALUES (?, 'test-embedding', ?, ?, 'hash', ?)`,
    );
    insertVector.run("near", 3, JSON.stringify([0.6, 0.8, 0]), now);
    insertVector.run("far", 3, JSON.stringify([0, 0, 1]), now);
    insertVector.run("bad", 3, JSON.stringify(["x"]), now);

    expect(database.migrate()).toBe(50);
    expect(database.migrate()).toBe(50);

    const tables = database.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'segment_%'",
      )
      .all() as { name: string }[];
    expect(tables.map(({ name }) => name)).toContain("segment_vectors");
    expect(tables.map(({ name }) => name)).not.toContain("segment_embeddings");
    const stored = database.raw
      .prepare(
        "SELECT segment_id, dimensions, length(vector) AS bytes FROM segment_vectors ORDER BY segment_id",
      )
      .all();
    // The malformed vector is dropped and will be embedded again.
    expect(stored).toEqual([
      { segment_id: "far", dimensions: 3, bytes: 12 },
      { segment_id: "near", dimensions: 3, bytes: 12 },
    ]);

    const hits = new SqliteRetrievalRepository(database).search("p1", "", {
      queryEmbedding: [0.6, 0.8, 0],
      embeddingModel: "test-embedding",
    });
    expect(hits[0]).toMatchObject({ id: "near", reasons: ["vector"] });
    expect(hits[0]!.vectorScore).toBeCloseTo(1, 5);
    expect(hits.map(({ id }) => id)).not.toContain("bad");
  });

  it("keeps the vectors of a project in the recycle bin", () => {
    // Regression: the write guards on segment_vectors refused these rows and
    // rolled the whole migration back, so such a library could not open.
    const database = new NodeNarrativeDatabase();
    databases.push(database);
    database.migrate(legacyMigrations);
    insertLegacyProject(
      database,
      createProject({ id: "trashed", title: "Na lixeira", now }),
    );
    database.raw
      .prepare(
        `INSERT INTO text_segments(
           id, project_id, source_type, source_id, title, content, authority,
           metadata_json, created_at, updated_at
         ) VALUES ('seg', 'trashed', 'note', 'seg', '', 'texto', 'reference', '{}', ?, ?)`,
      )
      .run(now, now);
    database.raw
      .prepare(
        `INSERT INTO segment_embeddings(
           segment_id, model, dimensions, embedding_json, content_hash, updated_at
         ) VALUES ('seg', 'test-embedding', 2, '[1,0]', 'hash', ?)`,
      )
      .run(now);
    database.raw
      .prepare("UPDATE projects SET deleted_at = ? WHERE id = 'trashed'")
      .run(now);

    expect(database.migrate()).toBe(50);
    expect(
      database.raw
        .prepare(
          "SELECT segment_id, length(vector) AS bytes FROM segment_vectors",
        )
        .all(),
    ).toEqual([{ segment_id: "seg", bytes: 8 }]);
    // The guards are back: new writes for the trashed project are refused.
    expect(() =>
      database.raw
        .prepare(
          `UPDATE segment_vectors SET updated_at = ? WHERE segment_id = 'seg'`,
        )
        .run(now),
    ).toThrow("project.not_found");
  });
});
