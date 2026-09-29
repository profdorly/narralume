import type { ProjectLanguage } from "@narralume/contracts";
import type { CanonEntity, TimelineEvent } from "@narralume/domain";

/**
 * Where an unanchored event's import evidence sits in the reading order:
 * the reading positions (chapter indices) of the chapters it cites, and how
 * many evidence paragraphs could not be placed in a chapter.
 */
export interface TimelineEvidencePlacement {
  chapters: readonly number[];
  unplaced: number;
}

export interface AnchorableTimeline {
  /** Events whose import evidence cites the chapter being settled. */
  chapter: TimelineEvent[];
  /** Events with no evidence placed in any chapter (bounded). */
  unplaced: TimelineEvent[];
  /**
   * Unanchored events not listed: their evidence lies only in chapters the
   * reading has passed or not reached yet, or the lists are full.
   */
  omitted: number;
}

/** Most unanchored events a backfill settlement lists for anchoring. */
export const ANCHORABLE_TIMELINE_LIMIT = 80;
/** Most of those that are events with no evidence placed in a chapter. */
export const UNPLACED_TIMELINE_LIMIT = 30;
/** Longest event description, in characters, in that list. */
const UNANCHORED_DESCRIPTION_LIMIT = 200;

/**
 * The unanchored events a backfill settlement of one chapter may anchor.
 * The import numbers events in whole-book causal order, so a fixed
 * head-of-sequence window would be held forever by backstory the prose only
 * mentions; instead each chapter gets the events its import evidence cites,
 * then (bounded) the events whose evidence places them in no chapter. An
 * event whose evidence lies only in earlier chapters (the reading position
 * has passed it) or only in other chapters, at least one of them later (it
 * is offered there), is not listed.
 *
 * @param currentChapter reading position of the chapter being settled; null
 *   when it is not an outline chapter, in which case placed events count as
 *   unplaced.
 */
export function selectAnchorableTimeline(
  events: readonly TimelineEvent[],
  placements: ReadonlyMap<string, TimelineEvidencePlacement>,
  currentChapter: number | null,
): AnchorableTimeline {
  const unanchored = events
    .filter((event) => event.outlineNodeId === null)
    .sort(
      (left, right) =>
        left.sequence - right.sequence || left.id.localeCompare(right.id),
    );
  const chapter: TimelineEvent[] = [];
  const unplaced: TimelineEvent[] = [];
  for (const event of unanchored) {
    const placement = placements.get(event.id);
    if (
      !placement ||
      placement.chapters.length === 0 ||
      currentChapter === null
    ) {
      unplaced.push(event);
    } else if (placement.chapters.includes(currentChapter)) {
      chapter.push(event);
    } else if (
      placement.unplaced > 0 &&
      placement.chapters.every((position) => position < currentChapter)
    ) {
      // Part of its evidence could not be placed, so the reading position
      // may not have passed it yet.
      unplaced.push(event);
    }
  }
  const listedChapter = chapter.slice(0, ANCHORABLE_TIMELINE_LIMIT);
  const listedUnplaced = unplaced.slice(
    0,
    Math.min(
      UNPLACED_TIMELINE_LIMIT,
      ANCHORABLE_TIMELINE_LIMIT - listedChapter.length,
    ),
  );
  return {
    chapter: listedChapter,
    unplaced: listedUnplaced,
    omitted: unanchored.length - listedChapter.length - listedUnplaced.length,
  };
}

/* 「从正文补全故事圣经」逐章结算可锚定的事件列表：先列导入证据落在本章的
   未锚定事件，再列无法定位到章节的事件；未列出的数量单独说明。 */
export function unanchoredTimelineBlock(
  anchorable: AnchorableTimeline,
  entities: readonly CanonEntity[],
  language: ProjectLanguage,
): string {
  const en = language === "en";
  const names = new Map(entities.map((entity) => [entity.id, entity.name]));
  const line = (event: TimelineEvent) => {
    const participants = event.participants
      .map((id) => names.get(id))
      .filter((name): name is string => Boolean(name))
      .join(", ");
    const description = event.description
      ? event.description.length > UNANCHORED_DESCRIPTION_LIMIT
        ? `${event.description.slice(0, UNANCHORED_DESCRIPTION_LIMIT)}…`
        : event.description
      : "";
    return [
      `- [timeline:${event.id}] #${event.sequence} ${event.title}`,
      participants
        ? en
          ? `participants: ${participants}`
          : `参与者：${participants}`
        : "",
      description,
    ]
      .filter(Boolean)
      .join("｜");
  };
  const lines: string[] = [];
  if (anchorable.chapter.length > 0) {
    lines.push(
      en
        ? "Events whose import evidence cites this chapter:"
        : "导入证据落在本章的事件：",
      ...anchorable.chapter.map(line),
    );
  }
  if (anchorable.unplaced.length > 0) {
    lines.push(
      en ? "Events not placed in a chapter:" : "未能定位到章节的事件：",
      ...anchorable.unplaced.map(line),
    );
  }
  if (lines.length === 0) lines.push(en ? "(none)" : "（无）");
  if (anchorable.omitted > 0) {
    lines.push(
      en
        ? `(${anchorable.omitted} other unanchored events are not listed: their import evidence cites other chapters, or the list is full.)`
        : `（另有 ${anchorable.omitted} 个未锚定事件未列出：它们的导入证据落在其他章节，或超出列表上限。）`,
    );
  }
  return lines.join("\n");
}
