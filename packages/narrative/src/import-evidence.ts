import { sha256Hex } from "@narralume/domain";

/** A document import candidate as import analysis reads it. */
export interface ImportSourceDocument {
  id: string;
  title: string;
  payload: Record<string, unknown>;
}

/** Where one document candidate sits in the concatenated import text. */
export interface ImportDocumentSpan {
  documentCandidateId: string;
  /** UTF-16 offsets into the concatenated text; end is exclusive. */
  start: number;
  end: number;
}

export interface ImportSourceText {
  text: string;
  spans: readonly ImportDocumentSpan[];
}

/**
 * The text import analysis reads and cites paragraphs from: every document
 * candidate as `# title\ncontent`, in candidate order, separated by a blank
 * line, together with each candidate's span. The blank line always ends a
 * paragraph, so a located paragraph never crosses two documents.
 */
export function importSourceText(
  documents: readonly ImportSourceDocument[],
): ImportSourceText {
  let text = "";
  const spans: ImportDocumentSpan[] = [];
  documents.forEach((document, index) => {
    if (index > 0) text += "\n\n";
    const start = text.length;
    const content = document.payload.content;
    text += `# ${document.title}\n${typeof content === "string" ? content : ""}`;
    spans.push({ documentCandidateId: document.id, start, end: text.length });
  });
  return { text, spans };
}

/** The document candidate whose span contains the offset, if any. */
export function documentCandidateAt(
  spans: readonly ImportDocumentSpan[],
  offset: number,
): string | null {
  return (
    spans.find((span) => offset >= span.start && offset < span.end)
      ?.documentCandidateId ?? null
  );
}

/**
 * The document candidates an import candidate's located evidence cites.
 * Evidence staged since the chapter was recorded carries
 * `documentCandidateId`; older evidence is placed by its offsets, but only
 * when its content hash proves the offsets refer to this very text. Evidence
 * that cannot be placed is returned as null.
 */
export function importEvidenceDocuments(
  evidence: unknown,
  source: () => ImportSourceText,
): Array<string | null> {
  if (!Array.isArray(evidence)) return [];
  let sourceHash: string | null = null;
  return evidence.map((item) => {
    if (!isRecord(item)) return null;
    if (typeof item.documentCandidateId === "string") {
      return item.documentCandidateId;
    }
    if (typeof item.start !== "number" || typeof item.contentHash !== "string")
      return null;
    const located = source();
    sourceHash ??= sha256Hex(located.text);
    return item.contentHash === sourceHash
      ? documentCandidateAt(located.spans, item.start)
      : null;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
