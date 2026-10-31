import type { ContextAuthority, ContextSource } from "@lapis/context";
import {
  DOCUMENT_PASSAGE_SOURCE,
  segmentDocumentId,
  type RetrievalHit,
} from "@lapis/persistence";

import { promptLanguageOf } from "./prompt-language.js";

/** Retrieval options of the chapter writer. */
export const RETRIEVAL_LIMIT = 8;
export const RETRIEVAL_MAX_PER_DOCUMENT = 2;

/**
 * What the chapter writer searches older chapters with. A title alone
 * ("Capítulo 41") retrieves nothing useful, so the plan fields, the chapter's
 * entities and the director notes are included, and the previous chapter's
 * summary stands in when the outline node has no plan yet.
 */
export function chapterRetrievalQuery(input: {
  title: string;
  summary?: string | null;
  goal?: string | null;
  conflict?: string | null;
  outcome?: string | null;
  entityNames?: readonly string[];
  steerNotes?: readonly string[];
  previousChapterSummary?: string | null;
}): string {
  const plan = [
    input.summary,
    input.goal,
    input.conflict,
    input.outcome,
    ...(input.steerNotes ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
  return [
    input.title,
    ...plan,
    ...(input.entityNames ?? []),
    ...(plan.length === 0 && input.previousChapterSummary?.trim()
      ? [input.previousChapterSummary]
      : []),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Turns ranked retrieval hits into context sources. Ids carry the rank so
 * the compiler, which renders sections of one kind by id, keeps them in
 * relevance order; priority also falls with rank so the weakest hits are
 * the first to go when the budget is tight.
 */
export function retrievalContextSources(
  hits: readonly RetrievalHit[],
  options: {
    idPrefix: string;
    language: string | null | undefined;
    priorityBase: number;
    authority: (hit: RetrievalHit) => ContextAuthority;
  },
): ContextSource[] {
  const english = promptLanguageOf(options.language) === "en";
  return hits.map((hit, rank) => {
    const passage =
      hit.sourceType === DOCUMENT_PASSAGE_SOURCE ? passagePosition(hit) : null;
    const title = hit.title || `${hit.sourceType}:${hit.sourceId}`;
    return {
      id: `${options.idPrefix}:${String(rank + 1).padStart(2, "0")}:${hit.id}`,
      kind: "retrieval",
      label: passage
        ? english
          ? `Retrieved passage ${rank + 1} · ${title} (passage ${passage.index} of ${passage.count})`
          : `Trecho recuperado ${rank + 1} · ${title} (trecho ${passage.index} de ${passage.count})`
        : english
          ? `Retrieved ${rank + 1} · ${title}`
          : `Recuperado ${rank + 1} · ${title}`,
      content: hit.content,
      authority: options.authority(hit),
      priority: Math.max(1, options.priorityBase - rank),
      sourceType: hit.sourceType,
      sourceId: hit.sourceId,
      metadata: {
        retrievalRank: rank + 1,
        retrievalReasons: hit.reasons,
        lexicalRank: hit.lexicalRank,
        vectorRank: hit.vectorRank,
        vectorScore: hit.vectorScore,
        entityScore: hit.entityScore,
        rerankScore: hit.rerankScore,
        documentId: segmentDocumentId(hit),
        ...(passage
          ? { passageIndex: passage.index, passageCount: passage.count }
          : {}),
      },
    };
  });
}

function passagePosition(
  hit: RetrievalHit,
): { index: number; count: number } | null {
  const index = hit.metadata.passageIndex;
  const count = hit.metadata.passageCount;
  return typeof index === "number" && typeof count === "number"
    ? { index: index + 1, count }
    : null;
}
