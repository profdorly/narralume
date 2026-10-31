/** Structure detection for imported manuscripts: chapter headings, DOCX heading
 *  styles, HTML/EPUB headings and statistics style. Only pure text
 *  transformations happen here; container parsing and safety limits belong to
 *  delivery-service. */

import { detectManuscriptLanguage } from "@lapis/narrative";

interface ManuscriptSection {
  title: string;
  content: string;
}

/** Length limit (in code points) for keyword heading lines (pt / es / en, and
 *  emphasis-wrapped forms); longer lines count as body paragraphs. The existing
 *  Chinese "Chapter N" (di N zhang) and "Chapter + number" forms are not
 *  subject to this limit. */
export const HEADING_MAX_CHARACTERS = 80;
/** Paragraph style written on the exported title page so re-import can skip it. */
export const DOCX_TITLE_PAGE_STYLE = "LapisTitlePage";
/** Title page style of DOCX files exported before the rename. */
const LEGACY_DOCX_TITLE_PAGE_STYLE = "NarraLumeTitlePage";

// Heading capture uses a greedy (\S.*)$ and then trims trailing whitespace: the
// lazy (\S.*?)\s*$ is quadratic on long whitespace runs.
const MARKDOWN_HEADING = /^#{1,3}\s+(\S.*)$/u;
/** The existing heading forms, behaving as before the keyword syntax was
 *  introduced: the Chinese "di N zhang / jie / juan / bu / hui" (chapter /
 *  section / volume / part / episode) headings and "Chapter + Arabic number"
 *  (case-insensitive), with no length limit; the whole line (trimmed) is the
 *  heading, and emphasis wrapping is not recognized (a bold Chinese "Chapter
 *  One" is still body text). */
const LEGACY_HEADING =
  /^\s*(?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回]|chapter\s+\d)/iu;
const EMPHASIS_WRAPPED = /^(\*{1,2}|_{1,2})(\S(?:.*\S)?)\1$/u;
/**
 * Scene breaks on a paragraph of their own (#, ###, # # #, ***, * * *, ⁂). They
 * are body text, not headings.
 */
