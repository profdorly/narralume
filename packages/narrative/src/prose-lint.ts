/**
 * Deterministic "AI voice" lint: curated tic lists with density thresholds.
 *
 * A single hit never reports; only repetition or density does (major), so
 * one verbal habit does not cost a full revision pass and the occasional
 * worldbuilding term that looks like a tic is absorbed. Chinese rules count
 * per 1,000 characters (calibrated on web-fiction statistics: weak adverbs
 * ≤3 per 1,000 characters, oh-story-claudecode, MIT); Portuguese and English
 * rules count per 1,000 words. The language comes from the prose itself, so
 * an English book inside a Portuguese project is checked as English.
 */

import {
  detectManuscriptLanguage,
  type DetectedManuscriptLanguage,
} from "./manuscript-language.js";

export interface ProseLintIssue {
  code: string;
  severity: "major" | "critical";
  message: string;
  evidence: string | null;
}

interface Tic {
  /** Shown in the summary, e.g. "respirou fundo×3". */
  label: string;
  pattern: RegExp;
}

interface WordRules {
  /** Soft adverbs whose density reads as filler. */
  adverbs: readonly string[];
  adverbLabel: string;
  tics: readonly Tic[];
  /** "It wasn't X. It was Y." and its variants. */
  negationFlips: readonly RegExp[];
  negationLabel: string;
}

/* ---- Chinese (per 1,000 characters) ----------------------------------- */

const ZH_WEAK_ADVERBS = ["缓缓", "微微", "轻轻", "淡淡"] as const;

const ZH_CLICHE_TERMS = [
  "不禁",
  "不由自主",
  "映入眼帘",
  "深吸一口气",
  "嘴角勾起",
  "眼中闪过",
  "眼底闪过",
  "心中暗道",
  "心中一凛",
  "心头一震",
  "心中一动",
  "瞳孔微缩",
  "瞳孔一缩",
  "仿佛",
  "宛如",
  "犹如",
  "一丝",
  "一抹",
  "取而代之",
  "显得有些",
  "声音不大",
  "沉声道",
] as const;

/** “不是A，（而）是B”（“而”可省略）. */
const ZH_NEGATION_FLIP = /不是[^，。！？\n“”‘’]{1,12}，?而?是/gu;

/* ---- Portuguese and English (per 1,000 words) ------------------------- */

const word = (body: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "giu");

/** The "X" of a flip: a few words, no clause break inside. */
const SHORT_CLAUSE = "[^.!?;,:—–\\n]{1,40}?";
/** Between the two halves: one break, then optional spaces. */
const FLIP_BREAK = "[.,;:—–]\\s*";

