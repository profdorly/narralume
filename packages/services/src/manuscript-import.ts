/** 导入正文的结构识别：章节标题、DOCX 标题样式、HTML/EPUB 标题与统计风格。
 *  这里只做纯文本变换；容器解析与安全上限由 delivery-service 负责。 */

export interface ManuscriptSection {
  title: string;
  content: string;
}

/** 非 Markdown 标题行的长度上限（按码点）；超过即视为正文段落。 */
export const HEADING_MAX_CHARACTERS = 80;

const MARKDOWN_HEADING = /^#{1,3}\s+(\S.*?)\s*$/u;
const CJK_HEADING = /^第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回]/u;
const EMPHASIS_WRAPPED = /^(\*{1,2}|_{1,2})(\S(?:.*\S)?)\1$/u;

/** 必须带序号的分部关键词（pt / es / en）。按去除变音符后的小写形式书写。 */
const NUMBERED_KEYWORDS = [
  "capitulo",
  "chapter",
  "parte",
  "part",
  "livro",
  "libro",
  "book",
];

/** 可以不带序号的分部关键词（pt / es / en）。 */
const STANDALONE_KEYWORDS = [
  "prologo",
  "prologue",
  "epilogo",
  "epilogue",
  "interludio",
  "interlude",
];

/** 拼写序号：pt / es / en 的基数 1–20、整十与 pt / es 的序数 1–10。
 *  复合数（vinte e um、twenty-one、treinta y dos）由连接符组合。 */
