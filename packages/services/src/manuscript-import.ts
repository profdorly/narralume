/** 导入正文的结构识别：章节标题、DOCX 标题样式、HTML/EPUB 标题与统计风格。
 *  这里只做纯文本变换；容器解析与安全上限由 delivery-service 负责。 */

import { detectManuscriptLanguage } from "@lapis/narrative";

export interface ManuscriptSection {
  title: string;
  content: string;
}

/** 关键词标题行（pt / es / en 与强调包裹形式）的长度上限（按码点）；超过即视为正文段落。
 *  既有的“第 N 章”与“Chapter + 数字”形式不受此限。 */
export const HEADING_MAX_CHARACTERS = 80;
/** Paragraph style written on the exported title page so re-import can skip it. */
export const DOCX_TITLE_PAGE_STYLE = "LapisTitlePage";
/** Title page style of DOCX files exported before the rename. */
const LEGACY_DOCX_TITLE_PAGE_STYLE = "NarraLumeTitlePage";

// 标题捕获用贪婪的 (\S.*)$ 再去尾部空白：惰性的 (\S.*?)\s*$ 在长空白串上是平方级。
const MARKDOWN_HEADING = /^#{1,3}\s+(\S.*)$/u;
/** 既有标题形式，行为与引入关键词语法前一致：“第 N 章 / 节 / 卷 / 部 / 回”与
 *  “Chapter + 阿拉伯数字”（不区分大小写），不限长度，整行（去首尾空白）作为标题，
 *  也不识别强调包裹（**第一章** 仍是正文）。 */
const LEGACY_HEADING =
  /^\s*(?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回]|chapter\s+\d)/iu;