const PT_RULES: WordRules = {
  adverbs: [
    "lentamente",
    "vagarosamente",
    "suavemente",
    "levemente",
    "ligeiramente",
    "delicadamente",
    "gentilmente",
    "calmamente",
    "silenciosamente",
    "cuidadosamente",
  ],
  adverbLabel: "lentamente/suavemente/levemente…",
  tics: [
    {
      label: "não pôde deixar de",
      pattern: word("não (?:pôde|pode|conseguiu|consegue|conseguia) deixar de"),
    },
    {
      label: "arrepio percorreu",
      pattern: word(
        "(?:arrepio|calafrio)s? (?:percorreu|percorria|subiu|subia|desceu|descia|correu|corria)",
      ),
    },
    {
      label: "coração disparou",
      pattern: word(
        "coração (?:disparou|disparava|martelava|martelou|acelerou|acelerava|batia descompassado|deu um salto)",
      ),
    },
    {
      label: "engoliu em seco",
      pattern: word("engol(?:iu|ia|i|indo) em seco"),
    },
    {
      label: "nó na garganta",
      pattern: word("nó n(?:a garganta|o estômago|o peito)"),
    },
    {
      label: "respiração que nem sabia que prendia",
      pattern: word(
        "respiração que (?:nem )?(?:sabia|percebeu|percebera) que (?:estava )?prend\\p{L}*",
      ),
    },
    {
      label: "o tempo pareceu parar",
      pattern: word(
        "o tempo (?:pareceu|parecia) (?:parar|congelar|desacelerar)",
      ),
    },
    {
      label: "pairava no ar",
      pattern: word("pair(?:ava|ou|a|avam|aram) no ar"),
    },
    {
      label: "silêncio pesado",
      pattern: word("silêncio (?:pesado|ensurdecedor|denso|carregado|espesso)"),
    },
    {
      label: "sorriso brincou nos lábios",
      pattern: word(
        "sorriso (?:brincou|brincava|dançou|dançava|repuxou|repuxava)",
      ),
    },
    {
      label: "canto dos lábios",
      pattern: word("cantos? d(?:a|os|e seus|e sua) (?:boca|lábios)"),
    },
    {
      label: "brilho nos olhos",
      pattern: word("(?:um )?brilho (?:nos|em seus|em teus|naqueles) olhos"),
    },
    { label: "um misto de", pattern: word("um misto de|uma mistura de") },
    {
      label: "uma onda de",
      pattern: word(
        "uma onda de (?:alívio|medo|calor|raiva|tristeza|emoção|culpa|pânico|náusea|ternura)",
      ),
    },
    {
      label: "tensão palpável",
      pattern: word("tensão (?:era |ficou |tornou-se )?palpável"),
    },
    {
      label: "o silêncio se instalou",
      pattern: word(
        "o silêncio (?:se instalou|se instalava|tomou conta|caiu sobre)",
      ),
    },
    { label: "como se o mundo", pattern: word("como se o mundo") },
    {
      label: "um lembrete de que",
      pattern: word(
        "um lembrete (?:silencioso |cruel |constante )?(?:de|do|da) (?:que|como)",
      ),
    },
    {
      label: "um testemunho de",
      pattern: word("um testemunho (?:silencioso |vivo )?d(?:e|o|a|os|as)"),
    },
    { label: "tapeçaria de", pattern: word("tapeçaria d(?:e|o|a|os|as)") },
    {
      label: "dança das sombras",
      pattern: word("dança d(?:e|as|os) (?:sombras|luzes|chamas)"),
    },
    {
      label: "algo mudou dentro",
      pattern: word(
        "algo (?:dentro d(?:ele|ela|eles|elas|e mim|e si) )?(?:mudou|se quebrou|se partiu|se rompeu|se acendeu)",
      ),
    },
    {
      label: "o peso das palavras",
      pattern: word("o peso d(?:as|aquelas|essas) palavras|o peso do mundo"),
    },
    {
      label: "respirou fundo",
      pattern: word("respir(?:ou|ava|ei|amos|aram|ando) fundo"),
    },
    { label: "mordeu o lábio", pattern: word("mord(?:eu|ia|endo|i) o lábio") },
    {
      label: "olhos se arregalaram",
      pattern: word("olhos se arregal(?:aram|avam|ando)"),
    },
    {
      label: "soltou um suspiro",
      pattern: word("(?:soltou|deixou escapar|soltava) um suspiro"),
    },
  ],
  negationFlips: [
    // "Não era medo. Era cansaço." / "não é raiva, é medo": the same verb on
    // both sides, so "Não é preciso dizer. São coisas…" does not count.
    word(
      `não (era|é|foi|eram|são|estava|está|seria)\\s+${SHORT_CLAUSE}${FLIP_BREAK}(?:mas\\s+|e\\s+sim\\s+)?\\1`,
    ),
    // "não por medo, mas por respeito"
    word(`não por ${SHORT_CLAUSE}, mas (?:sim )?por`),
  ],
  negationLabel: "“não era X, era Y”",
};

