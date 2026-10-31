import { describe, expect, it } from "vitest";
import { NodeNarrativeDatabase } from "../src/node.js";

import { migration036 } from "../src/migrations/036-drop-empty-manuscript-documents.js";

/* migration 036: removes the empty "full manuscript" documents created
   automatically in the book-setup era and never given a version; manuscripts
   with version history (imported or written by hand) and other kinds are not
   affected. */

describe("migration 036 (drop-empty-manuscript-documents)", () => {
  it("deletes version-less manuscript documents and keeps everything else", () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    const now = "2026-08-16T00:00:00.000Z";
    const insertProject = database.raw.prepare(
      `INSERT INTO projects(id, title, subtitle, premise, language, phase, archived_at, created_at, updated_at)
       VALUES ('p-1', '样本', NULL, NULL, 'pt-BR', 'idea', NULL, ?, ?)`,
    );
    insertProject.run(now, now);
    const insertDocument = database.raw.prepare(
      `INSERT INTO documents(id, project_id, kind, title, current_version_id, created_at, updated_at)
       VALUES (?, 'p-1', ?, ?, ?, ?, ?)`,
    );
    const insertVersion = database.raw.prepare(
      `INSERT INTO document_versions(id, document_id, parent_version_id, content, content_hash, source, run_id, created_at)
       VALUES (?, ?, NULL, '潮水退去。', 'hash-1', 'manual', NULL, ?)`,
    );
    // Empty manuscript (bootstrap output): should be deleted.
    insertDocument.run("doc-empty", "manuscript", "正文总稿", null, now, now);
    // Manuscript with versions (import output): should be kept.
    insertDocument.run(
      "doc-imported",
      "manuscript",
      "导入正文",
      null,
      now,
      now,
    );
    insertVersion.run("version-1", "doc-imported", now);
    database.raw
      .prepare(
        "UPDATE documents SET current_version_id = 'version-1' WHERE id = 'doc-imported'",
      )
      .run();
    // Chapter draft without versions: different kind, should be kept.
    insertDocument.run("doc-chapter", "chapter", "第一章", null, now, now);

    database.raw.exec(migration036.sql);

    const remaining = database.raw
      .prepare("SELECT id FROM documents ORDER BY id")
      .all() as { id: string }[];
    expect(remaining.map((row) => row.id)).toEqual([
      "doc-chapter",
      "doc-imported",
    ]);
    expect(database.raw.prepare("PRAGMA foreign_key_check").all()).toHaveLength(
      0,
    );
    // Idempotent: running again neither errors nor deletes by mistake.
    database.raw.exec(migration036.sql);
    expect(
      (
        database.raw
          .prepare("SELECT COUNT(*) AS count FROM documents")
          .get() as { count: number }
      ).count,
    ).toBe(2);
  });
});