const NUMBER_WORDS = [
  // pt
  "um",
  "uma",
  "dois",
  "duas",
  "tres",
  "quatro",
  "cinco",
  "seis",
  "sete",
  "oito",
  "nove",
  "dez",
  "onze",
  "doze",
  "treze",
  "catorze",
  "quatorze",
  "quinze",
  "dezesseis",
  "dezasseis",
  "dezessete",
  "dezassete",
  "dezoito",
  "dezenove",
  "dezanove",
  "vinte",
  "trinta",
  "quarenta",
  "cinquenta",
  "sessenta",
  "setenta",
  "oitenta",
  "noventa",
  "primeiro",
  "primeira",
  "segundo",
  "segunda",
  "terceiro",
  "terceira",
  "quarto",
  "quarta",
  "quinto",
  "quinta",
  "sexto",
  "sexta",
  "setimo",
  "setima",
  "oitavo",
  "oitava",
  "nono",
  "nona",
  "decimo",
  "decima",
  // es
  "uno",
  "dos",
  "cuatro",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciseis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
  "veinte",
  "veintiuno",
  "veintidos",
  "veintitres",
  "veinticuatro",
  "veinticinco",
  "veintiseis",
  "veintisiete",
  "veintiocho",
  "veintinueve",
  "treinta",
  "cuarenta",
  "cincuenta",
  "sesenta",
  "ochenta",
  "primero",
  "primera",
  "tercero",
  "tercera",
  "cuarto",
  "cuarta",
  "septimo",
  "septima",
  "octavo",
  "octava",
  "noveno",
  "novena",
  // en
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

const ROMAN_NUMERAL =
  "(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})";

function alternation(words: readonly string[]): string {
  return [...new Set(words)].sort((a, b) => b.length - a.length).join("|");
}

const NUMBER_WORD = `(?:${alternation(NUMBER_WORDS)})(?:(?:\\s*-\\s*|\\s+(?:e|y|and)\\s+|\\s+)(?:${alternation(NUMBER_WORDS)}))?`;

/** 关键词 + 可选序号 + 可选标题。标题可用分隔符（: . - – —）接在序号后，
 *  也可只用空白（Chapter 12 The Storm），但空白后以小写字母开头的行视为折行正文。 */
const KEYWORD_HEADING = new RegExp(
  `^(?:(?<numbered>${alternation(NUMBERED_KEYWORDS)})|(?<standalone>${alternation(STANDALONE_KEYWORDS)}))` +
    `(?:\\s+(?<number>\\d{1,4}|${ROMAN_NUMERAL}|${NUMBER_WORD}))?` +
    `(?:(?<separated>\\s*[:.\\-–—]\\s*.*)|(?<loose>\\s+.+))?$`,
  "iu",
);

function withoutDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

function isKeywordHeading(line: string): boolean {
  const match = KEYWORD_HEADING.exec(withoutDiacritics(line));
  const groups = match?.groups;
  if (!groups) return false;
  const number = groups.number;
  if (groups.numbered && !number) return false;
  // 罗马数字只接受大写，避免 "Book I read" 之类的英文句子。
  if (
    number &&
    /^[mdclxvi]+$/iu.test(number) &&
    number !== number.toUpperCase()
  )
    return false;
  // 空白后直接接小写词多半是句子或折行正文：“Capítulo 3 do livro anterior…”
  if (
    groups.loose !== undefined &&
    (!number || /^\s*\p{Ll}/u.test(groups.loose))
  )
    return false;
  return true;
}

/** 判断一行是否为章节标题，返回标题文本；否则返回 null。 */
export function manuscriptHeadingTitle(line: string): string | null {
  const markdown = MARKDOWN_HEADING.exec(line);
  if (markdown) return markdown[1]!;
  const trimmed = line.trim();
  if (!trimmed || [...trimmed].length > HEADING_MAX_CHARACTERS) return null;
  const candidate = EMPHASIS_WRAPPED.exec(trimmed)?.[2] ?? trimmed;
  if (CJK_HEADING.test(candidate) || isKeywordHeading(candidate))
    return candidate;
  return null;
}

/** 按章节标题切分正文。首个标题前的文字（扉页、题记等）以作品标题命名，
 *  不引入特定语言的固定称谓；没有标题时整部正文作为一个分段。 */
export function splitManuscriptSections(
  text: string,
  fallbackTitle: string,
): ManuscriptSection[] {
  const headings: { start: number; end: number; title: string }[] = [];
  for (const line of text.matchAll(/^.*$/gmu)) {
    const title = manuscriptHeadingTitle(line[0]);
    if (title !== null)
      headings.push({
        start: line.index,
        end: line.index + line[0].length,
        title,
      });
  }
  if (!headings.length) return [{ title: fallbackTitle, content: text.trim() }];
  const sections: ManuscriptSection[] = [];
  const prefix = text.slice(0, headings[0]!.start).trim();
  if (prefix) sections.push({ title: fallbackTitle, content: prefix });
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start ?? text.length;
    const content = text.slice(heading.end, end).trim();
    if (content) sections.push({ title: heading.title, content });
  });
  return sections.length
    ? sections
    : [{ title: fallbackTitle, content: text.trim() }];
}

interface DocxStyle {
  name: string | null;
  basedOn: string | null;
  outlineLevel: string | null;
}

const XML_VALUE_PATTERNS = new Map<string, RegExp>();

function xmlValue(xml: string, tag: string): string | null {
  let pattern = XML_VALUE_PATTERNS.get(tag);
  if (!pattern) {
    pattern = new RegExp(`<${tag}\\b[^>]*?\\bw:val=["']([^"']*)["']`, "u");
    XML_VALUE_PATTERNS.set(tag, pattern);
  }
  return pattern.exec(xml)?.[1] ?? null;
}

function parseDocxStyles(stylesXml: string | null): Map<string, DocxStyle> {
  const styles = new Map<string, DocxStyle>();
  if (!stylesXml) return styles;
  for (const match of stylesXml.matchAll(
    /<w:style\b([^>]*?)(?<!\/)>([\s\S]*?)<\/w:style>/gu,
  )) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const type = /\bw:type=["']([^"']+)["']/u.exec(attributes)?.[1];
    const id = /\bw:styleId=["']([^"']+)["']/u.exec(attributes)?.[1];
    if (!id || (type && type !== "paragraph")) continue;
    styles.set(id, {
      name: xmlValue(body, "w:name"),
      basedOn: xmlValue(body, "w:basedOn"),
      outlineLevel: xmlValue(body, "w:outlineLvl"),
    });
  }
  return styles;
}