const EN_RULES: WordRules = {
  adverbs: [
    "slowly",
    "softly",
    "gently",
    "slightly",
    "quietly",
    "carefully",
    "faintly",
    "tenderly",
  ],
  adverbLabel: "slowly/softly/gently…",
  tics: [
    {
      label: "couldn't help but",
      pattern: word("(?:couldn['’]t|could not) help but"),
    },
    {
      label: "shiver ran down",
      pattern: word(
        "(?:shiver|chill)s? (?:ran|went|crawled|raced|ran up|crept) (?:down|up|through)|sent (?:a )?(?:shivers?|chills?)",
      ),
    },
    {
      label: "heart pounded",
      pattern: word(
        "heart (?:pounded|hammered|raced|thundered|leapt|skipped a beat)",
      ),
    },
    { label: "swallowed hard", pattern: word("swallowed hard") },
    {
      label: "lump in the throat",
      pattern: word("lump (?:formed )?in (?:her|his|their|my|your) throat"),
    },
    {
      label: "breath she didn't know she was holding",
      pattern: word(
        "breath (?:she|he|they|i|you) (?:didn['’]t|did not|hadn['’]t) (?:know|realize|realised|realized)",
      ),
    },
    {
      label: "time seemed to stop",
      pattern: word(
        "time (?:seemed to )?(?:stood still|stand still|stopped|slowed)",
      ),
    },
    {
      label: "hung in the air",
      pattern: word("hung (?:heavy )?in the air|the air (?:was )?thick with"),
    },
    {
      label: "heavy silence",
      pattern: word("(?:deafening|heavy|thick|pregnant|oppressive) silence"),
    },
    {
      label: "smile tugged at",
      pattern: word("(?:smile|grin) tugged at|tugged at the corners? of"),
    },
    { label: "a flicker of", pattern: word("a (?:flicker|glint|spark) of") },
    { label: "a mix of", pattern: word("a (?:mix|mixture) of") },
    {
      label: "a wave of",
      pattern: word(
        "a wave of (?:relief|fear|nausea|guilt|warmth|emotion|panic|sadness|exhaustion)",
      ),
    },
    {
      label: "palpable tension",
      pattern: word(
        "(?:tension|silence) (?:was |grew |became )?palpable|palpable (?:tension|silence)",
      ),
    },
    {
      label: "a symphony of",
      pattern: word("a (?:symphony|cacophony|kaleidoscope) of"),
    },
    {
      label: "as if the world",
      pattern: word("as if the (?:whole |entire )?world"),
    },
    {
      label: "a reminder that",
      pattern: word(
        "a (?:stark |silent |quiet |cruel |constant )?reminder (?:that|of how)",
      ),
    },
    { label: "a testament to", pattern: word("(?:a |an )?testament to") },
    { label: "tapestry of", pattern: word("tapestry of") },
    {
      label: "shadows danced",
      pattern: word(
        "shadows (?:danced|played)|dance of (?:light|shadows?|flames?)",
      ),
    },
    {
      label: "something shifted",
      pattern: word(
        "something (?:inside (?:her|him|them|me) )?(?:shifted|broke|snapped|cracked)",
      ),
    },
    {
      label: "the weight of his words",
      pattern: word(
        "the weight of (?:the world|his words|her words|their words|my words|it all|everything)",
      ),
    },
    {
      label: "took a deep breath",
      pattern: word(
        "(?:took|drew|taking|drawing|take) a (?:deep|steadying|shaky|long) breath",
      ),
    },
    {
      label: "bit her lip",
      pattern: word("bit (?:her|his|their|my) (?:lower )?lip"),
    },
    { label: "eyes widened", pattern: word("eyes widened") },
    { label: "let out a breath", pattern: word("let out a (?:breath|sigh)") },
    {
      label: "barely above a whisper",
      pattern: word("barely above a whisper"),
    },
  ],
  negationFlips: [
    // "It wasn't fear. It was exhaustion." / "It's not a game—it's war."
    word(
      `(?:it|this|that)(?:['’]s\\s+not|\\s+(?:wasn['’]t|was not|isn['’]t|is not))\\s+${SHORT_CLAUSE}${FLIP_BREAK}(?:but\\s+)?(?:it|this|that)(?:['’]s|\\s+(?:was|is))`,
    ),
    // "He wasn't angry, he was tired.": the same subject on both sides.
    word(
      `(he|she|they|i|you|we)(?:['’](?:s|re|m)\\s+not|\\s+(?:wasn['’]t|was not|isn['’]t|is not|weren['’]t|were not|aren['’]t|are not|am not))\\s+${SHORT_CLAUSE}${FLIP_BREAK}(?:but\\s+)?\\1(?:['’](?:s|re|m)|\\s+(?:was|is|were|are|am))`,
    ),
    // "not out of fear, but out of respect"
    word(`not (?:out of|because of|from) ${SHORT_CLAUSE}, but`),
  ],
  negationLabel: "“it wasn't X, it was Y”",
};

