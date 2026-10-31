/** Lightweight (best-effort) detection of the manuscript language: only tells
 *  Portuguese, Spanish, English and Chinese apart; anything else is unknown. No
 *  external library: CJK manuscripts are judged by writing system, Latin-script
 *  manuscripts by counting high-frequency function words unique to each
 *  language. The result is only a reference line in book analysis, chapter
 *  settlement and story bible candidate prompts; the language invariant still
 *  requires the model to follow the text itself. */

import type { ProjectLanguage } from "@lapis/contracts";

export type DetectedManuscriptLanguage =
  "Portuguese" | "Spanish" | "English" | "Chinese" | "unknown";

/** Names of detected manuscript languages in Portuguese prompt copy. */
const DETECTED_LANGUAGE_NAMES_PT: Record<
  Exclude<DetectedManuscriptLanguage, "unknown">,
  string
> = {
  Portuguese: "português",
  Spanish: "espanhol",
  English: "inglês",
  Chinese: "chinês",
};

/** Prompt hint for the detected manuscript language; omit the line when unknown. */
export function manuscriptLanguageHint(
  language: ProjectLanguage,
  detected: DetectedManuscriptLanguage,
): string | null {
  if (detected === "unknown") return null;
  return language === "en"
    ? `Manuscript language (detected): ${detected}. Write the natural-language fields in this language; if the text itself is clearly in another language, follow the text.`
    : `Idioma do manuscrito (detectado): ${DETECTED_LANGUAGE_NAMES_PT[detected]}. Escreva os campos em linguagem natural nesse idioma; se o texto estiver claramente em outra língua, siga o texto.`;
}

type ScoredLanguage = "Portuguese" | "Spanish" | "English" | "French";

/**
 * Only this many characters from the start of the text are read: enough to
 * judge the language, and it makes detection cost independent of manuscript
 * length.
 */
const SAMPLE_CHARACTERS = 100_000;
/**
 * Minimum number of function-word hits needed to decide on a Latin-script
 * language.
 */
const MIN_WORD_HITS = 3;
/**
 * The leading language's hits must be at least this many times the runner-up's,
 * otherwise no conclusion is drawn.
 */
const MIN_LEAD_RATIO = 2;
/** Minimum number of Han characters needed to decide on Chinese. */
const MIN_HAN_CHARACTERS = 8;

/** High-frequency function words unique to each language (lowercase, diacritics
 *  kept). Words shared by Portuguese and Spanish (que, de, para, nada), and by
 *  Spanish and French (la, le, un, en, etc.) are not listed; if a word still
 *  appears in several tables, it is removed when the map is built. French only
 *  absorbs hits from French manuscripts: when it leads, the result is unknown.
 */
const FUNCTION_WORDS: Record<ScoredLanguage, readonly string[]> = {
  Portuguese: [
    "não",
    "e",
    "um",
    "uma",
    "com",
    "em",
    "na",
    "do",
    "das",
    "ao",
    "aos",
    "à",
    "às",
    "é",
    "ele",
    "ela",
    "eles",
    "elas",
    "você",
    "isso",
    "isto",
    "também",
    "muito",
    "muita",
    "mais",
    "foi",
    "tem",
    "seu",
    "sua",
    "seus",
    "suas",
    "então",
    "já",
    "há",
    "eu",
    "meu",
    "minha",
    "estava",
    "tinha",
    "ainda",
    "sem",
    "aqui",
    "agora",
    "quando",
    "onde",
    "depois",
    "pela",
    "pelo",
    "num",
    "numa",
    "dele",
    "dela",
    "só",
    "até",
    "lhe",
    "coisa",
  ],
  Spanish: [
    "el",
    "los",
    "las",
    "del",
    "y",
    "con",
    "es",
    "una",
    "pero",
    "muy",
    "su",
    "sus",
    "lo",
    "al",
    "más",
    "yo",
    "ella",
    "ellos",
    "ellas",
    "él",
    "fue",
    "había",
    "estaba",
    "hay",
    "sí",
    "ahora",
    "aquí",
    "entonces",
    "cuando",
    "donde",
    "dónde",
    "sin",
    "ya",
    "hasta",
    "usted",
    "nosotros",
    "qué",
    "también",
    "después",
    "tenía",
    "eso",
    "esto",
    "mucho",
    "cosa",
    "hacia",
  ],
  English: [
    "the",
    "and",
    "of",
    "to",
    "in",
    "is",
    "was",
    "were",
    "he",
    "she",
    "it",
    "that",
    "with",
    "for",
    "his",
    "her",
    "him",
    "you",
    "i",
    "my",
    "we",
    "had",
    "not",
    "but",
    "they",
    "at",
    "on",
    "be",
    "have",
    "this",
    "from",
    "would",
    "there",
    "what",
    "said",
    "an",
    // Same form as Portuguese "do" (de + o); listed in both tables and removed
    // as a shared word when the map is built.
    "do",
  ],
  French: [
    "et",
    "est",
    "une",
    "des",
    "du",
    "au",
    "aux",
    "il",
    "ils",
    "elle",
    "je",
    "pas",
    "ne",
    "qui",
    "dans",
    "sur",
    "avec",
    "pour",
    "nous",
    "vous",
    "était",
    "avait",
    "cette",
    "sa",
    "ses",
  ],
};

/**
 * Function word → language; words that appear in several languages are not
 * counted.
 */
const WORD_LANGUAGE: ReadonlyMap<string, ScoredLanguage> = (() => {
  const owners = new Map<string, Set<ScoredLanguage>>();
  for (const language of Object.keys(FUNCTION_WORDS) as ScoredLanguage[])
    for (const word of FUNCTION_WORDS[language]) {
      const set = owners.get(word) ?? new Set<ScoredLanguage>();
      set.add(language);
      owners.set(word, set);
    }
  const result = new Map<string, ScoredLanguage>();
  for (const [word, languages] of owners)
    if (languages.size === 1) result.set(word, [...languages][0]!);
  return result;
})();

/**
 * Detect the manuscript language. Text that is too short, mixed, or in a
 * language outside the detection range returns unknown.
 */
export function detectManuscriptLanguage(
  text: string,
): DetectedManuscriptLanguage {
  const sample = text.slice(0, SAMPLE_CHARACTERS).normalize("NFC");
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return "unknown";
  const han = sample.match(/\p{Script=Han}/gu)?.length ?? 0;
  const otherCjk =
    sample.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;
  if ((han + otherCjk) * 2 >= letters) {
    // When kana or hangul make up more than a tenth, the text is Japanese or
    // Korean, which is outside the detection range.
    return han >= MIN_HAN_CHARACTERS && otherCjk * 10 < han + otherCjk
      ? "Chinese"
      : "unknown";
  }
  const hits: Record<ScoredLanguage, number> = {
    Portuguese: 0,
    Spanish: 0,
    English: 0,
    French: 0,
  };
  for (const word of sample.toLowerCase().match(/\p{L}+/gu) ?? []) {
    const language = WORD_LANGUAGE.get(word);
    if (language) hits[language] += 1;
  }
  const ranked = (Object.entries(hits) as Array<[ScoredLanguage, number]>).sort(
    (a, b) => b[1] - a[1],
  );
  const [leader, leaderHits] = ranked[0]!;
  const runnerUpHits = ranked[1]![1];
  if (
    leader === "French" ||
    leaderHits < MIN_WORD_HITS ||
    leaderHits < runnerUpHits * MIN_LEAD_RATIO
  )
    return "unknown";
  return leader;
}
