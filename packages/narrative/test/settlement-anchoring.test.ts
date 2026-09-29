import {
  createCanonEntity,
  createDocument,
  createOutlineNode,
  createProject,
} from "@narralume/domain";
import {
  buildManualSettlementRecipe,
  HarnessSupervisor,
} from "@narralume/harness";
import {
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChapterWorkerSuite,
  SettlementApplicationService,
  type NarrativeModelClient,
} from "../src/index.js";

/**
 * 「从正文补全故事圣经」逐章结算可以把导入时抽取、尚未锚定章节的时间线事件
 * 锚定到本章，而不是再新建一条：上下文列出这些事件，校验只接受仍未锚定、
 * 未作废的已有事件，并要求标题照抄。
 */

const now = "2026-09-01T00:00:00.000Z";
const CHAPTER =
  "Helena chega a Vila do Sal com o pedido de Joaquim guardado no bolso do casaco.\n\nEla não sabe ainda que o farol já foi vendido, mas a dona da pensão olha para ela com pena.";
const databases: NodeNarrativeDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

function setup(referenceExistingStoryState: boolean) {
  const database = new NodeNarrativeDatabase();
  databases.push(database);
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "Vila do Sal", language: "en", now }),
  );
  const story = new SqliteStoryRepository(database);
  const root = story.insertOutlineNode(
    createOutlineNode({
      id: "book",
      projectId: "p1",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "Vila do Sal",
      now,
    }),
  );
  for (const [ordinal, id] of ["chapter-1", "chapter-2"].entries()) {
    story.insertOutlineNode(
      createOutlineNode({
        id,
        projectId: "p1",
        parent: root,
        kind: "chapter",
        ordinal,
        title: `Capítulo ${ordinal + 1}`,
        now,
      }),
    );
  }
  const canon = new SqliteCanonRepository(database);
  canon.insertEntity(
    createCanonEntity({
      id: "helena",
      projectId: "p1",
      type: "character",
      name: "Helena",
      now,
    }),
  );
  const state = new SqliteNarrativeStateRepository(database, canon, story);
  const event = (
    id: string,
    title: string,
    sequence: number,
    outlineNodeId: string | null,
  ) =>
    state.insertTimelineEvent({
      id,
      projectId: "p1",
      title,
      description: `${title}.`,
      outlineNodeId,
      storyTimeStart: null,
      storyTimeEnd: null,
      sequence,
      participants: ["helena"],
      causes: [],
      visibility: "reader",
      sourceId: `${id}-candidate`,
      createdAt: now,
      updatedAt: now,
    });
  event("imported-arrival", "Helena chega a Vila do Sal", 1, null);
  event("imported-lighthouse", "O farol é vendido", 2, null);
  event("anchored-letter", "Joaquim escreve a carta", 3, "chapter-2");
  event("voided-storm", "A tempestade", 4, null);
  state.removeTimelineEvent("p1", "voided-storm", now);
  const documents = new SqliteDocumentRepository(database);
  documents.insert(
    createDocument({
      id: "doc-1",
      projectId: "p1",
      kind: "chapter",
      title: "Capítulo 1",
      outlineNodeId: "chapter-1",
      now,
    }),
  );
  documents.appendVersion("p1", "doc-1", {
    id: "version-1",
    content: CHAPTER,
    source: "import",
    now,
  });
  const runs = new SqliteRunRepository(database);
  const recipe = buildManualSettlementRecipe("run-1");
  runs.create({
    id: "run-1",
    projectId: "p1",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    targetOutlineNodeId: null,
    policy: {
      documentId: "doc-1",
      documentVersionId: "version-1",
      referenceExistingStoryState,
    },
    steps: recipe.steps,
    now,
  });
  return { database, runs, state };
}

function timelineItem(overrides: Record<string, unknown>) {
  return {
    anchorEventId: null,
    title: "Helena chega a Vila do Sal",
    description: null,
    storyTime: null,
    participantIds: [],
    causeEventIds: [],
    visibility: "reader",
    knownBy: [],
    evidenceParagraphs: [1],
    ...overrides,
  };
}

