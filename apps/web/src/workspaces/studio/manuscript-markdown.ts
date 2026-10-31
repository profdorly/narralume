import type { Node as PmNode } from "@tiptap/pm/model";

export interface ProposalRange {
  id?: string;
  from: number;
  to: number;
}

export interface MarkdownCounts {
  words: number;
  characters: number;
}

export function countMarkdown(markdown: string): MarkdownCounts {
  const characters = markdown.length;
  const words = markdown.trim() ? markdown.trim().split(/\s+/).length : 0;
  return { words, characters };
}

export function markdownToHtml(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized) return "<p></p>";
  return normalized
    .split(/\n{2,}/)
    .map((block) => {
      const heading = /^(#{1,3})\s+([\s\S]*)$/.exec(block);
      if (heading) {
        const level = heading[1]!.length;
        return `<h${level}>${inlineToHtml(heading[2] ?? "")}</h${level}>`;
      }
      return `<p>${inlineToHtml(block).replaceAll("\n", "<br>")}</p>`;
    })
    .join("");
}

function inlineToHtml(value: string): string {
  const escaped = value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return escaped
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");
}

interface OffsetMap {
  markdown: string;
  /** markdown offset → ProseMirror position */
  pmAt: number[];
}

export function serializeDoc(doc: PmNode): OffsetMap {
  let markdown = "";
  const pmAt: number[] = [];
  const emit = (chunk: string, pmPos: number) => {
    for (let index = 0; index < chunk.length; index += 1) {
      pmAt.push(pmPos);
    }
    markdown += chunk;
  };

  doc.forEach((block, offset) => {
    // `offset` is where the block starts; its text starts at `offset + 1`.
    // The separator maps to the end of the previous block, so a selection
    // that ends a paragraph stops right after its last character.
    if (markdown) emit("\n\n", Math.max(1, offset - 1));
    const pos = offset + 1;
    if (block.type.name === "heading") {
      const level = Math.min(3, Math.max(1, Number(block.attrs.level ?? 1)));
      emit(`${"#".repeat(level)} `, pos);
      emitInline(block, pos, emit);
      return;
    }
    emitInline(block, pos, emit);
  });

  return { markdown: markdown.replace(/\u00a0/g, " "), pmAt };
}

function emitInline(
  node: PmNode,
  startPos: number,
  emit: (chunk: string, pmPos: number) => void,
) {
  node.forEach((child, offset) => {
    const pos = startPos + offset;
    if (child.type.name === "hardBreak") {
      emit("\n", pos);
      return;
    }
    const text = child.text ?? "";
    const marks = child.marks.map((mark) => mark.type.name);
    const wrap =
      marks.includes("bold") && marks.includes("italic")
        ? "***"
        : marks.includes("bold")
          ? "**"
          : marks.includes("italic")
            ? "*"
            : "";
    if (wrap) emit(wrap, pos);
    for (let index = 0; index < text.length; index += 1) {
      emit(text[index]!, pos + index);
    }
    if (wrap) emit(wrap, pos + Math.max(0, text.length - 1));
  });
}

export function markdownOffsetToPm(map: OffsetMap, offset: number): number {
  if (map.pmAt.length === 0) return 1;
  // An offset at the end of the text points just after the last character.
  if (offset >= map.pmAt.length) return (map.pmAt[map.pmAt.length - 1] ?? 0) + 1;
  const index = Math.max(0, offset);
  return map.pmAt[index] ?? 1;
}

