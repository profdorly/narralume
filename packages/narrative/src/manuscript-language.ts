/** 原稿语言的轻量检测（尽力而为）：只区分葡语、西语、英语与中文，其余返回 unknown。
 *  不依赖外部库：CJK 原稿看书写系统，拉丁字母原稿数各语言独有的高频功能词。
 *  结果只作为拆书、章节结算与故事圣经候选提示中的参考行；语言不变量仍要求模型跟随正文本身。 */

import type { ProjectLanguage } from "@narralume/contracts";

export type DetectedManuscriptLanguage =
  "Portuguese" | "Spanish" | "English" | "Chinese" | "unknown";

/** 代码检测的原稿语言在中文提示中的写法。 */
const DETECTED_LANGUAGE_NAMES_ZH: Record<
  Exclude<DetectedManuscriptLanguage, "unknown">,
  string
> = {
  Portuguese: "葡萄牙语",
  Spanish: "西班牙语",
  English: "英语",
  Chinese: "中文",
};

/** 提示词中的原稿语言参考行（按指令语言书写）；检测不出语言时返回 null，不加这一行。 */
export function manuscriptLanguageHint(
  language: ProjectLanguage,
  detected: DetectedManuscriptLanguage,
): string | null {
  if (detected === "unknown") return null;
  return language === "en"
    ? `Manuscript language (detected): ${detected}. Write the natural-language fields in this language; if the text itself is clearly in another language, follow the text.`
    : `原稿语言（自动检测）：${DETECTED_LANGUAGE_NAMES_ZH[detected]}。自然语言字段用该语言书写；正文明显是另一种语言时以正文为准。`;
}

type ScoredLanguage = "Portuguese" | "Spanish" | "English" | "French";

/** 只取正文开头这么多字符，足以判断语言，也让检测成本与原稿长度无关。 */
const SAMPLE_CHARACTERS = 100_000;
/** 判定一种拉丁字母语言至少需要的功能词命中数。 */
const MIN_WORD_HITS = 3;
/** 领先语言的命中数至少是第二名的这么多倍，否则不下结论。 */
const MIN_LEAD_RATIO = 2;
/** 判定中文至少需要的汉字数。 */
const MIN_HAN_CHARACTERS = 8;

/** 各语言独有的高频功能词（小写，保留变音符）。葡语与西语共有的 que、de、para、nada，
 *  以及西语与法语共有的 la、le、un、en 等都不列入；万一某个词出现在多张表中，
 *  构建时也会剔除。法语只用来吸收法语原稿的命中：它领先时结果为 unknown。 */
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
    // 与葡语 do（de + o）同形，列在两张表中，构建时作为共有词剔除。
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

/** 功能词 → 语言；在多种语言中出现的词不计入。 */
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

/** 检测原稿语言。过短、混合或不在检测范围内的语言返回 unknown。 */
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
    // 假名或谚文占到一成以上时是日文或韩文，不在检测范围内。
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
