import type { Editor } from "@tiptap/react";

import { manuscriptEditorOf } from "../src/workspaces/studio/manuscript-editor";
import {
  markdownOffsetToPm,
  markdownToHtml,
  serializeDoc,
} from "../src/workspaces/studio/manuscript-markdown";

function manuscriptOf(element: HTMLElement): Editor {
  const editor = manuscriptEditorOf(element);
  if (!editor) throw new Error("TipTap editor is not bound to this node");
  return editor;
}

export function manuscriptMarkdown(element: HTMLElement): string {
  return serializeDoc(manuscriptOf(element).state.doc).markdown;
}

export function setManuscriptMarkdown(
  element: HTMLElement,
  markdown: string,
): void {
  manuscriptOf(element).commands.setContent(markdownToHtml(markdown));
}

export function selectManuscriptRange(
  element: HTMLElement,
  start: number,
  end: number,
): void {
  const editor = manuscriptOf(element);
  const map = serializeDoc(editor.state.doc);
  const from = markdownOffsetToPm(map, start);
  const to = markdownOffsetToPm(map, Math.max(start, end));
  editor.commands.setTextSelection({ from, to: Math.max(from, to) });
}