const EMPHASIS_WRAPPED = /^(\*{1,2}|_{1,2})(\S(?:.*\S)?)\1$/u;
/** 独占一段的场景分隔符（#、###、# # #、***、* * *、⁂）。它们是正文，不是标题。 */
const SCENE_BREAK = /^(?:(?:#[ \t]*)+|(?:\*[ \t]*){3,}|⁂)$/u;

/** 首个标题之前文字的固定称谓；仅用于以 CJK 为主的原稿，与既有行为一致。 */
const CJK_FRONT_MATTER_TITLE = "卷首";

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

/** 序号必须在词边界结束；连字符连着字母或数字仍属同一个词，
 *  因此 “segunda-feira” 不会被读成序号 segunda 加分隔符 “-feira”，“2-3” 也不是序号 2。 */
const NUMBER_END = "(?![\\p{L}\\p{N}]|-[\\p{L}\\p{N}])";

/** 关键词 + 可选序号 + 可选标题。阿拉伯数字后可带序数标记（1º、1ª、1°），
 *  也可带欧洲葡语写法的句点（1.º、2.ª）；有序数标记时不回退成“序号 1 + 分隔符 .”，
 *  因此 “Capítulo 1.º” 不会被读成标题为 “º” 的章节。
 *  标题可用分隔符（: . – — 或后面带空白的 -）接在序号后，也可只用空白（Chapter 12 The Storm）；
 *  分隔符记在 separator 组，供句子判断区分。 */
const KEYWORD_HEADING = new RegExp(
  `^(?:(?<numbered>${alternation(NUMBERED_KEYWORDS)})|(?<standalone>${alternation(STANDALONE_KEYWORDS)}))` +
    `(?:\\s+(?<number>\\d{1,4}(?:\\.?[ºª°]|(?!\\.?[ºª°]))|${ROMAN_NUMERAL}|${NUMBER_WORD})${NUMBER_END})?` +
    `(?:(?<separator>\\s*[:.–—]|\\s*-(?=\\s|$))(?<separated>.*)|(?<loose>\\s+.+))?$`,
  "iu",
);

/** 标题部分至少这么多个词、又以句号结尾时，按正文句子处理。 */
const SENTENCE_MIN_WORDS = 3;

/** 以单个句号结尾（可带收尾引号、括号）；? ! … 与 ... 是常见的标题结尾，不算。 */
const FINAL_PERIOD = /(?<!\.)\.["'”’»)\]]*$/u;

/** 序号后的标题部分读起来像句子。任何分隔符后，首个字母小写都是正文
 *  （“leia antes de dormir.”、“e então ela partiu”）。只有 . 或空白分隔时，
 *  多个词并以单个句号结尾才是正文（“Era a última página.”）；: – — - 之后是标题
 *  （“Quem Matou Laura?”、“O Fim do Mundo.”）。 */
function looksLikeSentence(
  remainder: string,
  separator: string | undefined,
): boolean {
  const text = remainder.trim();
  if (!text) return false;
  if (/^[^\p{L}\p{N}]*\p{Ll}/u.test(text)) return true;
  if (separator !== undefined && separator.trim() !== ".") return false;
  return (
    FINAL_PERIOD.test(text) && text.split(/\s+/u).length >= SENTENCE_MIN_WORDS
  );
}

function withoutDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "");
}

/** 按关键词语法解析一行；不是关键词标题时返回 null。
 *  number 为序号（可能为空），title 为序号后的标题部分（可能为空）。 */
function parseKeywordHeading(
  line: string,
): { number: string | undefined; title: string } | null {
  const match = KEYWORD_HEADING.exec(withoutDiacritics(line));
  const groups = match?.groups;
  if (!groups) return null;
  const number = groups.number;
  if (groups.numbered && !number) return null;
  // 罗马数字只接受大写，避免 "Book I read" 之类的英文句子。
  if (
    number &&
    /^[mdclxvi]+$/iu.test(number) &&
    number !== number.toUpperCase()
  )
    return null;
  // 只用空白接标题时必须先有序号（“Prólogo de uma vida” 是句子）。
  if (groups.loose !== undefined && !number) return null;
  const title = groups.separated ?? groups.loose ?? "";
  // 标题部分像句子时，这一行是正文：“Capítulo 3 do livro anterior…”、
  // “Capítulo 3. Era a última página.”、“Livro 1: leia antes de dormir.”
  if (looksLikeSentence(title, groups.separator)) return null;
  return { number, title: title.trim() };
}

function exceedsCodePoints(value: string, limit: number): boolean {
  if (value.length <= limit) return false;
  if (value.length > limit * 2) return true;
  return [...value].length > limit;
}

/** Markdown 标题的章名只保留文字：去掉整体包裹的 ** / __ / * / _ 强调，以及
 *  导出工具重复写入的标题标记（“# **Chapter 4**” → “Chapter 4”）。
 *  只清理标题文字，不影响正文；清理后为空时保留原文。 */
function cleanMarkdownHeadingTitle(title: string): string {
  let current = title;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = (EMPHASIS_WRAPPED.exec(current)?.[2] ?? current)
      .replace(/^#{1,6}[ \t]+/u, "")
      .trim();
    if (next === current) break;
    current = next;
  }
  return current || title;
}

/** 关键词标题的候选文本：超过长度上限时为 null，否则去掉 ** / _ 强调包裹。 */
function keywordCandidate(trimmed: string): string | null {
  if (exceedsCodePoints(trimmed, HEADING_MAX_CHARACTERS)) return null;
  return EMPHASIS_WRAPPED.exec(trimmed)?.[2] ?? trimmed;
}

/** 判断一行是否为章节标题。keyword 为 true 表示由新增的 pt / es / en 关键词语法识别。
 *  场景分隔符（#、# # #、***、* * *、⁂）在任何格式下都不是标题，最先排除；
 *  既有形式（Markdown、第 N 章、Chapter + 数字）先于长度上限判断，保持原有切分；
 *  长度上限、强调包裹与关键词语法只作用于新增的标题形式。 */
function classifyHeading(
  line: string,
): { title: string; keyword: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed || SCENE_BREAK.test(trimmed)) return null;
  const markdown = MARKDOWN_HEADING.exec(line);
  if (markdown) {
    const raw = markdown[1]!.trimEnd();
    // “# ***”“## ⁂” 是套了标题标记的场景分隔符，同样按正文保留。
    return SCENE_BREAK.test(raw)
      ? null
      : { title: cleanMarkdownHeadingTitle(raw), keyword: false };
  }
  if (LEGACY_HEADING.test(trimmed)) return { title: trimmed, keyword: false };
  const candidate = keywordCandidate(trimmed);
  return candidate !== null && parseKeywordHeading(candidate)
    ? { title: candidate, keyword: true }
    : null;
}

/** 标题文本本身是章节标题（第 N 章、Chapter + 数字或关键词语法），而不是章名。 */
function isChapterTitle(title: string): boolean {
  if (LEGACY_HEADING.test(title)) return true;
  const candidate = keywordCandidate(title.trim());
  return candidate !== null && parseKeywordHeading(candidate) !== null;
}

