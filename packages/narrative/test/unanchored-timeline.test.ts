import { sha256Hex, type TimelineEvent } from "@lapis/domain";
import { describe, expect, it } from "vitest";

import {
  ANCHORABLE_TIMELINE_LIMIT,
  importEvidenceDocuments,
  importSourceText,
  ParagraphLocator,
  selectAnchorableTimeline,
  UNPLACED_TIMELINE_LIMIT,
  unanchoredTimelineBlock,
  type TimelineEvidencePlacement,
} from "../src/index.js";

/**
 * Per-chapter settlement in "Complete the story bible from the manuscript"
 * picks the anchorable events by the chapter where their import evidence sits,
 * not the first batch by whole-book causal order: backstory that is only
 * mentioned never holds the list forever.
 */

const now = "2026-09-01T00:00:00.000Z";

function event(id: string, sequence: number, anchored = false): TimelineEvent {
  return {
    id,
    projectId: "p1",
    title: id,
    description: null,
    outlineNodeId: anchored ? "chapter-x" : null,
    storyTimeStart: null,
    storyTimeEnd: null,
    sequence,
    participants: [],
    causes: [],
    visibility: "reader",
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  };
}

const ids = (events: readonly TimelineEvent[]) => events.map((item) => item.id);

describe("selectAnchorableTimeline", () => {
  it("offers the chapter's events first, then unplaced ones, and drops events the reading has passed or not reached", () => {
    const placements = new Map<string, TimelineEvidencePlacement>([
      ["backstory", { chapters: [0], unplaced: 0 }],
      ["here", { chapters: [0, 2], unplaced: 0 }],
      ["later", { chapters: [3], unplaced: 0 }],
      ["around", { chapters: [1, 3], unplaced: 0 }],
      ["partly-placed", { chapters: [0], unplaced: 1 }],
      ["no-evidence", { chapters: [], unplaced: 0 }],
    ]);
    const events = [
      event("backstory", 1),
      event("here", 5),
      event("later", 2),
      event("around", 3),
      event("partly-placed", 4),
      event("no-evidence", 6),
      event("author-plan", 7),
      event("anchored", 8, true),
    ];
    const selection = selectAnchorableTimeline(events, placements, 2);
    expect(ids(selection.chapter)).toEqual(["here"]);
    expect(ids(selection.unplaced)).toEqual([
      "partly-placed",
      "no-evidence",
      "author-plan",
    ]);
    // backstory (passed), later and around (offered in chapter 3).
    expect(selection.omitted).toBe(3);
    expect(unanchoredTimelineBlock(selection, [], "pt-BR")).toBe(
      [
        "Eventos cuja evidência de importação cita este capítulo:",
        "- [timeline:here] #5 here",
        "Eventos sem capítulo:",
        "- [timeline:partly-placed] #4 partly-placed",
        "- [timeline:no-evidence] #6 no-evidence",
        "- [timeline:author-plan] #7 author-plan",
        "(outros 3 eventos sem âncora não foram listados: a evidência de importação cita outros capítulos, ou a lista está cheia.)",
      ].join("\n"),
    );
  });

  it("treats placed events as unplaced when the settled chapter is not an outline chapter", () => {
    const selection = selectAnchorableTimeline(
      [event("placed", 1)],
      new Map([["placed", { chapters: [0], unplaced: 0 }]]),
      null,
    );
    expect(ids(selection.unplaced)).toEqual(["placed"]);
    expect(selection.omitted).toBe(0);
  });

  it("bounds the lists and counts what it leaves out", () => {
    const events: TimelineEvent[] = [];
    const placements = new Map<string, TimelineEvidencePlacement>();
    for (let index = 0; index < 100; index += 1) {
      events.push(event(`chapter-${index}`, index));
      placements.set(`chapter-${index}`, { chapters: [0], unplaced: 0 });
    }
    for (let index = 0; index < 50; index += 1) {
      events.push(event(`unplaced-${index}`, 200 + index));
    }
    const crowded = selectAnchorableTimeline(events, placements, 0);
    expect(crowded.chapter).toHaveLength(ANCHORABLE_TIMELINE_LIMIT);
    expect(crowded.unplaced).toHaveLength(0);
    expect(crowded.omitted).toBe(150 - ANCHORABLE_TIMELINE_LIMIT);

    const unplacedOnly = selectAnchorableTimeline(events, placements, 1);
    expect(unplacedOnly.chapter).toHaveLength(0);
    expect(ids(unplacedOnly.unplaced)).toHaveLength(UNPLACED_TIMELINE_LIMIT);
    expect(unplacedOnly.omitted).toBe(150 - UNPLACED_TIMELINE_LIMIT);
    expect(
      unanchoredTimelineBlock(
        { chapter: [], unplaced: [], omitted: 2 },
        [],
        "en",
      ),
    ).toBe(
      "(none)\n(2 other unanchored events are not listed: their import evidence cites other chapters, or the list is full.)",
    );
  });
});

describe("importEvidenceDocuments", () => {
  const documents = [
    { id: "doc-1", title: "Um", payload: { content: "Primeiro.\n\nSegundo." } },
    { id: "doc-2", title: "Dois", payload: { content: "Terceiro." } },
  ];

  it("places tagged evidence by its tag and older evidence by hash-checked offsets", () => {
    const source = importSourceText(documents);
    expect(source.text).toBe(
      "# Um\nPrimeiro.\n\nSegundo.\n\n# Dois\nTerceiro.",
    );
    const located = new ParagraphLocator(source.text).locate([1, 2, 3]);
    let built = 0;
    const lazySource = () => {
      built += 1;
      return source;
    };
    expect(
      importEvidenceDocuments(
        [
          { ...located[0], documentCandidateId: "doc-2" },
          located[1],
          located[2],
          { ...located[2], contentHash: sha256Hex("edited text") },
          "not evidence",
        ],
        lazySource,
      ),
    ).toEqual(["doc-2", "doc-1", "doc-2", null, null]);
    expect(built).toBeGreaterThan(0);

    // Evidence that is all tagged never rebuilds the import text.
    built = 0;
    expect(
      importEvidenceDocuments(
        [{ ...located[0], documentCandidateId: "doc-1" }],
        lazySource,
      ),
    ).toEqual(["doc-1"]);
    expect(built).toBe(0);
    expect(importEvidenceDocuments(undefined, lazySource)).toEqual([]);
  });
});
