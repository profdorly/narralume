import { estimateTokens } from "@narralume/context";

/**
 * A slice of a manuscript version used as one retrieval segment. `start` and
 * `end` are offsets into the source text, so a passage can always be traced
 * back to the exact version it was cut from.
 */
export interface ManuscriptPassage {
  readonly ordinal: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface PassageChunkOptions {
  /** Preferred passage size in estimated tokens. */
  readonly targetTokens?: number;
  /** Hard ceiling; longer paragraphs are split at sentence boundaries. */
  readonly maxTokens?: number;
}

export const PASSAGE_TARGET_TOKENS = 380;
export const PASSAGE_MAX_TOKENS = 560;

/* "* * *", "***", "⁂", "#", "---", "~~~", "· · ·" on their own line. */
const SCENE_BREAK =
  /^\s*(?:(?:[*•·~⁂]\s*)+|#{1,3}|-{3,}|_{3,}|(?:-\s+){2,}-)\s*$/u;
const SENTENCE_END = /[.!?…。！？]["'”’»)\]]*\s+/gu;

interface Span {
  start: number;
  end: number;
}

/**
 * Splits a chapter into passages of roughly `targetTokens`, never crossing a
 * scene break. Paragraphs are kept whole when they fit; a paragraph larger
 * than `maxTokens` is split at sentence ends (or whitespace as a last resort).
 * Chunking is deterministic, and an edit only reshapes the passages of the
 * scene it touched, so unchanged scenes keep their passages (and vectors).
 */
export function chunkManuscript(
  content: string,
  options: PassageChunkOptions = {},
): ManuscriptPassage[] {
  const target = Math.max(32, options.targetTokens ?? PASSAGE_TARGET_TOKENS);
  const max = Math.max(target, options.maxTokens ?? PASSAGE_MAX_TOKENS);
  const passages: Span[] = [];
  for (const scene of scenes(content)) {
    const pieces = scene.flatMap((paragraph) =>
      estimateTokens(content.slice(paragraph.start, paragraph.end)) > max
        ? splitLongParagraph(content, paragraph, max)
        : [paragraph],
    );
    const scenePassages: Span[] = [];
    let current: Span | null = null;
    for (const piece of pieces) {
      if (!current) {
        current = { ...piece };
        continue;
      }
      const merged = estimateTokens(content.slice(current.start, piece.end));
      if (merged <= target) {
        current.end = piece.end;
      } else {
        scenePassages.push(current);
        current = { ...piece };
      }
    }
    if (current) {
      const previous = scenePassages[scenePassages.length - 1];
      // Fold a short tail into the previous passage when it still fits.
      if (
        previous &&
        estimateTokens(content.slice(current.start, current.end)) <
          target / 4 &&
        estimateTokens(content.slice(previous.start, current.end)) <= max
      ) {
        previous.end = current.end;
      } else {
        scenePassages.push(current);
      }
    }
    passages.push(...scenePassages);
  }
  return passages.map((span, ordinal) => ({
    ordinal,
    text: content.slice(span.start, span.end),
    start: span.start,
    end: span.end,
  }));
}

/** Paragraph spans grouped by scene; scene-break lines are dropped. */
function scenes(content: string): Span[][] {
  const result: Span[][] = [];
  let scene: Span[] = [];
  const separator = /\n[ \t]*\n/gu;
  let cursor = 0;
  const flush = (start: number, end: number) => {
    const raw = content.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const span = { start: start + leading, end: end - trailing };
    if (span.end <= span.start) return;
    if (SCENE_BREAK.test(content.slice(span.start, span.end))) {
      if (scene.length > 0) result.push(scene);
      scene = [];
      return;
    }
    scene.push(span);
  };
  for (const match of content.matchAll(separator)) {
    flush(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  flush(cursor, content.length);
  if (scene.length > 0) result.push(scene);
  return result;
}

function splitLongParagraph(
  content: string,
  paragraph: Span,
  max: number,
): Span[] {
  const sentences: Span[] = [];
  const text = content.slice(paragraph.start, paragraph.end);
  let cursor = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    sentences.push({
      start: paragraph.start + cursor,
      end: paragraph.start + end,
    });
    cursor = end;
  }
  if (cursor < text.length)
    sentences.push({ start: paragraph.start + cursor, end: paragraph.end });

  const pieces: Span[] = [];
  let current: Span | null = null;
  for (const sentence of sentences.flatMap((span) =>
    estimateTokens(content.slice(span.start, span.end)) > max
      ? splitAtWhitespace(content, span, max)
      : [span],
  )) {
    if (
      current &&
      estimateTokens(content.slice(current.start, sentence.end)) <= max
    ) {
      current.end = sentence.end;
    } else {
      if (current) pieces.push(current);
      current = { ...sentence };
    }
  }
  if (current) pieces.push(current);
  return pieces.map((piece) => trimSpan(content, piece));
}

function splitAtWhitespace(content: string, span: Span, max: number): Span[] {
  const pieces: Span[] = [];
  let start = span.start;
  while (start < span.end) {
    let end = start;
    // Grow by characters until the estimate reaches the ceiling.
    let low = start + 1;
    let high = span.end;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (estimateTokens(content.slice(start, middle)) <= max) {
        end = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (end <= start) end = Math.min(span.end, start + 1);
    if (end < span.end) {
      const space = content.lastIndexOf(" ", end);
      if (space > start) end = space + 1;
    }
    pieces.push({ start, end });
    start = end;
  }
  return pieces;
}

function trimSpan(content: string, span: Span): Span {
  const raw = content.slice(span.start, span.end);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  return { start: span.start + leading, end: span.end - trailing };
}