/** 只有关键词与序号、没有章名的标题，如 “Capítulo 1”“Chapter 1”“Parte II”。
 *  中文“第 N 章”不在此列，保持既有行为。 */
function isBareNumberedTitle(title: string): boolean {
  const candidate = keywordCandidate(title.trim());
  const parsed = candidate === null ? null : parseKeywordHeading(candidate);
  return Boolean(parsed?.number) && !parsed!.title;
}

/** 判断一行是否为章节标题，返回标题文本；否则返回 null。 */
export function manuscriptHeadingTitle(line: string): string | null {
  return classifyHeading(line)?.title ?? null;
}

const PAGE_NUMBER = new RegExp(`^(?:\\d{1,5}|${ROMAN_NUMERAL})$`, "iu");

/** 内容只有页码（阿拉伯数字或罗马数字，可含空白）：目录条目，而不是章节正文。 */
function isPageNumberOnly(content: string): boolean {
  return (
    content.length <= 64 &&
    content
      .split(/\s+/u)
      .every((token) => token === "" || PAGE_NUMBER.test(token))
  );
}

/** 按章节标题切分正文。首个标题前的文字（扉页、题记等）在以 CJK 为主的原稿中
 *  沿用“卷首”，其他文字的原稿以作品标题命名；没有标题时整部正文作为一个分段。
 *  关键词标题下只有页码的分段是正文前的目录（常见于 PDF 转出的纯文本），直接丢弃；
 *  既有标题形式保持原有行为，不做此过滤。
 *  只有关键词与序号的标题（Capítulo 1）后面紧接一个章名标题（A Chegada）、中间没有正文时，
 *  两者合为一章，标题为 “Capítulo 1 — A Chegada”；EPUB 与 Word 常把序号与章名分成 H1 + H2。 */
export function splitManuscriptSections(
  text: string,
  fallbackTitle: string,
): ManuscriptSection[] {
  const headings: {
    start: number;
    end: number;
    title: string;
    keyword: boolean;
  }[] = [];
  for (const line of text.matchAll(/^.*$/gmu)) {
    const heading = classifyHeading(line[0]);
    if (heading)
      headings.push({
        start: line.index,
        end: line.index + line[0].length,
        ...heading,
      });
  }
  if (!headings.length) return [{ title: fallbackTitle, content: text.trim() }];
  const sections: ManuscriptSection[] = [];
  const prefix = text.slice(0, headings[0]!.start).trim();
  if (prefix)
    sections.push({
      title: isCjkManuscript(text) ? CJK_FRONT_MATTER_TITLE : fallbackTitle,
      content: prefix,
    });
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!;
    const next = headings[index + 1];
    const end = next?.start ?? text.length;
    const content = text.slice(heading.end, end).trim();
    if (
      !content &&
      next &&
      isBareNumberedTitle(heading.title) &&
      !isChapterTitle(next.title)
    ) {
      // 章名标题继承序号标题的识别方式，目录过滤因此与单独一行的序号标题一致。
      headings[index + 1] = {
        ...next,
        title:
          next.title === UNTITLED_HTML_HEADING
            ? heading.title
            : `${heading.title} — ${next.title}`,
        keyword: heading.keyword,
      };
      continue;
    }
    if (!content || (heading.keyword && isPageNumberOnly(content))) continue;
    sections.push({ title: heading.title, content });
  }
  return sections.length
    ? sections
    : [{ title: fallbackTitle, content: text.trim() }];
}

interface DocxStyle {
  name: string | null;
  basedOn: string | null;
  outlineLevel: string | null;
}

/* ---- 线性标记扫描 ----
 * 导入的 XML / HTML 可能含未闭合标签。惰性正则（<a>[\s\S]*?</a>、[^>]*）在找不到
 * 闭合标记时会从每个起点扫描到文末，成本随“出现次数 × 长度”增长；DOCX 压缩后
 * 几 KB 即可展开成这样的输入。下面的扫描只向前推进，并缓存“之后没有闭合标记”，
 * 总成本与输入长度成线性。 */

type Finder = (from: number) => RegExpExecArray | null;

/** 在 text 中从 from 起查找 pattern（须带 g 标志）的首个匹配，并缓存结果：
 *  起点单调不减时，每段文本至多扫描一次；一旦找不到，之后的查询直接返回 null。 */
