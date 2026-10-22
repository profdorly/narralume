import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";

import {
  countMarkdown,
  markdownOffsetToPm,
  markdownToHtml,
  serializeDoc,
  type MarkdownCounts,
  type ProposalRange,
} from "./manuscript-markdown";

const proposalPluginKey = new PluginKey<DecorationSet>("manuscript-proposals");
const editorsByDom = new WeakMap<HTMLElement, Editor>();

/** Test helper: TipTap instance bound to the contenteditable node. */
export function manuscriptEditorOf(element: HTMLElement): Editor | null {
  return editorsByDom.get(element) ?? null;
}

export interface ManuscriptSelection {
  start: number;
  end: number;
}

export interface ManuscriptEditorProps {
  value: string;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  focusMode?: boolean;
  proposalRanges?: ProposalRange[];
  onChange: (markdown: string) => void;
  onSelect: (selection: ManuscriptSelection) => void;
  onCounts?: (counts: MarkdownCounts) => void;
  onUpdate?: (markdown: string) => void;
}

export function ManuscriptEditor({
  value,
  placeholder,
  ariaLabel,
  className,
  focusMode = false,
  proposalRanges = [],
  onChange,
  onSelect,
  onCounts,
  onUpdate,
}: ManuscriptEditorProps) {
  const editorClass = [
    className ?? "studio__desk-textarea",
    focusMode ? "manuscript-editor--focus" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const counts = countMarkdown(value);
  const wordCount = counts.words;
  const characterCount = counts.characters;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        blockquote: false,
      }),
      Placeholder.configure({ placeholder }),
    ],
    immediatelyRender: false,
    content: markdownToHtml(value),
    editorProps: {
      attributes: editorAttributes(editorClass, ariaLabel, counts, focusMode),
    },
    onCreate: ({ editor: instance }) => {
      editorsByDom.set(instance.view.dom, instance);
    },
    onUpdate: ({ editor: instance }) => {
      const map = serializeDoc(instance.state.doc);
      onChange(map.markdown);
      onUpdate?.(map.markdown);
      onCounts?.(countMarkdown(map.markdown));
    },
    onSelectionUpdate: ({ editor: instance }) => {
      const map = serializeDoc(instance.state.doc);
      const { from, to } = instance.state.selection;
      const start = pmPosToMarkdownOffsetSafe(map, from);
      const end = pmPosToMarkdownOffsetSafe(map, to);
      onSelect({ start, end: Math.max(start, end) });
    },
  });

  useEffect(() => {
    if (!editor) return;
    editorsByDom.set(editor.view.dom, editor);
    return () => {
      editorsByDom.delete(editor.view.dom);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const plugin = new Plugin({
      key: proposalPluginKey,
      state: {
        init: (_, state) => proposalDecorations(state.doc, []),
        apply: (tr, set) => {
          const next = tr.getMeta(proposalPluginKey) as ProposalRange[] | undefined;
          if (next) return proposalDecorations(tr.doc, next);
          if (tr.docChanged) return set.map(tr.mapping, tr.doc);
          return set;
        },
      },
      props: {
        decorations(state) {
          return this.getState(state);
        },
      },
    });
    editor.registerPlugin(plugin);
    return () => {
      editor.unregisterPlugin(proposalPluginKey);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const current = serializeDoc(editor.state.doc).markdown;
    if (current === value) return;
    editor.commands.setContent(markdownToHtml(value), { emitUpdate: false });
    onCounts?.(countMarkdown(value));
  }, [editor, onCounts, value]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(proposalPluginKey, proposalRanges),
    );
  }, [editor, proposalRanges]);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: {
        attributes: editorAttributes(
          editorClass,
          ariaLabel,
          { words: wordCount, characters: characterCount },
          focusMode,
        ),
      },
    });
  }, [ariaLabel, characterCount, editor, editorClass, focusMode, wordCount]);

  useEffect(() => {
    onCounts?.({ words: wordCount, characters: characterCount });
  }, [characterCount, onCounts, wordCount]);

  return <EditorContent editor={editor} />;
}

function editorAttributes(
  className: string,
  ariaLabel: string,
  counts: MarkdownCounts,
  focusMode: boolean,
): Record<string, string> {
  return {
    class: className,
    "aria-label": ariaLabel,
    role: "textbox",
    "aria-multiline": "true",
    "data-word-count": String(counts.words),
    "data-character-count": String(counts.characters),
    "data-focus-mode": focusMode ? "true" : "false",
  };
}

function pmPosToMarkdownOffsetSafe(
  map: ReturnType<typeof serializeDoc>,
  pmPos: number,
): number {
  const index = map.pmAt.findIndex((pos) => pos >= pmPos);
  if (index >= 0) return index;
  return map.markdown.length;
}

function proposalDecorations(
  doc: Parameters<typeof serializeDoc>[0],
  ranges: ProposalRange[],
) {
  const map = serializeDoc(doc);
  const decorations = ranges
    .filter((range) => range.to > range.from)
    .map((range) => {
      const from = markdownOffsetToPm(map, range.from);
      const last = markdownOffsetToPm(map, Math.max(range.from, range.to - 1));
      return Decoration.inline(from, Math.max(from + 1, last + 1), {
        class: "manuscript-proposal",
        "data-proposal-id": range.id ?? "",
      });
    });
  return DecorationSet.create(doc, decorations);
}