/** 大纲级别 0–2 对应 # 到 ###；更深的级别和正文级别（9）不切章。 */
function outlineHeadingLevel(value: string): number | null {
  const level = Number(value);
  return Number.isInteger(level) && level >= 0 && level <= 2 ? level + 1 : null;
}

/** Word 内置样式名在 styles.xml 中始终是英文（heading 1、Title），
 *  本地化版本只改 styleId（如葡语的 Ttulo1）。缺少 styles.xml 时按 styleId 判断。 */
function builtInHeadingLevel(nameOrId: string): number | null {
  const normalized = nameOrId.toLowerCase().replace(/\s+/gu, "");
  if (normalized === "title") return 1;
  const heading = /^heading([1-3])$/u.exec(normalized);
  return heading ? Number(heading[1]) : null;
}

function styleHeadingLevel(
  styleId: string,
  styles: ReadonlyMap<string, DocxStyle>,
  depth = 0,
): number | null {
  const style = styles.get(styleId);
  if (!style) return builtInHeadingLevel(styleId);
  if (style.outlineLevel !== null)
    return outlineHeadingLevel(style.outlineLevel);
  const named = style.name ? builtInHeadingLevel(style.name) : null;
  if (named !== null) return named;
  return style.basedOn && depth < 10
    ? styleHeadingLevel(style.basedOn, styles, depth + 1)
    : null;
}

function paragraphHeadingLevel(
  properties: string,
  styles: ReadonlyMap<string, DocxStyle>,
): number | null {
  const outline = xmlValue(properties, "w:outlineLvl");
  if (outline !== null) return outlineHeadingLevel(outline);
  const styleId = xmlValue(properties, "w:pStyle");
  return styleId === null ? null : styleHeadingLevel(styleId, styles);
}

/** 把 DOCX 正文转为纯文本；标题样式或大纲级别 0–2 的段落加 Markdown 标题前缀。 */
export function docxDocumentText(
  documentXml: string,
  stylesXml: string | null,
): string {
  const styles = parseDocxStyles(stylesXml);
  return decodeXml(
    documentXml
      .replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/gu, "")
      .replace(
        /<w:pPr\b[^>]*?(?<!\/)>([\s\S]*?)<\/w:pPr>/gu,
        (_, properties: string) => {
          const level = paragraphHeadingLevel(properties, styles);
          return level === null ? "" : `\n${"#".repeat(level)} `;
        },
      )
      .replace(/<w:tab\b[^>]*\/>/giu, "\t")
      .replace(/<w:br\b[^>]*\/>/giu, "\n")
      .replace(/<\/w:p>/giu, "\n\n")
      .replace(/<\/w:tr>/giu, "\n")
      .replace(/<\/w:tc>/giu, "\t")
      .replace(/<[^>]+>/gu, ""),
  ).replace(/^#{1,3}[ \t]*$/gmu, "");
}

export function htmlToText(html: string): string {
  return decodeXml(
    html
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/giu, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
      // 标题标记内容限长，避免未闭合标签让惰性匹配扫描整页；超长时退回只加前缀。
      .replace(
        /<h([1-3])\b[^>]*>([\s\S]{0,2000}?)<\/h\1\s*>/giu,
        (_, level: string, inner: string) => {
          const title = inner
            .replace(/<[^>]+>/gu, " ")
            .replace(/\s+/gu, " ")
            .trim();
          return title ? `\n\n${"#".repeat(Number(level))} ${title}\n\n` : "";
        },
      )
      .replace(/<h[1-3]\b[^>]*>/giu, "\n# ")
      .replace(/<\/(?:h[1-6]|p|div|li|blockquote)>/giu, "\n\n")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<[^>]+>/gu, ""),
  );
}