function forwardFinder(text: string, pattern: RegExp): Finder {
  const regex = new RegExp(pattern.source, pattern.flags);
  let searchedFrom = -1;
  let found: RegExpExecArray | null = null;
  return (from) => {
    if (
      searchedFrom < 0 ||
      from < searchedFrom ||
      (found !== null && from > found.index)
    ) {
      regex.lastIndex = from;
      found = regex.exec(text);
      searchedFrom = from;
    }
    return found;
  };
}

interface ElementPattern {
  /** 匹配 "<name"（须带 g 标志与词边界），不含属性与 ">"。 */
  open: RegExp;
  /** 该开始标签对应的结束标签（须带 g 标志）；同一种结束标签须返回同一对象。 */
  close: (open: RegExpExecArray) => RegExp;
  /** true 时跳过自闭合开始标签；false 与旧正则的 <name[^>]*> 一致，视作开始标签。 */
  skipSelfClosing: boolean;
  /** 元素体的最大长度（UTF-16 码元）；超过时不视为元素，留给后续按普通标签处理。 */
  maxBody?: number;
}

interface MarkupElement {
  start: number;
  end: number;
  open: RegExpExecArray;
  /** "<name" 与 ">" 之间的属性文本。 */
  attributes: string;
  body: string;
}

/** 依次产出不重叠的 <name …>body</name> 元素，语义同惰性正则的逐个匹配：
 *  开始标签到其后第一个 ">"，元素体到其后第一个结束标签。缺少 ">" 或结束标签时，
 *  该处及之后同类元素都不再匹配，文本原样保留。 */
function* markupElements(
  text: string,
  pattern: ElementPattern,
): Generator<MarkupElement> {
  const nextOpen = forwardFinder(text, pattern.open);
  const nextTagEnd = forwardFinder(text, />/gu);
  const closers = new Map<RegExp, Finder>();
  let from = 0;
  for (;;) {
    const open = nextOpen(from);
    if (!open) return;
    const attributesStart = open.index + open[0].length;
    const tagEnd = nextTagEnd(attributesStart);
    if (!tagEnd) return;
    const bodyStart = tagEnd.index + 1;
    from = bodyStart;
    if (pattern.skipSelfClosing && text[tagEnd.index - 1] === "/") continue;
    const closeRegex = pattern.close(open);
    let nextClose = closers.get(closeRegex);
    if (!nextClose) {
      nextClose = forwardFinder(text, closeRegex);
      closers.set(closeRegex, nextClose);
    }
    const close = nextClose(bodyStart);
    if (!close || close.index - bodyStart > (pattern.maxBody ?? Infinity))
      continue;
    const end = close.index + close[0].length;
    yield {
      start: open.index,
      end,
      open,
      attributes: text.slice(attributesStart, tagEnd.index),
      body: text.slice(bodyStart, close.index),
    };
    from = end;
  }
}

function replaceElements(
  text: string,
  pattern: ElementPattern,
  replace: (element: MarkupElement) => string,
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const element of markupElements(text, pattern)) {
    parts.push(text.slice(cursor, element.start), replace(element));
    cursor = element.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** "<" 之后是字母、/、!、? 时才开始一个标签（同 HTML 分词规则），否则按文本保留，
 *  例如未转义的 "a < b"。# 只用于 DOCX 转换内部的标题标记。 */
function startsTag(text: string, index: number): boolean {
  const next = text.charCodeAt(index + 1);
  return (
    (next >= 0x41 && next <= 0x5a) ||
    (next >= 0x61 && next <= 0x7a) ||
    next === 0x2f ||
    next === 0x21 ||
    next === 0x3f ||
    next === 0x23
  );
}

/** 把标记切成文本与标签：标签从 "<" 到其后第一个 ">"（同 /<[^>]+>/）。
 *  之后再没有 ">" 时，余下内容全部按文本处理。 */
function forEachMarkupToken(
  text: string,
  onText: (value: string) => void,
  onTag: (value: string) => void,
): void {
  let cursor = 0;
  let search = 0;
  for (;;) {
    const start = text.indexOf("<", search);
    if (start < 0) break;
    if (!startsTag(text, start)) {
      search = start + 1;
      continue;
    }
    const end = text.indexOf(">", start + 1);
    if (end < 0) break;
    if (start > cursor) onText(text.slice(cursor, start));
    onTag(text.slice(start, end + 1));
    cursor = search = end + 1;
  }
  if (cursor < text.length) onText(text.slice(cursor));
}

function mapTags(text: string, tagText: (tag: string) => string): string {
  const parts: string[] = [];
  forEachMarkupToken(
    text,
    (value) => parts.push(value),
    (tag) => {
      const value = tagText(tag);
      if (value) parts.push(value);
    },
  );
  return parts.join("");
}

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/u.test(char);
}

