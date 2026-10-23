import { foldText } from "./lexical-query.js";

export interface MentionableEntity {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

const CJK =
  /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/**
 * Deterministic entity-mention detection used to link retrieval passages to
 * canon entities without a model call. Names and aliases are compared after
 * case and diacritic folding; alphabetic names must match whole words
 * ("Ana" does not match "Ananias"), CJK names match as substrings.
 */
export function buildEntityMentionMatcher(
  entities: readonly MentionableEntity[],
): (text: string) => Map<string, number> {
  const matchers = entities
    .map((entity) => {
      const names = [
        ...new Set(
          [entity.name, ...entity.aliases]
            .map((name) => foldText(name.normalize("NFKC")).trim())
            .filter((name) => [...name].length >= 2),
        ),
      ];
      if (names.length === 0) return null;
      const cjk = names.filter((name) => CJK.test(name));
      const words = names.filter((name) => !CJK.test(name));
      const pattern =
        words.length > 0
          ? new RegExp(
              `(?<![\\p{L}\\p{N}])(?:${words
                .sort((left, right) => right.length - left.length)
                .map((name) => escapeRegExp(name).replace(/\s+/gu, "\\s+"))
                .join("|")})(?![\\p{L}\\p{N}])`,
              "gu",
            )
          : null;
      return { id: entity.id, cjk, pattern };
    })
    .filter((matcher): matcher is NonNullable<typeof matcher> =>
      Boolean(matcher),
    );
  return (text) => {
    const folded = foldText(text);
    const counts = new Map<string, number>();
    for (const matcher of matchers) {
      let count = 0;
      if (matcher.pattern) {
        matcher.pattern.lastIndex = 0;
        count += [...folded.matchAll(matcher.pattern)].length;
      }
      for (const name of matcher.cjk) count += occurrences(folded, name);
      if (count > 0) counts.set(matcher.id, count);
    }
    return counts;
  };
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