function settlementWith(timelineCandidates: unknown[]) {
  return {
    summary: "Helena chega a Vila do Sal.",
    stateDelta: [],
    factCandidates: [],
    timelineCandidates,
    relationshipCandidates: [],
    foreshadowCandidates: [],
  };
}

interface Captured {
  content: string;
  instructions: string;
  issues: string[];
}

function scriptedModel(
  captured: Captured,
  invalid: unknown,
  valid: unknown,
): NarrativeModelClient {
  return {
    async text() {
      throw new Error("a manual settlement must not generate prose");
    },
    async structured(_run, _step, purpose, request, _contract, validate) {
      if (purpose !== "chapter-settlement")
        throw new Error(`unexpected purpose ${purpose}`);
      captured.content = String(request.messages[0]?.content);
      captured.instructions = String(request.instructions);
      const rejected = validate(invalid);
      captured.issues = rejected.success ? [] : [...rejected.issues];
      const checked = validate(valid);
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return {
        value: checked.data,
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          calls: 1,
          costUsd: 0,
          wallTimeMs: 5,
        },
        mode: "native" as const,
        attempts: 1,
      };
    },
  } as NarrativeModelClient;
}

async function settle(
  referenceExistingStoryState: boolean,
  invalid: unknown,
  valid: unknown,
) {
  const fixture = setup(referenceExistingStoryState);
  const captured: Captured = { content: "", instructions: "", issues: [] };
  const supervisor = new HarnessSupervisor(
    fixture.runs,
    new ChapterWorkerSuite(
      fixture.database,
      scriptedModel(captured, invalid, valid),
      () => new Date(now),
    ).registry(),
    { now: () => new Date(now), retryDelayMs: 0 },
  );
  for (let index = 0; index < 6; index += 1) {
    if (!(await supervisor.processNext("settlement-anchoring"))) break;
  }
  expect(fixture.runs.getRun("run-1")?.status).toBe("completed");
  return { ...fixture, captured };
}

