import type { ProjectLanguage } from "@narralume/contracts";

/** AI instructions and output follow project.language, not the UI locale.
 *  Unknown values fall back to Brazilian Portuguese. */
export function promptLanguageOf(
  language: string | null | undefined,
): ProjectLanguage {
  return language === "en" ? "en" : "pt-BR";
}

/** Pick a bilingual instruction table and join as system instructions. */
export function instructionsFor(
  language: string | null | undefined,
  table: Record<ProjectLanguage, readonly string[]>,
): string {
  return table[promptLanguageOf(language)].join("\n");
}

/** Parse template content: bilingual JSON `{"pt-BR": "...", "en": "..."}`;
 *  plain text is treated as Portuguese. */
export function editableInstructionOf(
  content: string,
  language: ProjectLanguage,
): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const text =
      parsed[language] ?? (language === "pt-BR" ? parsed["pt-BR"] : undefined);
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return language === "en" ? null : trimmed;
  }
}

/** Work craft layer: effective chapter-draft instructions (override ?? official default). */
export function workCraftLayer(options: {
  language: ProjectLanguage;
  templateContent: string | null;
  fallback: Record<ProjectLanguage, string>;
}): string {
  const { language, templateContent, fallback } = options;
  const authored =
    templateContent === null
      ? null
      : editableInstructionOf(templateContent, language);
  return (authored ?? fallback[language]).trim();
}

/** Replace-style instruction assembly: template content replaces the default
 *  craft layer; optional craft is the work writing method; invariants always
 *  come from code. */
export function authoredInstructions(options: {
  language: ProjectLanguage;
  templateContent: string | null;
  fallback: Record<ProjectLanguage, string>;
  invariants: Record<ProjectLanguage, string>;
  craft?: string | null;
}): string {
  const { language, templateContent, fallback, invariants, craft } = options;
  const authored =
    templateContent === null
      ? null
      : editableInstructionOf(templateContent, language);
  const craftBlock =
    craft && craft.trim()
      ? `<writing-craft>\n${craft.trim()}\n</writing-craft>`
      : null;
  return [authored ?? fallback[language], craftBlock, invariants[language]]
    .filter((part) => part !== null && part.trim().length > 0)
    .join("\n");
}