/** Soft adverbs above this many per 1,000 words (and at least the minimum);
 *  about the Chinese budget of 3 per 1,000 characters. Four public-domain
 *  novels (Machado de Assis ×2, Austen, Fitzgerald) measure 0.1–0.8. */
const ADVERBS_PER_THOUSAND_WORDS = 5;
const MIN_ADVERB_HITS = 5;
/** One tic this many times, or this many tics in total, reports. */
const SINGLE_TIC_REPEATS = 3;
const MIN_TOTAL_TICS = 5;
/** Long chapters may hold more tics before reporting (one per N words). */
const WORDS_PER_ALLOWED_TIC = 600;
const MIN_NEGATION_FLIPS = 3;

export function proseLintIssues(
  content: string,
  language: DetectedManuscriptLanguage = detectManuscriptLanguage(content),
): ProseLintIssue[] {
  const issues: (ProseLintIssue | null)[] = [
    zhWeakAdverbIssue(content),
    zhClicheIssue(content),
    zhNegationFlipIssue(content),
  ];
  const ruleSets =
    language === "Portuguese"
      ? [PT_RULES]
      : language === "English"
        ? [EN_RULES]
        : language === "unknown"
          ? [PT_RULES, EN_RULES]
          : [];
  for (const rules of ruleSets) issues.push(...wordRuleIssues(content, rules));
  return issues.filter((issue): issue is ProseLintIssue => issue !== null);
}

