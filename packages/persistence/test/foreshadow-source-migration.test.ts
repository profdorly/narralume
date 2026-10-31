import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createProject } from "@lapis/domain";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
  type Migration,
} from "../src/index.js";
import { NodeNarrativeDatabase } from "../src/node.js";
import { insertLegacyProject } from "./insert-legacy-project.js";

const now = "2026-09-01T00:00:00.000Z";
const later = "2026-09-01T00:05:00.000Z";
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
    .filter((migration) => migration.version < 47)
    .sort((left, right) => left.version - right.version);
});

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

function repositories(database: NodeNarrativeDatabase) {
  const canon = new SqliteCanonRepository(database);
  const story = new SqliteStoryRepository(database);
  return new SqliteNarrativeStateRepository(database, canon, story);
}

describe("migration 047 (foreshadow-source)", () => {
  it("upgrades a version-46 library, keeping existing foreshadows without a source", () => {
    const database = new NodeNarrativeDatabase();
    databases.push(database);
    expect(legacyMigrations).toHaveLength(46);
    expect(database.migrate(legacyMigrations)).toBe(46);
    insertLegacyProject(
      database,
      createProject({ id: "p1", title: "Vila do Sal", now }),
    );
    database.raw
      .prepare(
        `INSERT INTO foreshadows(
           id, project_id, title, description, status, importance, created_at, updated_at
         ) VALUES ('legacy', 'p1', 'A carta em branco', 'Ninguém a reclamou.', 'planted', 3, ?, ?)`,
      )
      .run(now, now);

    expect(database.migrate()).toBe(49);
    expect(database.migrate()).toBe(49);

    const state = repositories(database);
    expect(state.listForeshadows("p1")).toEqual([
      expect.objectContaining({
        id: "legacy",
        title: "A carta em branco",
        status: "planted",
        sourceId: null,
      }),
    ]);
    expect(database.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("stores a foreshadow's source once and keeps it through updates", () => {
    const database = new NodeNarrativeDatabase();
    databases.push(database);
    database.migrate();
    new SqliteProjectRepository(database).insert(
      createProject({ id: "p1", title: "Vila do Sal", now }),
    );
    const state = repositories(database);
    const created = state.insertForeshadow({
      id: "imported",
      projectId: "p1",
      title: "A carta em branco",
      description: "Ninguém a reclamou.",
      status: "planted",
      importance: 3,
      targetFromNodeId: null,
      targetToNodeId: null,
      dependencies: [],
      evidenceNodeIds: [],
      resolutionNodeId: null,
      sourceId: "import-candidate-7",
      createdAt: now,
      updatedAt: now,
    });
    expect(state.listForeshadows("p1")[0]).toEqual(created);

    const updated = state.updateForeshadow({
      ...created,
      status: "developing",
      sourceId: null,
      updatedAt: later,
    });
    expect(updated.sourceId).toBe("import-candidate-7");
    expect(state.listForeshadows("p1")[0]).toMatchObject({
      status: "developing",
      sourceId: "import-candidate-7",
    });

    expect(() =>
      database.raw
        .prepare(
          `INSERT INTO foreshadows(
             id, project_id, title, description, status, importance, source_id, created_at, updated_at
           ) VALUES ('blank', 'p1', 'x', 'x', 'planted', 3, '', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/CHECK constraint failed/u);
  });
});
