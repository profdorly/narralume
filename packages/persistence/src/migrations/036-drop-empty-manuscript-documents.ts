/* Creating a project no longer auto-creates an empty "full manuscript"
   document: it had no feature entry and only kept a permanent "still empty"
   warning on the delivery page. Remove existing manuscript documents that never
   had any version written; manuscripts with imported or manually created
   content (with version history) are kept. */
export const migration036 = {
  version: 36,
  name: "drop-empty-manuscript-documents",
  sql: `
    DELETE FROM documents
     WHERE kind = 'manuscript'
       AND id NOT IN (SELECT document_id FROM document_versions);
  `,
} as const;
