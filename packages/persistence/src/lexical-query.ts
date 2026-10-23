/**
 * Turns a free-text retrieval query (an outline summary, a co-create turn, a
 * Lab search) into FTS5 match expressions.
 *
 * - Words from space-separated scripts go to the unicode61 word index as an
 *   OR of terms, so BM25 rewards segments that share more (and rarer) words.
 *   Stopwords, chapter-heading words and short numbers are dropped; longer
 *   words become prefix terms so plural and gender endings still match.
 * - CJK runs go to the trigram index as phrases (the whole run when short,
 *   overlapping three-character windows when long), plus two-character terms
 *   for the LIKE fallback because trigrams cannot match two-character words.
 */
export interface LexicalQueryPlan {
  /** MATCH expression for `text_segments_words`, or null. */
  readonly words: string | null;
  /** MATCH expression for `text_segments_fts` (trigram), or null. */
  readonly trigrams: string | null;
  /** CJK terms for the LIKE fallback when neither index matches. */
  readonly likeTerms: readonly string[];
  /** Folded terms, for deterministic reranking. */
  readonly terms: readonly string[];
}

const MAX_WORD_TERMS = 24;
const MAX_TRIGRAM_TERMS = 16;
const MAX_LIKE_TERMS = 16;

const CJK_RUN =
  /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/gu;

/* Folded (lowercase, no diacritics) words of three or more letters. Words
   shorter than three characters are dropped anyway. */
const STOPWORDS = new Set(
  [
    // pt-BR / pt-PT
    "aos as ate apos ante com contra desde entre para pela pelas pelo pelos por pra sem sob sobre",
    "uma umas uns dum duma num numa nos nas dos das",
    "que quem qual quais cujo cuja cujos cujas como mais menos muito muita muitos muitas pouco pouca",
    "ainda tambem nao sim quando onde porque porque pois entao isso isto aquilo esse essa esses essas",
    "este esta estes estas aquele aquela aqueles aquelas ele ela eles elas voce voces nos vos",
    "lhe lhes seu sua seus suas meu minha meus minhas teu tua teus tuas nosso nossa nossos nossas",
    "dele dela deles delas foi foram era eram ser sao sera estar esta estava estavam estao",
    "tem tinha tinham ter tera havia haver vai vao ia iam faz fazer fez todo toda todos todas",
    "outro outra outros outras mesmo mesma mesmos mesmas cada qualquer algum alguma alguns algumas",
    "nenhum nenhuma tudo nada sempre nunca depois antes agora entao assim tao tanto tanta",
    "capitulo capitulos cap prologo epilogo",
    // es
    "los las del una unos unas pero con sin para por que como mas cuando donde sus fue ser estar",
    "esta este estos estas ese esa esos esas muy tambien tiene tenia hay habia todo toda todos todas",
    // en
    "the and but for with from into onto over under about after before again are was were been being",
    "this that these those they them their theirs his her hers him she its our ours you your yours",
    "not nor then than there here what which who whom whose when where why how all any each some such",
    "can could should would will shall may might must does did done have has had having just only",
    "very also more most much many other others same own out off down very upon",
    "chapter chapters prologue epilogue part",
  ]
    .join(" ")
    .split(/\s+/u)
    .filter(Boolean),
);

export function foldText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLocaleLowerCase();
}

export function buildLexicalQuery(query: string): LexicalQueryPlan {
  const normalized = query.normalize("NFKC");
  const cjkRuns = [...normalized.matchAll(CJK_RUN)].map((match) => match[0]);
  const nonCjk = normalized.replace(CJK_RUN, " ");

  const wordTerms = new Map<string, { prefix: boolean; order: number }>();
  for (const word of foldText(nonCjk).split(/[^\p{L}\p{N}]+/u)) {
    if (!word || STOPWORDS.has(word)) continue;
    if (/^\p{N}+$/u.test(word)) {
      // Years ("1987") are meaningful; chapter numbers ("11") are not.
      if (word.length < 3) continue;
    } else if ([...word].length < 3) continue;
    const term = stemmedTerm(word);
    const current = wordTerms.get(term.text);
    if (!current || (current.prefix && !term.prefix))
      wordTerms.set(term.text, {
        prefix: term.prefix,
        order: current?.order ?? wordTerms.size,
      });
  }
  const selectedWords = [...wordTerms.entries()]
    .sort(
      ([leftText, left], [rightText, right]) =>
        // Prefer longer, more specific terms when the query is long.
        rightText.length - leftText.length || left.order - right.order,
    )
    .slice(0, MAX_WORD_TERMS)
    .sort(([, left], [, right]) => left.order - right.order);

  const trigramTerms = new Set<string>();
  const likeTerms = new Set<string>();
  for (const run of cjkRuns) {
    const characters = [...run];
    if (characters.length >= 3 && characters.length <= 4) {
      trigramTerms.add(run);
    } else if (characters.length > 4) {
      for (let index = 0; index + 3 <= characters.length; index += 1)
        trigramTerms.add(characters.slice(index, index + 3).join(""));
    }
    if (characters.length <= 4) likeTerms.add(run);
    if (characters.length > 2) {
      for (let index = 0; index + 2 <= characters.length; index += 1)
        likeTerms.add(characters.slice(index, index + 2).join(""));
    }
  }

  const words =
    selectedWords.length > 0
      ? selectedWords
          .map(([text, term]) => `${quote(text)}${term.prefix ? "*" : ""}`)
          .join(" OR ")
      : null;
  const trigrams =
    trigramTerms.size > 0
      ? [...trigramTerms].slice(0, MAX_TRIGRAM_TERMS).map(quote).join(" OR ")
      : null;
  return {
    words,
    trigrams,
    likeTerms: [...likeTerms].slice(0, MAX_LIKE_TERMS),
    terms: [
      ...selectedWords.map(([text]) => text),
      ...[...trigramTerms].slice(0, MAX_TRIGRAM_TERMS),
    ],
  };
}

/**
 * Light, language-agnostic stemming for Romance and Germanic words: long
 * words keep a prefix so "salinas" matches "salina", "anotações" matches
 * "anotação" and "dissolved" matches "dissolve". Five- and six-letter words
 * only lose a final vowel or "s" (typical inflection endings), so "farol"
 * still matches "faroleiro" and "caixas" matches "caixa".
 */
function stemmedTerm(word: string): { text: string; prefix: boolean } {
  const characters = [...word];
  if (/^\p{N}+$/u.test(word) || characters.length <= 4)
    return { text: word, prefix: false };
  if (characters.length <= 6) {
    const last = characters[characters.length - 1]!;
    return {
      text: /[aeiouys]/u.test(last)
        ? characters.slice(0, characters.length - 1).join("")
        : word,
      prefix: true,
    };
  }
  return {
    text: characters.slice(0, Math.max(5, characters.length - 3)).join(""),
    prefix: true,
  };
}

function quote(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}
