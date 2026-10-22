/**
 * pt-BR is the default writing language. Existing zh-CN (and any unknown
 * value) becomes pt-BR. Project form distinguishes short story / novella /
 * novel so recipes can stay light for short fiction.
 *
 * Prompt templates stored as bilingual JSON rename the zh-CN key to pt-BR
 * without rewriting the Chinese payload; later seeds replace official copy.
 */
export const migration048 = {
  version: 48,
  name: "language-and-form",
  sql: `
    ALTER TABLE projects ADD COLUMN form TEXT NOT NULL DEFAULT 'novel'
      CHECK (form IN ('short-story','novella','novel'));

    UPDATE projects
       SET language = 'pt-BR'
     WHERE language IS NULL
        OR trim(language) = ''
        OR language = 'pt-BR'
        OR language NOT IN ('pt-BR', 'en');

    UPDATE harness_templates
       SET default_content = json_insert(
             json_remove(default_content, '$."zh-CN"'),
             '$."pt-BR"',
             json_extract(default_content, '$."zh-CN"')
           )
     WHERE json_valid(default_content)
       AND json_extract(default_content, '$."zh-CN"') IS NOT NULL;

    UPDATE harness_templates
       SET override_content = json_insert(
             json_remove(override_content, '$."zh-CN"'),
             '$."pt-BR"',
             json_extract(override_content, '$."zh-CN"')
           )
     WHERE override_content IS NOT NULL
       AND json_valid(override_content)
       AND json_extract(override_content, '$."zh-CN"') IS NOT NULL;
  `,
} as const;
