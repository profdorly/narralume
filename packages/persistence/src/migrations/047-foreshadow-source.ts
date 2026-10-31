/**
 * Foreshadowing origin: applying an import records the import candidate ID that
 * produced it, and chapter settlement records the change set ID; foreshadowing
 * entered by the author is NULL. The automatic mode of "Fill in the story bible
 * from the manuscript" uses this to tell import-created foreshadowing from the
 * author's own. The origin of existing foreshadowing cannot be known, so it
 * stays NULL (treated as author-entered).
 */
export const migration047 = {
  version: 47,
  name: "foreshadow-source",
  sql: `
    ALTER TABLE foreshadows ADD COLUMN source_id TEXT
      CHECK (source_id IS NULL OR length(source_id) > 0);
  `,
} as const;