function wordRuleIssues(
  content: string,
  rules: WordRules,
): (ProseLintIssue | null)[] {
  const words = content.match(/\p{L}+(?:['’]\p{L}+)*/gu)?.length ?? 0;
  if (words === 0) return [];
  const normalized = content.normalize("NFC");

  const adverbHits = rules.adverbs.flatMap((adverb) => [
    ...normalized.matchAll(word(adverb)),
  ]);
  const adverbIssue: ProseLintIssue | null =
    adverbHits.length >= MIN_ADVERB_HITS &&
    adverbHits.length * 1000 > ADVERBS_PER_THOUSAND_WORDS * words
      ? {
          code: "draft.ai_adverb_density",
          severity: "major",
          message: `Advérbios suavizadores em excesso (${rules.adverbLabel}): ${adverbHits.length} ocorrências em ${words} palavras`,
          evidence: evidenceAt(normalized, earliest(adverbHits)),
        }
      : null;

  const ticHits = rules.tics
    .map((tic) => ({ tic, matches: [...normalized.matchAll(tic.pattern)] }))
    .filter((hit) => hit.matches.length > 0);
  const total = ticHits.reduce((sum, hit) => sum + hit.matches.length, 0);
  const top = ticHits
    .slice()
    .sort((left, right) => right.matches.length - left.matches.length)[0];
  const allowedTotal = Math.max(
    MIN_TOTAL_TICS,
    Math.ceil(words / WORDS_PER_ALLOWED_TIC),
  );
  const ticIssue: ProseLintIssue | null =
    top && (top.matches.length >= SINGLE_TIC_REPEATS || total >= allowedTotal)
      ? {
          code: "draft.ai_cliche_density",
          severity: "major",
          message: `Clichês típicos de texto gerado por IA em excesso: ${
            ticHits
              .filter((hit) => hit.matches.length >= 2)
              .map((hit) => `${hit.tic.label}×${hit.matches.length}`)
              .join(", ") || `${top.tic.label}×${top.matches.length}`
          } (${total} no total)`,
          evidence: evidenceAt(normalized, earliest(top.matches)),
        }
      : null;

  const flips = rules.negationFlips.flatMap((pattern) => [
    ...normalized.matchAll(pattern),
  ]);
  const flipIssue: ProseLintIssue | null =
    flips.length >= MIN_NEGATION_FLIPS
      ? {
          code: "draft.ai_negation_flip",
          severity: "major",
          message: `Construções ${rules.negationLabel} em excesso: ${flips.length} ocorrências`,
          evidence: evidenceAt(normalized, earliest(flips)),
        }
      : null;

  return [adverbIssue, ticIssue, flipIssue];
}

function earliest(matches: readonly RegExpMatchArray[]): number | null {
  return matches.reduce<number | null>(
    (first, match) =>
      match.index !== undefined && (first === null || match.index < first)
        ? match.index
        : first,
    null,
  );
}

function evidenceAt(content: string, index: number | null): string | null {
  return index === null ? null : content.slice(index, index + 80);
}

/* ---- Chinese rules ----------------------------------------------------- */

function countOccurrences(content: string, term: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(term, offset)) >= 0) {
    count += 1;
    offset += term.length;
  }
  return count;
}

function evidenceAround(content: string, term: string): string | null {
  const index = content.indexOf(term);
  return index < 0 ? null : content.slice(index, index + 40);
}

/** Weak adverbs: more than 3 per 1,000 characters and at least 4 in total. */
function zhWeakAdverbIssue(content: string): ProseLintIssue | null {
  const hits = ZH_WEAK_ADVERBS.reduce(
    (sum, term) => sum + countOccurrences(content, term),
    0,
  );
  const characters = [...content].length;
  if (hits < 4 || hits * 1000 <= 3 * characters) return null;
  const first = ZH_WEAK_ADVERBS.find((term) => content.includes(term));
  return {
    code: "draft.ai_adverb_density",
    severity: "major",
    message: `Advérbios suavizadores em excesso (缓缓/微微/轻轻/淡淡): ${hits} ocorrências`,
    evidence: first ? evidenceAround(content, first) : null,
  };
}

/** Tic list: one term at least 3 times, or at least 5 in total. */
function zhClicheIssue(content: string): ProseLintIssue | null {
  const hits = ZH_CLICHE_TERMS.map((term) => ({
    term,
    count: countOccurrences(content, term),
  })).filter((hit) => hit.count > 0);
  const [top] = hits.slice().sort((a, b) => b.count - a.count);
  if (!top) return null;
  const total = hits.reduce((sum, hit) => sum + hit.count, 0);
  if (total < 5 && top.count < 3) return null;
  const summary = hits
    .filter((hit) => hit.count >= 2)
    .map((hit) => `${hit.term}×${hit.count}`)
    .join("、");
  return {
    code: "draft.ai_cliche_density",
    severity: "major",
    message: `Clichês típicos de texto gerado por IA em excesso: ${summary || `${top.term}×${top.count}`}`,
    evidence: evidenceAround(content, top.term),
  };
}

/** “不是A，（而）是B”: at least 3 times. */
function zhNegationFlipIssue(content: string): ProseLintIssue | null {
  const matches = content.match(ZH_NEGATION_FLIP);
  if (!matches || matches.length < 3) return null;
  const locator = /不是[^，。！？\n“”‘’]{1,12}，?而?是/u;
  const first = locator.exec(content);
  return {
    code: "draft.ai_negation_flip",
    severity: "major",
    message: `Construções “不是…而是” em excesso: ${matches.length} ocorrências`,
    evidence: first ? content.slice(first.index, first.index + 40) : null,
  };
}