/** 读取 name="value" 或 name='value'。值在与开引号相同的引号处结束，
 *  因此 alt="Sant'Ana" 与 alt='O "Farol"' 保留完整文字。 */
function attributeValue(source: string, name: string): string | null {
  const needle = `${name}=`;
  for (
    let at = source.indexOf(needle);
    at >= 0;
    at = source.indexOf(needle, at + 1)
  ) {
    if (isWordCharacter(source[at - 1])) continue;
    const quote = source[at + needle.length];
    if (quote !== '"' && quote !== "'") continue;
    const valueStart = at + needle.length + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    // 其后再没有同样的引号时，值一直未闭合，后面的同名属性都在值里面。
    return valueEnd < 0 ? null : source.slice(valueStart, valueEnd);
  }
  return null;
}

/** 第一个带 w:val 的 <tag …> 的值，语义同 /<tag\b[^>]*?\bw:val=(["'])(.*?)\1/。 */
function xmlValue(xml: string, tag: string): string | null {
  const needle = `<${tag}`;
  let at = xml.indexOf(needle);
  while (at >= 0) {
    const nameEnd = at + needle.length;
    if (isWordCharacter(xml[nameEnd])) {
      at = xml.indexOf(needle, nameEnd);
      continue;
    }
    const tagEnd = xml.indexOf(">", nameEnd);
    const value = attributeValue(
      xml.slice(nameEnd, tagEnd < 0 ? xml.length : tagEnd),
      "w:val",
    );
    if (value !== null) return value;
    if (tagEnd < 0) return null;
    // 同一 ">" 之前的后续开始标签只是本标签属性文本的后缀，不会有新的匹配。
    at = xml.indexOf(needle, tagEnd + 1);
  }
  return null;
}

const DOCX_STYLE_CLOSE = /<\/w:style>/gu;
const DOCX_STYLE: ElementPattern = {
  open: /<w:style\b/gu,
  close: () => DOCX_STYLE_CLOSE,
  skipSelfClosing: true,
};