function decodeXml(value: string) {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/&#(\d+);/gu, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

const CJK_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const SCRIPT_SAMPLE_CHARACTERS = 200_000;

/** 以正文前 20 万字符取样：CJK 字符占字母类字符多数时按“字”统计。 */
export function isCjkManuscript(text: string): boolean {
  const sample = text.slice(0, SCRIPT_SAMPLE_CHARACTERS);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  const cjk = sample.match(CJK_CHARACTER)?.length ?? 0;
  return letters === 0 || cjk * 2 >= letters;
}

export type StatisticalStylePayload = {
  name: string;
  description: string;
  rules: string[];
  negativeRules: string[];
  examples: string[];
  active: false;
};

/** 由导入文本的可复验统计生成风格候选。CJK 正文按字计量并使用中文措辞；
 *  其他文字按词计量、句末同时识别 . 与 …，措辞使用英文。 */
export function inferStylePayload(text: string): StatisticalStylePayload {
  const paragraphs = text.split(/\n\s*\n/u).filter((item) => item.trim());
  const examples = paragraphs
    .slice(0, 3)
    .map((item) => item.trim().slice(0, 500));
  if (isCjkManuscript(text)) {
    const sentences = text.split(/[。！？!?]+/u).filter((item) => item.trim());
    const dialogueCharacters = [...text].filter((char) =>
      "“”「」『』".includes(char),
    ).length;
    const averageSentence = Math.round(
      sentences.reduce((sum, item) => sum + [...item.trim()].length, 0) /
        Math.max(1, sentences.length),
    );
    const averageParagraph = Math.round(
      paragraphs.reduce((sum, item) => sum + [...item.trim()].length, 0) /
        Math.max(1, paragraphs.length),
    );
    return {
      name: "原文统计风格",
      description: "由导入文本的可复验统计生成，采用前应由作者审阅。",
      rules: [
        `句长中位倾向约 ${averageSentence} 字，避免无意中大幅漂移`,
        `段落平均约 ${averageParagraph} 字，按场面节奏调整而非机械复制`,
        dialogueCharacters > text.length / 20
          ? "对话占比较高，保留人物声音与潜台词"
          : "叙述占比较高，对话只承担必要动作",
      ],
      negativeRules: ["不复制原文句子", "不把统计特征当成不可变文学规则"],
      examples,
      active: false,
    };
  }
  const words = (value: string) =>
    value.split(/\s+/u).filter((item) => /[\p{L}\p{N}]/u.test(item)).length;
  const sentences = text
    .split(/[.!?…。！？]+/u)
    .filter((item) => /[\p{L}\p{N}]/u.test(item));
  const totalWords = words(text);
  // 引号对话与葡语 / 西语行首破折号（travessão / raya）对话。
  const dialogueMarks =
    (text.match(/["“”«»]/gu)?.length ?? 0) +
    (text.match(/^[ \t]*[—–]/gmu)?.length ?? 0);
  const averageSentence = Math.round(
    sentences.reduce((sum, item) => sum + words(item), 0) /
      Math.max(1, sentences.length),
  );
  const averageParagraph = Math.round(
    paragraphs.reduce((sum, item) => sum + words(item), 0) /
      Math.max(1, paragraphs.length),
  );
  return {
    name: "Source text statistics style",
    description:
      "Generated from reproducible statistics of the imported text; review before adopting.",
    rules: [
      `Sentences run about ${averageSentence} words on average; avoid drifting far from this unintentionally`,
      `Paragraphs average about ${averageParagraph} words; adjust to scene rhythm instead of copying mechanically`,
      dialogueMarks > totalWords / 20
        ? "Dialogue is prominent; preserve character voices and subtext"
        : "Narration dominates; dialogue carries only necessary action",
    ],
    negativeRules: [
      "Do not copy source sentences",
      "Do not treat statistical traits as immutable literary rules",
    ],
    examples,
    active: false,
  };
}
