import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createProject } from "@narralume/domain";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  SqliteBibleBackfillRepository,
  SqliteProjectRepository,
  type Migration,
} from "../src/index.js";
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
    .filter((migration) => migration.version < 48)
    .sort((left, right) => left.version - right.version);
});

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
});

function legacyJob(
  database: NodeNarrativeDatabase,
  id: string,
  status: string,
): void {
  database.raw
    .prepare(
      `INSERT INTO bible_backfill_jobs(
         id, project_id, status, mode, request_hash, error_json,
         pause_requested, cancel_requested, created_at, updated_at, version
       ) VALUES (?, 'p1', ?, 'review_each', 'hash', NULL, 0, 0, ?, ?, 0)`,
    )
    .run(id, status, now, now);
}

describe("migration 048 (bible-backfill-sections)", () => {
  it("upgrades a version-47 library: existing jobs have no sections, finished ones are done", () => {
    const database = new NodeNarrativeDatabase();
    databases.push(database);
    expect(legacyMigrations).toHaveLength(47);
    expect(database.migrate(legacyMigrations)).toBe(47);
    new SqliteProjectRepository(database).insert(
      createProject({ id: "p1", title: "Vila do Sal", now }),
    );
    legacyJob(database, "finished", "completed");
    legacyJob(database, "cancelled", "cancelled");
    legacyJob(database, "active", "running");

    expect(database.migrate()).toBe(48);
    expect(database.migrate()).toBe(48);

    const backfills = new SqliteBibleBackfillRepository(database);
    expect(backfills.requireJob("finished")).toMatchObject({
      status: "completed",
      phase: "done",
      rereadSettled: false,
    });
    expect(backfills.requireJob("cancelled")).toMatchObject({
      phase: "done",
    });
    // An unfinished job keeps settling chapters and then completes as before.
    expect(backfills.requireJob("active")).toMatchObject({
      status: "running",
      phase: "chapters",
      rereadSettled: false,
    });
    for (const id of ["finished", "cancelled", "active"]) {
      expect(backfills.listSections(id)).toEqual([]);
    }
    expect(database.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("stores a section plan and enforces its invariants", () => {
    const database = new NodeNarrativeDatabase();
    databases.push(database);
    database.migrate();
    const projects = new SqliteProjectRepository(database);
    projects.insert(createProject({ id: "p1", title: "Vila do Sal", now }));
    const backfills = new SqliteBibleBackfillRepository(database);
    // Nothing to settle but sections to generate: the job runs.
    const job = backfills.createJob({
      id: "job-1",
      projectId: "p1",
      mode: "auto_apply_stop_on_conflict",
      requestHash: "hash-1",
      items: [
        {
          outlineNodeId: "chapter-1",
          documentId: "doc-1",
          versionId: "version-1",
          skipReason: "already_settled",
        },
      ],
      sections: ["intent", "entities"],
      rereadSettled: true,
      now,
    });
    expect(job).toMatchObject({
      status: "running",
      phase: "chapters",
      rereadSettled: true,
    });
    expect(backfills.listSections("job-1")).toEqual([
      expect.objectContaining({
        ordinal: 0,
        spread: "intent",
        status: "pending",
        attempt: 0,
        pendingItems: [],
      }),
      expect.objectContaining({ ordinal: 1, spread: "entities" }),
    ]);
    const updated = backfills.updateSection(
      "job-1",
      1,
      {
        status: "partially_applied",
        appliedCount: 2,
        pendingCount: 1,
        pendingItems: [{ itemId: "item-3", reason: "author_record" }],
      },
      later,
    );
    expect(updated).toMatchObject({
      status: "partially_applied",
      appliedCount: 2,
      pendingItems: [{ itemId: "item-3", reason: "author_record" }],
      updatedAt: later,
    });
    expect(backfills.setJobPhase("job-1", "sections", later).phase).toBe(
      "sections",
    );
    expect(() =>
      database.raw
        .prepare(
          "UPDATE bible_backfill_sections SET status = 'done' WHERE job_id = 'job-1'",
        )
        .run(),
    ).toThrow(/CHECK/u);
    expect(() =>
      database.raw
        .prepare(
          "INSERT INTO bible_backfill_sections(job_id, ordinal, spread, status, updated_at) VALUES ('job-1', 2, 'intent', 'pending', ?)",
        )
        .run(now),
    ).toThrow(/UNIQUE/u);
    expect(
      backfills.setJobStatus("job-1", "completed", later).phase,
    ).toBe("done");

    // Recycling blocks section writes; purging cascades.
    const recycled = projects.softDelete(
      "p1",
      projects.get("p1")!.updatedAt,
      later,
    );
    expect(() =>
      backfills.updateSection("job-1", 0, { status: "failed" }, later),
    ).toThrowError(/project\.not_found/u);
    expect(projects.purge("p1", recycled.deletionToken!)).toBe(true);
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM bible_backfill_sections")
        .get(),
    ).toEqual({ count: 0 });
  });
});