function parseDocxStyles(stylesXml: string | null): Map<string, DocxStyle> {
  const styles = new Map<string, DocxStyle>();
  if (!stylesXml) return styles;
  for (const style of markupElements(stylesXml, DOCX_STYLE)) {
    const type = attributeValue(style.attributes, "w:type");
    const id = attributeValue(style.attributes, "w:styleId");
    if (!id || (type && type !== "paragraph")) continue;
    styles.set(id, {
      name: xmlValue(style.body, "w:name"),
      basedOn: xmlValue(style.body, "w:basedOn"),
      outlineLevel: xmlValue(style.body, "w:outlineLvl"),
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

const DOCX_PPR_CHANGE_CLOSE = /<\/w:pPrChange>/gu;
const DOCX_PPR_CLOSE = /<\/w:pPr>/gu;
/** 段落属性的修订记录保存的是旧属性：先整体移除，避免其中嵌套的 <w:pPr> 被当作现行属性。 */
const DOCX_PPR_CHANGE: ElementPattern = {
  open: /<w:pPrChange\b/gu,
  close: () => DOCX_PPR_CHANGE_CLOSE,
  skipSelfClosing: true,
};
const DOCX_PPR: ElementPattern = {
  open: /<w:pPr\b/gu,
  close: () => DOCX_PPR_CLOSE,
  skipSelfClosing: true,
};
/** 标题段落在属性位置留下的内部标记。XML 名称不能以 # 开头，合法文档里不会出现。 */
const DOCX_HEADING_MARK = /^<#([1-3])>$/u;
const DOCX_TITLE_PAGE_MARK = "<#t>";

function docxTagText(tag: string): string {
  // 先按首字符分流，绝大多数标签（w:r、w:t、w:rPr…）不必逐个正则比较。
  const first = tag[1] === "/" ? tag[4] : tag[3];
  if (first === "t" || first === "T") {
    if (/^<w:tab\b[^>]*\/>$/iu.test(tag)) return "\t";
    if (/^<\/w:tr>$/iu.test(tag)) return "\n";
    if (/^<\/w:tc>$/iu.test(tag)) return "\t";
  } else if (
    (first === "b" || first === "B") &&
    /^<w:br\b[^>]*\/>$/iu.test(tag)
  )
    return "\n";
  return "";
}

/** 把 DOCX 正文转为纯文本；标题样式或大纲级别 0–2 的段落加 Markdown 标题前缀。
 *  前缀在段落结束时才决定：空标题段落不加前缀，套了标题样式的场景分隔符
 *  （#、***、* * *、⁂）按正文保留。作者自己的 # 段落从不删除。 */
export function docxDocumentText(
  documentXml: string,
  stylesXml: string | null,
): string {
  const styles = parseDocxStyles(stylesXml);
  const marked = replaceElements(
    replaceElements(documentXml, DOCX_PPR_CHANGE, () => ""),
    DOCX_PPR,
    ({ body }) => {
      const style = xmlValue(body, "w:pStyle");
      if (
        style === DOCX_TITLE_PAGE_STYLE ||
        style === LEGACY_DOCX_TITLE_PAGE_STYLE
      )
        return DOCX_TITLE_PAGE_MARK;
      const level = paragraphHeadingLevel(body, styles);
      return level === null ? "" : `<#${level}>`;
    },
  );
  const parts: string[] = [];
  let heading: { level: number; index: number } | null = null;
  let skippingTitlePage = false;
  const closeHeading = () => {
    if (!heading) return;
    const content = parts.splice(heading.index).join("");
    const visible = decodeXml(content).trim();
    parts.push(
      visible && !SCENE_BREAK.test(visible)
        ? `\n${"#".repeat(heading.level)} ${content.trimStart()}`
        : content,
    );
    heading = null;
  };
  forEachMarkupToken(
    marked,
    (value) => {
      if (!skippingTitlePage) parts.push(value);
    },
    (tag) => {
      if (tag === DOCX_TITLE_PAGE_MARK) {
        closeHeading();
        skippingTitlePage = true;
        return;
      }
      const mark = tag[1] === "#" ? DOCX_HEADING_MARK.exec(tag) : null;
      if (mark) {
        closeHeading();
        heading = { level: Number(mark[1]), index: parts.length };
      } else if (tag.length === 6 && /^<\/w:p>$/iu.test(tag)) {
        if (skippingTitlePage) {
          skippingTitlePage = false;
          return;
        }
        closeHeading();
        parts.push("\n\n");
      } else if (!skippingTitlePage) {
        const value = docxTagText(tag);
        if (value) parts.push(value);
      }
    },
  );
  closeHeading();
  return decodeXml(parts.join(""));
}

const HTML_HEAD_CLOSE = /<\/head>/giu;
const HTML_SCRIPT_CLOSE = /<\/script>/giu;
const HTML_STYLE_CLOSE = /<\/style>/giu;
/** 与各自开始标签配对移除的元素：文档头（含 <title>）、脚本与样式。 */
const HTML_REMOVED_ELEMENTS: readonly ElementPattern[] = [
  { open: /<head\b/giu, close: () => HTML_HEAD_CLOSE, skipSelfClosing: false },
  {
    open: /<script\b/giu,
    close: () => HTML_SCRIPT_CLOSE,
    skipSelfClosing: false,
  },
  {
    open: /<style\b/giu,
    close: () => HTML_STYLE_CLOSE,
    skipSelfClosing: false,
  },
];
const HTML_HEADING_CLOSE = [
  /<\/h1\s*>/giu,
  /<\/h2\s*>/giu,
  /<\/h3\s*>/giu,
] as const;
/** 标题标记内容上限。超长或未闭合的标题不作标题处理：开始标签只断段，
 *  其中文字作为普通段落保留（独占一行的关键词标题仍会被逐行识别）。 */
const HTML_HEADING: ElementPattern = {
  open: /<h([1-3])\b/giu,
  close: (open) => HTML_HEADING_CLOSE[Number(open[1]) - 1]!,
  skipSelfClosing: false,
  maxBody: 2000,
};
/** 只有图片、图片又没有 alt 文字的标题（常见于 EPUB 的图片章首）使用的中性标题，
 *  以保留章节边界；它不属于任何语言，作者可在预览后改名。 */
export const UNTITLED_HTML_HEADING = "§";
const HTML_IMAGE_TAG = /^<(?:img|image|svg)\b/iu;

function htmlTagText(tag: string): string {
  // 先按首字符分流，多数标签不必逐个正则比较。
  const first = tag[1];
  if (first === "/") {
    if (/^<\/(?:h[1-6]|p|div|li|blockquote)>$/iu.test(tag)) return "\n\n";
  } else if (first === "h" || first === "H") {
    if (/^<h[1-3]\b[^>]*>$/iu.test(tag)) return "\n\n";
  } else if ((first === "b" || first === "B") && /^<br\s*\/?>$/iu.test(tag))
    return "\n";
  return "";
}

/** 标题元素的标题文字：可见文字优先；没有文字时用其中图片的 alt；
 *  只有无 alt 的图片时用中性标题；什么都没有时返回空串。 */
function htmlHeadingTitle(body: string): string {
  const alts: string[] = [];
  let hasImage = false;
  const text = mapTags(body, (tag) => {
    if (HTML_IMAGE_TAG.test(tag)) {
      hasImage = true;
      const alt = attributeValue(tag, "alt");
      if (alt) alts.push(alt);
    }
    return " ";
  });
  const title = (value: string) => value.replace(/\s+/gu, " ").trim();
  return (
    title(text) ||
    title(alts.join(" ")) ||
    (hasImage ? UNTITLED_HTML_HEADING : "")
  );
}

export function htmlToText(html: string): string {
  let text = html;
  for (const pattern of HTML_REMOVED_ELEMENTS)
    text = replaceElements(text, pattern, () => "");
  text = replaceElements(text, HTML_HEADING, ({ open, body }) => {
    const title = htmlHeadingTitle(body);
    if (!title) return "";
    // 套了标题标记的场景分隔符（* * *、⁂）按正文段落保留。
    if (SCENE_BREAK.test(decodeXml(title))) return `\n\n${title}\n\n`;
    return `\n\n${"#".repeat(Number(open[1]))} ${title}\n\n`;
  });
  return decodeXml(mapTags(text, htmlTagText));
}

/** 去掉每行行尾的空格与制表符。逐行从尾部回扫，线性时间；
 *  /[ \t]+$/gm 在长空白串上会从每个起点重扫，是平方级。 */
export function trimLineEnds(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let end = line.length;
      while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t"))
        end -= 1;
      return end === line.length ? line : line.slice(0, end);
    })
    .join("\n");
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
function isCjkManuscript(text: string): boolean {
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

/** Style candidate built from reproducible statistics of the imported text.
 *  CJK prose is measured in characters with Chinese wording; other scripts are
 *  measured in words, with sentence ends at . and … as well.
 *
 *  Language policy (deliberately unlike the labels): staged-candidate titles,
 *  default relations and import notes follow the project language (see
 *  importNoteLabels and narrative's IMPORT_STAGE_LABELS). These rules follow
 *  the manuscript instead, because the unit (character or word) depends on it:
 *  CJK manuscripts read Chinese, Portuguese manuscripts Portuguese, and every
 *  other one English. AI style candidates are written by the model in the
 *  manuscript language and are not bound by this. */
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
  const dialogueHeavy = dialogueMarks > totalWords / 20;
  if (detectManuscriptLanguage(text) === "Portuguese") {
    return {
      name: "Estilo pelas estatísticas do original",
      description:
        "Gerado a partir de estatísticas verificáveis do texto importado; revise antes de adotar.",
      rules: [
        `As frases têm em média cerca de ${averageSentence} palavras; evite se afastar muito disso sem querer`,
        `Os parágrafos têm em média cerca de ${averageParagraph} palavras; ajuste ao ritmo da cena em vez de copiar mecanicamente`,
        dialogueHeavy
          ? "O diálogo tem bastante peso; preserve a voz dos personagens e o subtexto"
          : "A narração predomina; o diálogo carrega só a ação necessária",
      ],
      negativeRules: [
        "Não copiar frases do original",
        "Não tratar traços estatísticos como regras literárias imutáveis",
      ],
      examples,
      active: false,
    };
  }
  return {
    name: "Source text statistics style",
    description:
      "Generated from reproducible statistics of the imported text; review before adopting.",
    rules: [
      `Sentences run about ${averageSentence} words on average; avoid drifting far from this unintentionally`,
      `Paragraphs average about ${averageParagraph} words; adjust to scene rhythm instead of copying mechanically`,
      dialogueHeavy
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
