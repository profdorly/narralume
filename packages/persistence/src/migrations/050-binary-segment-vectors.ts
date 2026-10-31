import type { SqliteRawDatabase } from "../driver.js";
import { encodeVector } from "../vector.js";

const guard = (operation: "insert" | "update") => `
  CREATE TRIGGER "segment-vectors-project-write-guard-${operation}"
  BEFORE ${operation.toUpperCase()} ON "segment_vectors"
  BEGIN
    SELECT RAISE(ABORT, 'project.not_found') WHERE EXISTS (
      SELECT 1 FROM text_segments segment
      JOIN projects project ON project.id = segment.project_id
      WHERE segment.id = NEW.segment_id AND project.deleted_at IS NOT NULL
    );
  END;`;

/**
 * Retrieval vectors move from JSON text (segment_embeddings.embedding_json,
 * about 30 kB for 1,536 dimensions) to little-endian Float32 BLOBs (6 kB),
 * which search reads without JSON parsing. Every stored vector is converted;
 * none has to be fetched from the embedding model again.
 */
export const migration050 = {
  version: 50,
  name: "binary-segment-vectors",
  sql: `
    CREATE TABLE segment_vectors (
      segment_id TEXT PRIMARY KEY REFERENCES text_segments(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      vector BLOB NOT NULL CHECK (length(vector) = dimensions * 4),
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    ${guard("insert")}
    ${guard("update")}
  `,
  transform(raw: SqliteRawDatabase) {
    // The write guards refuse rows of projects in the recycle bin, but their
    // vectors must be kept for a restore. Drop the guards for the copy and
    // recreate them; `sql` (and its checksum) stays as shipped.
    raw.exec(`
      DROP TRIGGER "segment-vectors-project-write-guard-insert";
      DROP TRIGGER "segment-vectors-project-write-guard-update";
    `);
    const rows = raw
      .prepare(
        `SELECT segment_id, model, embedding_json, content_hash, updated_at
         FROM segment_embeddings`,
      )
      .all() as {
      segment_id: string;
      model: string;
      embedding_json: string;
      content_hash: string;
      updated_at: string;
    }[];
    const insert = raw.prepare(
      `INSERT INTO segment_vectors(
         segment_id, model, dimensions, vector, content_hash, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const parsed = JSON.parse(row.embedding_json) as unknown;
      const values = Array.isArray(parsed)
        ? parsed.filter((value): value is number => Number.isFinite(value))
        : [];
      // A malformed vector is dropped; the next AI task embeds it again.
      if (values.length === 0) continue;
      insert.run(
        row.segment_id,
        row.model,
        values.length,
        encodeVector(values),
        row.content_hash,
        row.updated_at,
      );
    }
    raw.exec(`${guard("insert")}\n${guard("update")}`);
    raw.exec("DROP TABLE segment_embeddings;");
  },
};