const SCENE_BREAK = /^(?:(?:#[ \t]*)+|(?:\*[ \t]*){3,}|⁂)$/u;

/**
 * Fixed label for text before the first heading; used only for mostly-CJK
 * manuscripts, matching existing behavior.
 */
const CJK_FRONT_MATTER_TITLE = "卷首";

/**
 * Part keywords that require a number (pt / es / en). Written in lowercase with
 * diacritics removed.
 */
const NUMBERED_KEYWORDS = [
  "capitulo",
  "chapter",
  "parte",
  "part",
  "livro",
  "libro",
  "book",
];

/** Part keywords that may appear without a number (pt / es / en). */
const STANDALONE_KEYWORDS = [
  "prologo",
  "prologue",
  "epilogo",
  "epilogue",
  "interludio",
  "interlude",
];

/** Spelled-out numbers: pt / es / en cardinals 1–20 and tens, and pt / es
 *  ordinals 1–10. Compound numbers (vinte e um, twenty-one, treinta y dos) are
 *  combined with connectors. */
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

/** A number must end at a word boundary; a hyphen joined to letters or digits
 *  is still part of the same word, so "segunda-feira" is not read as the number
 *  segunda plus the separator "-feira", and "2-3" is not the number 2. */
const NUMBER_END = "(?![\\p{L}\\p{N}]|-[\\p{L}\\p{N}])";

/** Keyword + optional number + optional title. An Arabic number may carry an
 *  ordinal marker (1º, 1ª, 1°), or the European Portuguese period form
 *  (1.º, 2.ª); with an ordinal marker it does not fall back to
 *  "number 1 + separator .", so "Capítulo 1.º" is not read as a chapter titled
 *  "º". The title may follow the number after a separator (: . – — or -
 *  followed by whitespace), or after whitespace alone (Chapter 12 The Storm);
 *  the separator is captured in the separator group, used to tell sentences
 *  apart. */
const KEYWORD_HEADING = new RegExp(
  `^(?:(?<numbered>${alternation(NUMBERED_KEYWORDS)})|(?<standalone>${alternation(STANDALONE_KEYWORDS)}))` +
    `(?:\\s+(?<number>\\d{1,4}(?:\\.?[ºª°]|(?!\\.?[ºª°]))|${ROMAN_NUMERAL}|${NUMBER_WORD})${NUMBER_END})?` +
    `(?:(?<separator>\\s*[:.–—]|\\s*-(?=\\s|$))(?<separated>.*)|(?<loose>\\s+.+))?$`,
  "iu",
);

/**
 * When the title part has at least this many words and ends with a period, it
 * is treated as a body sentence.
 */
const SENTENCE_MIN_WORDS = 3;

/**
 * Ends with a single period (optionally followed by closing quotes or
 * brackets); ? ! … and ... are common heading endings and do not count.
 */
const FINAL_PERIOD = /(?<!\.)\.["'”’»)\]]*$/u;

/** The title part after the number reads like a sentence. After any separator,
 *  a lowercase first letter means body text ("leia antes de dormir.", "e então
 *  ela partiu"). Only with a . or whitespace separator is a multi-word part
 *  ending in a single period body text ("Era a última página."); after : – — -
 *  it is a title ("Quem Matou Laura?", "O Fim do Mundo."). */
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

/** Parse a line with the keyword syntax; returns null when it is not a keyword
 *  heading. number is the number (may be empty), title is the title part after
 *  the number (may be empty). */
function parseKeywordHeading(
  line: string,
): { number: string | undefined; title: string } | null {
  const match = KEYWORD_HEADING.exec(withoutDiacritics(line));
  const groups = match?.groups;
  if (!groups) return null;
  const number = groups.number;
  if (groups.numbered && !number) return null;
  // Roman numerals are accepted only in uppercase, to avoid English sentences
  // such as "Book I read".
  if (
    number &&
    /^[mdclxvi]+$/iu.test(number) &&
    number !== number.toUpperCase()
  )
    return null;
  // A title joined only by whitespace requires a number first ("Prólogo de uma
  // vida" is a sentence).
  if (groups.loose !== undefined && !number) return null;
  const title = groups.separated ?? groups.loose ?? "";
  // When the title part looks like a sentence, the line is body text:
  // "Capítulo 3 do livro anterior…", "Capítulo 3. Era a última página.",
  // "Livro 1: leia antes de dormir."
  if (looksLikeSentence(title, groups.separator)) return null;
  return { number, title: title.trim() };
}

function exceedsCodePoints(value: string, limit: number): boolean {
  if (value.length <= limit) return false;
  if (value.length > limit * 2) return true;
  return [...value].length > limit;
}

/** Keep only the text of a Markdown heading's chapter title: remove ** / __ / *
 *  / _ emphasis wrapping the whole title, and heading markers repeated by
 *  export tools ("# **Chapter 4**" → "Chapter 4"). Only the heading text is
 *  cleaned, never the body; if nothing remains after cleaning, the original is
 *  kept. */
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

/**
 * Candidate text of a keyword heading: null when over the length limit,
 * otherwise with ** / _ emphasis wrapping removed.
 */
function keywordCandidate(trimmed: string): string | null {
  if (exceedsCodePoints(trimmed, HEADING_MAX_CHARACTERS)) return null;
  return EMPHASIS_WRAPPED.exec(trimmed)?.[2] ?? trimmed;
}

/** Decide whether a line is a chapter heading. keyword = true means it was
 *  recognized by the new pt / es / en keyword syntax. Scene breaks (#, # # #,
 *  ***, * * *, ⁂) are never headings in any format and are excluded first; the
 *  existing forms (Markdown, Chinese "Chapter N", Chapter + number) are checked
 *  before the length limit, keeping the original splitting; the length limit,
 *  emphasis wrapping and keyword syntax apply only to the new heading forms. */
function classifyHeading(
  line: string,
): { title: string; keyword: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed || SCENE_BREAK.test(trimmed)) return null;
  const markdown = MARKDOWN_HEADING.exec(line);
  if (markdown) {
    const raw = markdown[1]!.trimEnd();
    // "# ***" and "## ⁂" are scene breaks wrapped in heading markers; they are
    // also kept as body text.
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

/**
 * The heading text itself is a chapter heading (Chinese "Chapter N", Chapter +
 * number, or keyword syntax), not a chapter title.
 */
function isChapterTitle(title: string): boolean {
  if (LEGACY_HEADING.test(title)) return true;
  const candidate = keywordCandidate(title.trim());
  return candidate !== null && parseKeywordHeading(candidate) !== null;
}

/** A heading with only a keyword and number and no chapter title, such as
 *  "Capítulo 1", "Chapter 1", "Parte II". The Chinese "Chapter N" form is not
 *  included, keeping the existing behavior. */
function isBareNumberedTitle(title: string): boolean {
  const candidate = keywordCandidate(title.trim());
  const parsed = candidate === null ? null : parseKeywordHeading(candidate);
  return Boolean(parsed?.number) && !parsed!.title;
}

/**
 * Decide whether a line is a chapter heading and return the heading text;
 * otherwise return null.
 */
export function manuscriptHeadingTitle(line: string): string | null {
  return classifyHeading(line)?.title ?? null;
}

const PAGE_NUMBER = new RegExp(`^(?:\\d{1,5}|${ROMAN_NUMERAL})$`, "iu");

/**
 * Content that is only a page number (Arabic or Roman numerals, whitespace
 * allowed): a table of contents entry, not chapter text.
 */
function isPageNumberOnly(content: string): boolean {
  return (
    content.length <= 64 &&
    content
      .split(/\s+/u)
      .every((token) => token === "" || PAGE_NUMBER.test(token))
  );
}

/** Split the text by chapter headings. Text before the first heading (title
 *  page, epigraph, etc.) keeps the fixed CJK front-matter label in mostly-CJK
 *  manuscripts and is named after the work's title in other manuscripts;
 *  without headings the whole text is one segment. Segments under keyword
 *  headings that contain only page numbers are a table of contents before the
 *  text (common in plain text converted from PDF) and are dropped; the existing
 *  heading forms keep their original behavior, without this filter. When a
 *  heading with only a keyword and number (Capítulo 1) is directly followed by
 *  a chapter-title heading (A Chegada) with no text in between, the two merge
 *  into one chapter titled "Capítulo 1 — A Chegada"; EPUB and Word often split
 *  number and title into H1 + H2. */
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
      // The chapter-title heading inherits how the number heading was
      // recognized, so the TOC filter matches that of a number heading on its
      // own line.
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

/* ---- Linear markup scanning ----
 * Imported XML / HTML may contain unclosed tags. Lazy regexes (<a>[\s\S]*?</a>,
 * [^>]*) scan from every start position to the end of the text when the closing
 * markup is missing, so the cost grows as "occurrences × length"; a DOCX of a
 * few KB compressed can expand into such input. The scans below only move
 * forward and cache "no closing markup after this point", so the total cost is
 * linear in the input length. */

type Finder = (from: number) => RegExpExecArray | null;

/** Find the first match of pattern (must have the g flag) in text starting at
 *  from, caching the result: as long as the start position never decreases,
 *  each text is scanned at most once; once nothing is found, later queries
 *  return null directly. */
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
  /**
   * Matches "<name" (must have the g flag and a word boundary), without
   * attributes or ">".
   */
  open: RegExp;
  /**
   * The end tag matching this start tag (must have the g flag); the same kind
   * of end tag must return the same object.
   */
  close: (open: RegExpExecArray) => RegExp;
  /**
   * When true, skip self-closing start tags; false matches the old regex
   * <name[^>]*>, treating them as start tags.
   */
  skipSelfClosing: boolean;
  /**
   * Maximum element body length (UTF-16 code units); longer ones are not
   * treated as elements and are left for later processing as plain tags.
   */
  maxBody?: number;
}

interface MarkupElement {
  start: number;
  end: number;
  open: RegExpExecArray;
  /** Attribute text between "<name" and ">". */
  attributes: string;
  body: string;
}

/** Yields non-overlapping <name …>body</name> elements in sequence, with the
 *  same semantics as successive lazy-regex matches: the start tag runs to the
 *  first following ">", the body to the first following end tag. When the ">"
 *  or the end tag is missing, neither that element nor any later one of the
 *  same kind matches, and the text is kept as is. */
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

/** A tag starts only when "<" is followed by a letter, /, ! or ? (as in HTML
 *  tokenization); otherwise it is kept as text, for example an unescaped
 *  "a < b". # is used only for the internal heading marker of the DOCX
 *  conversion. */
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

/** Split markup into text and tags: a tag runs from "<" to the first following
 *  ">" (as /<[^>]+>/). When no ">" follows, all remaining content is treated as
 *  text. */
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

/** Read name="value" or name='value'. The value ends at the same kind of quote
 *  that opened it, so alt="Sant'Ana" and alt='O "Farol"' keep their full text.
 */
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
    // When the same quote never appears again, the value is unclosed and all
    // later attributes of the same name are inside it.
    return valueEnd < 0 ? null : source.slice(valueStart, valueEnd);
  }
  return null;
}

/**
 * The value of the first <tag …> carrying w:val, with the same semantics as
 * /<tag\b[^>]*?\bw:val=(["'])(.*?)\1/.
 */
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
    // Later start tags before the same ">" are only a suffix of this tag's
    // attribute text, so they cannot produce new matches.
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

/**
 * Outline levels 0–2 map to # through ###; deeper levels and the body text
 * level (9) do not split chapters.
 */
function outlineHeadingLevel(value: string): number | null {
  const level = Number(value);
  return Number.isInteger(level) && level >= 0 && level <= 2 ? level + 1 : null;
}

/** Word's built-in style names in styles.xml are always English (heading 1,
 *  Title); localized versions only change the styleId (e.g. Portuguese Ttulo1).
 *  Without styles.xml, decide by styleId. */
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
/**
 * Paragraph property revision records hold the old properties: remove them
 * entirely first, so a nested <w:pPr> is not taken as the current properties.
 */
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
/**
 * Internal marker a heading paragraph leaves in the property position. XML
 * names cannot start with #, so it never occurs in a valid document.
 */
const DOCX_HEADING_MARK = /^<#([1-3])>$/u;
const DOCX_TITLE_PAGE_MARK = "<#t>";

function docxTagText(tag: string): string {
  // Branch on the first character first, so most tags (w:r, w:t, w:rPr…) need
  // no regex comparison one by one.
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

/** Convert DOCX body text to plain text; paragraphs with a heading style or
 *  outline level 0–2 get a Markdown heading prefix. The prefix is decided only
 *  when the paragraph ends: empty heading paragraphs get no prefix, and scene
 *  breaks with a heading style (#, ***, * * *, ⁂) are kept as body text. The
 *  author's own # paragraphs are never removed. */
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
/**
 * Elements removed together with their start tags: the document head (including
 * <title>), scripts and styles.
 */
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
/** Content limit of heading markup. Overlong or unclosed headings are not
 *  treated as headings: the start tag only breaks the paragraph, and its text
 *  is kept as a regular paragraph (a keyword heading on its own line is still
 *  recognized line by line). */
const HTML_HEADING: ElementPattern = {
  open: /<h([1-3])\b/giu,
  close: (open) => HTML_HEADING_CLOSE[Number(open[1]) - 1]!,
  skipSelfClosing: false,
  maxBody: 2000,
};
/** Neutral title used for headings that contain only an image without alt text
 *  (common for EPUB image chapter openers), to keep the chapter boundary; it
 *  belongs to no language, and the author can rename it after the preview. */
export const UNTITLED_HTML_HEADING = "§";
const HTML_IMAGE_TAG = /^<(?:img|image|svg)\b/iu;

function htmlTagText(tag: string): string {
  // Branch on the first character first, so most tags need no regex comparison
  // one by one.
  const first = tag[1];
  if (first === "/") {
    if (/^<\/(?:h[1-6]|p|div|li|blockquote)>$/iu.test(tag)) return "\n\n";
  } else if (first === "h" || first === "H") {
    if (/^<h[1-3]\b[^>]*>$/iu.test(tag)) return "\n\n";
  } else if ((first === "b" || first === "B") && /^<br\s*\/?>$/iu.test(tag))
    return "\n";
  return "";
}

/** Title text of a heading element: visible text first; without text, the alt
 *  of an image inside it; with only images lacking alt, the neutral title; with
 *  nothing at all, an empty string. */
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
    // Scene breaks wrapped in heading markup (* * *, ⁂) are kept as body
    // paragraphs.
    if (SCENE_BREAK.test(decodeXml(title))) return `\n\n${title}\n\n`;
    return `\n\n${"#".repeat(Number(open[1]))} ${title}\n\n`;
  });
  return decodeXml(mapTags(text, htmlTagText));
}

/** Remove trailing spaces and tabs from every line. Scans back from the end of
 *  each line in linear time; /[ \t]+$/gm rescans from every start position on
 *  long whitespace runs, which is quadratic. */
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

/**
 * Samples the first 200,000 characters of the text: when CJK characters are the
 * majority of letter characters, count by character.
 */
function isCjkManuscript(text: string): boolean {
  const sample = text.slice(0, SCRIPT_SAMPLE_CHARACTERS);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  const cjk = sample.match(CJK_CHARACTER)?.length ?? 0;
  return letters === 0 || cjk * 2 >= letters;
}

type StatisticalStylePayload = {
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
  // Quoted dialogue and Portuguese / Spanish line-initial dash (travessão /
  // raya) dialogue.
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
