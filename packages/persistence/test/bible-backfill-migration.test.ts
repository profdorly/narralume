import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createDocument,
  createOutlineNode,
  createProject,
} from "@narralume/domain";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  SqliteBibleBackfillRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
  type Migration,
} from "../src/index.js";
import { insertLegacyProject } from "./insert-legacy-project.js";
import { NodeNarrativeDatabase } from "../src/node.js";

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
    .filter((migration) => migration.version < 46)
    .sort((left, right) => left.version - right.version);
});

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

describe("migration 046 (bible-backfill)", () => {
  it("upgrades a version-45 library without touching existing chapters", () => {
    const database = new NodeNarrativeDatabase();
    databases.push(database);
    expect(legacyMigrations).toHaveLength(45);
    expect(database.migrate(legacyMigrations)).toBe(45);
    seedBook(database);

    expect(database.migrate()).toBe(48);
    expect(database.migrate()).toBe(48);

    const documents = new SqliteDocumentRepository(database);
    expect(documents.get("p1", "doc-1")).toMatchObject({
      outlineNodeId: "chapter-1",
      currentVersionId: "version-1",
    });
    const tables = database.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table','index','trigger') AND name LIKE '%backfill%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "bible_backfill_jobs",
        "bible_backfill_items",
        "bible_backfill_jobs_one_active_idx",
        "bible-backfill-jobs-project-write-guard-update",
        "bible-backfill-items-project-write-guard-update",
      ]),
    );
    expect(database.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("allows one unfinished job per project and enforces item invariants", () => {
    const { database, backfills } = setup();
    const job = backfills.createJob({
      id: "job-1",
      projectId: "p1",
      mode: "review_each",
      requestHash: "hash-1",
      items: [
        {
          outlineNodeId: "chapter-1",
          documentId: "doc-1",
          versionId: "version-1",
          skipReason: null,
        },
        {
          outlineNodeId: "chapter-2",
          documentId: "doc-2",
          versionId: "version-2",
          skipReason: "already_settled",
        },
      ],
      now,
    });
    expect(job).toMatchObject({ status: "running", version: 0 });
    expect(backfills.listItems("job-1")).toEqual([
      expect.objectContaining({ ordinal: 0, status: "pending" }),
      expect.objectContaining({
        ordinal: 1,
        status: "skipped",
        skipReason: "already_settled",
      }),
    ]);
    expect(() =>
      backfills.createJob({
        id: "job-2",
        projectId: "p1",
        mode: "auto_apply_stop_on_conflict",
        requestHash: "hash-2",
        items: [
          {
            outlineNodeId: "chapter-1",
            documentId: "doc-1",
            versionId: "version-1",
            skipReason: null,
          },
        ],
        now,
      }),
    ).toThrow(/UNIQUE/u);
    expect(backfills.findActiveJob("p1")?.id).toBe("job-1");
    expect(backfills.listActionableJobs().map(({ id }) => id)).toEqual([
      "job-1",
    ]);

    expect(() =>
      database.raw
        .prepare(
          "UPDATE bible_backfill_items SET status = 'skipped' WHERE job_id = 'job-1' AND ordinal = 0",
        )
        .run(),
    ).toThrow(/CHECK/u);
    expect(() =>
      database.raw
        .prepare(
          "UPDATE bible_backfill_jobs SET status = 'sleeping' WHERE id = 'job-1'",
        )
        .run(),
    ).toThrow(/CHECK/u);
    // Jobs end only as completed or cancelled; failures park in awaiting_user.
    expect(() =>
      database.raw
        .prepare(
          "UPDATE bible_backfill_jobs SET status = 'failed' WHERE id = 'job-1'",
        )
        .run(),
    ).toThrow(/CHECK/u);

    backfills.requestControl("job-1", "pause", later);
    expect(backfills.setJobStatus("job-1", "paused", later)).toMatchObject({
      status: "paused",
      pauseRequested: false,
    });
    expect(backfills.listActionableJobs()).toEqual([]);
    backfills.requestControl("job-1", "cancel", later);
    expect(backfills.listActionableJobs().map(({ id }) => id)).toEqual([
      "job-1",
    ]);
    expect(backfills.setJobStatus("job-1", "cancelled", later)).toMatchObject({
      status: "cancelled",
      cancelRequested: false,
    });

    // A finished job frees the slot; an all-skipped job completes on creation.
    expect(
      backfills.createJob({
        id: "job-3",
        projectId: "p1",
        mode: "review_each",
        requestHash: "hash-3",
        items: [
          {
            outlineNodeId: "chapter-1",
            documentId: "doc-1",
            versionId: "version-1",
            skipReason: "already_settled",
          },
        ],
        now: later,
      }).status,
    ).toBe("completed");
    expect(backfills.findActiveJob("p1")).toBeNull();
    expect(backfills.findCurrentJob("p1")?.id).toBe("job-3");
  });

  it("blocks writes after recycle and cascades on purge", () => {
    const { database, backfills } = setup();
    backfills.createJob({
      id: "job-1",
      projectId: "p1",
      mode: "review_each",
      requestHash: "hash-1",
      items: [
        {
          outlineNodeId: "chapter-1",
          documentId: "doc-1",
          versionId: "version-1",
          skipReason: null,
        },
      ],
      now,
    });
    const projects = new SqliteProjectRepository(database);
    const project = projects.get("p1")!;
    expect(backfills.cancelActiveJobs("p1", later)).toBe(1);
    const recycled = projects.softDelete("p1", project.updatedAt, later);
    expect(() =>
      backfills.updateItem("job-1", 0, { status: "failed" }, later),
    ).toThrowError(/project\.not_found/u);
    expect(() =>
      backfills.setJobStatus("job-1", "running", later),
    ).toThrowError(/project\.not_found/u);
    expect(backfills.listActionableJobs()).toEqual([]);

    expect(projects.purge("p1", recycled.deletionToken!)).toBe(true);
    for (const table of ["bible_backfill_jobs", "bible_backfill_items"]) {
      expect(
        database.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    }
    expect(database.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

function setup() {
  const database = new NodeNarrativeDatabase();
  databases.push(database);
  database.migrate();
  seedBook(database);
  return { database, backfills: new SqliteBibleBackfillRepository(database) };
}

function seedBook(database: NodeNarrativeDatabase): void {
  insertLegacyProject(
    database,
    createProject({ id: "p1", title: "雾港", now }),
  );
  const story = new SqliteStoryRepository(database);
  const book = story.insertOutlineNode(
    createOutlineNode({
      id: "book",
      projectId: "p1",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "雾港",
      now,
    }),
  );
  const documents = new SqliteDocumentRepository(database);
  for (const index of [1, 2]) {
    story.insertOutlineNode(
      createOutlineNode({
        id: `chapter-${index}`,
        projectId: "p1",
        parent: book,
        kind: "chapter",
        ordinal: index - 1,
        title: `第${index}章`,
        now,
      }),
    );
    documents.insert(
      createDocument({
        id: `doc-${index}`,
        projectId: "p1",
        kind: "chapter",
        title: `第${index}章`,
        outlineNodeId: `chapter-${index}`,
        now,
      }),
    );
    documents.appendVersion("p1", `doc-${index}`, {
      id: `version-${index}`,
      content: `第${index}章正文。`,
      source: "import:batch",
      expectedCurrentVersionId: null,
      now,
    });
  }
}