describe("settlement timeline anchoring", () => {
  it("lists unanchored events for a Story Bible completion and anchors one instead of duplicating it", async () => {
    const { database, state, captured } = await settle(
      true,
      settlementWith([
        timelineItem({ anchorEventId: "anchored-letter" }),
        timelineItem({ anchorEventId: "voided-storm" }),
        timelineItem({ anchorEventId: "no-such-event" }),
        timelineItem({
          anchorEventId: "imported-arrival",
          title: "Helena arrives in Vila do Sal",
          description: "She arrives.",
          participantIds: ["helena"],
        }),
        timelineItem({
          anchorEventId: "imported-lighthouse",
          title: "O farol é vendido",
        }),
        timelineItem({
          anchorEventId: "imported-lighthouse",
          title: "O farol é vendido",
        }),
      ]),
      settlementWith([
        timelineItem({
          anchorEventId: "timeline:imported-arrival",
          storyTime: "Outono",
          knownBy: [{ entityId: "helena", belief: "known" }],
        }),
      ]),
    );

    const block =
      /\n<unanchored-timeline>([\s\S]*?)<\/unanchored-timeline>\n/u.exec(
        captured.content,
      )?.[1];
    // The events' sources are not import candidates, so no chapter places
    // them.
    expect(block).toBe(
      [
        "Events not placed in a chapter:",
        "- [timeline:imported-arrival] #1 Helena chega a Vila do Sal｜participants: Helena｜Helena chega a Vila do Sal.",
        "- [timeline:imported-lighthouse] #2 O farol é vendido｜participants: Helena｜O farol é vendido.",
      ].join("\n"),
    );
    expect(captured.content).toMatch(
      /<settlement-note>[\s\S]*?anchorEventId[\s\S]*?<\/settlement-note>/u,
    );

    const issues = captured.issues.join("\n");
    expect(issues).toContain(
      "timelineCandidates.0.anchorEventId: 事件 anchored-letter 已锚定到章节",
    );
    // Voided events are no longer current, so they are unknown here.
    expect(issues).toContain(
      "timelineCandidates.1.anchorEventId: 未知时间线事件 ID voided-storm",
    );
    expect(issues).toContain(
      "timelineCandidates.2.anchorEventId: 未知时间线事件 ID no-such-event",
    );
    expect(issues).toContain(
      "timelineCandidates.3.title: 锚定已有事件时 title 必须原样照抄该事件的标题「Helena chega a Vila do Sal」",
    );
    expect(issues).toContain("timelineCandidates.3.description:");
    expect(issues).toContain("timelineCandidates.3.participantIds:");
    expect(issues).toContain(
      "timelineCandidates.5.anchorEventId: 同一个事件 imported-lighthouse 只能锚定一次",
    );
    expect(issues).not.toContain("timelineCandidates.4.");

    const changeSet = new SqliteReviewRepository(database).getCanonChangeSet(
      "p1",
      "run-1:canon-change-set",
    )!;
    expect(
      (changeSet.changes.timelineCandidates as Record<string, unknown>[])[0],
    ).toMatchObject({ anchorEventId: "imported-arrival" });

    const before = state.listTimeline("p1").length;
    new SettlementApplicationService(database).apply({
      projectId: "p1",
      changeSetId: changeSet.id,
      now,
    });
    expect(state.listTimeline("p1")).toHaveLength(before);
    expect(
      state.listTimeline("p1").find((event) => event.id === "imported-arrival"),
    ).toMatchObject({
      title: "Helena chega a Vila do Sal",
      description: "Helena chega a Vila do Sal.",
      outlineNodeId: "chapter-1",
      storyTimeStart: "Outono",
      storyTimeEnd: "Outono",
      participants: ["helena"],
      sourceId: "imported-arrival-candidate",
    });
    expect(state.listKnowledge("p1")).toEqual([
      expect.objectContaining({
        timelineEventId: "imported-arrival",
        knowerEntityId: "helena",
        learnedAtNodeId: "chapter-1",
      }),
    ]);
  });

  it("gives only a Story Bible completion the anchoring rule", async () => {
    const valid = settlementWith([]);
    const backfill = await settle(true, valid, valid);
    const note = /<settlement-note>([\s\S]*?)<\/settlement-note>/u.exec(
      backfill.captured.content,
    )?.[1];
    expect(note).toContain("Anchoring rules:");
    expect(note).toContain(
      "keeps its own description, participants, causes and visibility",
    );
    // The code-owned invariants every settlement gets only say to fill null.
    expect(backfill.captured.instructions).not.toContain("Anchoring rules");
    expect(backfill.captured.instructions).toContain(
      "Timeline anchorEventId is null, which creates a new event",
    );
  });

  it("does not list unanchored events for an ordinary manual settlement and rejects anchors there", async () => {
    const { captured, state } = await settle(
      false,
      settlementWith([timelineItem({ anchorEventId: "imported-arrival" })]),
      settlementWith([timelineItem({ title: "Helena chega" })]),
    );
    expect(captured.content).not.toContain("<unanchored-timeline>");
    expect(captured.content).not.toContain("<settlement-note>");
    expect(captured.instructions).not.toContain("Anchoring rules");
    expect(captured.issues).toEqual([
      "timelineCandidates.0.anchorEventId: 只有「从正文补全故事圣经」的逐章结算可以锚定已有事件；本次结算的 anchorEventId 必须为 null（新建事件）",
    ]);
    expect(
      state.listTimeline("p1").find((event) => event.id === "imported-arrival")
        ?.outlineNodeId,
    ).toBeNull();
  });

  it("rejects model output that leaves anchorEventId out instead of creating an event", async () => {
    const withoutAnchor: Record<string, unknown> = timelineItem({
      title: "Helena chega",
    });
    delete withoutAnchor.anchorEventId;
    const { captured } = await settle(
      true,
      settlementWith([withoutAnchor]),
      settlementWith([]),
    );
    expect(captured.issues.join("\n")).toContain(
      "timelineCandidates.0.anchorEventId",
    );
  });
});
