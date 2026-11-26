import { describe, expect, it } from "vitest";

import {
  buildChapterCompanion,
  type DeskEntity,
  type DeskFact,
  type DeskOutlineNode,
} from "../src/workspaces/studio/chapter-companion-model";

const helena: DeskEntity = {
  id: "helena",
  type: "character",
  name: "Helena",
  aliases: [],
  description: "Guarda o farol.",
  attributes: { role: "faroleira" },
  status: "active",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const chapters: DeskOutlineNode[] = [
  {
    id: "ch-1",
    kind: "chapter",
    title: "A chegada",
    summary: "Helena chega à vila.",
    goal: null,
    status: "committed",
    ordinal: 1,
    povEntityId: "helena",
    metadata: { plannedEntityIds: ["helena"] },
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
  {
    id: "ch-2",
    kind: "chapter",
    title: "A maré",
    summary: null,
    goal: "Helena decide ficar.",
    status: "drafting",
    ordinal: 2,
    povEntityId: "helena",
    metadata: {},
    updatedAt: "2026-11-02T00:00:00.000Z",
  },
];

function fact(partial: Partial<DeskFact> & Pick<DeskFact, "id" | "value">): DeskFact {
  return {
    subjectId: "helena",
    predicate: "olhos",
    objectEntityId: null,
    authority: "locked",
    supersedesFactId: null,
    ...partial,
  };
}

describe("buildChapterCompanion", () => {
  it("shows the previous chapter, the planned person, and the accepted fact", () => {
    const desk = buildChapterCompanion({
      outlineNodeId: "ch-2",
      prose: "Helena olhou o mar.",
      outline: chapters,
      entities: [helena],
      facts: [fact({ id: "eyes", value: "verdes" })],
      relations: [],
      threads: [
        {
          id: "lamp",
          title: "A luz do farol",
          description: "Alguém apaga a luz.",
          status: "planted",
          evidenceNodeIds: ["ch-2"],
          targetFromNodeId: null,
          targetToNodeId: null,
        },
      ],
    });

    expect(desk.previous).toEqual({
      title: "A chegada",
      summary: "Helena chega à vila.",
    });
    expect(desk.cast.map((entity) => entity.name)).toEqual(["Helena"]);
    expect(desk.facts.map((item) => item.value)).toEqual(["verdes"]);
    expect(desk.chapter?.goal).toBe("Helena decide ficar.");
    expect(desk.threads.map((thread) => thread.title)).toEqual(["A luz do farol"]);
    expect(desk.registered).toBe(false);
    expect(desk.contradictions).toEqual([]);
  });

  it("flags prose that still uses a fact the author already replaced", () => {
    const desk = buildChapterCompanion({
      outlineNodeId: "ch-2",
      prose: "Os olhos castanhos de Helena não piscavam.",
      outline: chapters,
      entities: [helena],
      facts: [
        fact({ id: "old", value: "castanhos", authority: "confirmed" }),
        fact({
          id: "new",
          value: "verdes",
          authority: "locked",
          supersedesFactId: "old",
        }),
      ],
      relations: [],
      threads: [],
    });

    expect(desk.contradictions).toEqual([
      { entityName: "Helena", found: "castanhos", accepted: "verdes" },
    ]);
    expect(desk.facts.map((item) => item.value)).toEqual(["verdes"]);
  });

  it("does not treat part of a longer word as a name or an old fact", () => {
    const desk = buildChapterCompanion({
      outlineNodeId: "ch-2",
      prose: "Mariana atravessou o mar. O dia ficou acastanhado.",
      outline: chapters,
      entities: [{ ...helena, id: "ana", name: "Ana", aliases: [] }],
      facts: [
        fact({ id: "old", value: "castanhos", authority: "confirmed" }),
        fact({
          id: "new",
          value: "verdes",
          authority: "locked",
          supersedesFactId: "old",
        }),
      ],
      relations: [],
      threads: [],
    });

    expect(desk.contradictions).toEqual([]);
    expect(desk.cast).toEqual([]);
  });

  it("names the fact that replaced the old value, not another fact about the same person", () => {
    const desk = buildChapterCompanion({
      outlineNodeId: "ch-2",
      prose: "Os olhos castanhos de Helena não piscavam.",
      outline: chapters,
      entities: [helena],
      facts: [
        fact({ id: "old", value: "castanhos", authority: "confirmed" }),
        fact({
          id: "hair",
          value: "preto",
          predicate: "cabelo",
          authority: "locked",
        }),
        fact({
          id: "new",
          value: "verdes",
          authority: "locked",
          supersedesFactId: "old",
        }),
      ],
      relations: [],
      threads: [],
    });

    expect(desk.contradictions).toEqual([
      { entityName: "Helena", found: "castanhos", accepted: "verdes" },
    ]);
  });

  it("keeps reading order when two chapters share the same ordinal", () => {
    const desk = buildChapterCompanion({
      outlineNodeId: "ch-b",
      prose: "",
      outline: [
        { ...chapters[0]!, id: "ch-a", ordinal: 1, title: "No porto" },
        {
          ...chapters[1]!,
          id: "ch-b",
          ordinal: 1,
          title: "Na serra",
          summary: null,
        },
      ],
      entities: [],
      facts: [],
      relations: [],
      threads: [],
    });

    expect(desk.previous?.title).toBe("No porto");
  });

  it("keeps the latest relationship and only the threads that cover this chapter", () => {
    const other: DeskEntity = {
      ...helena,
      id: "tomas",
      name: "Tomás",
      description: null,
    };
    const desk = buildChapterCompanion({
      outlineNodeId: "ch-2",
      prose: "Helena e Tomás.",
      outline: [
        chapters[0]!,
        {
          ...chapters[1]!,
          metadata: { plannedEntityIds: ["helena", "tomas"] },
        },
        { ...chapters[1]!, id: "ch-3", title: "Depois", ordinal: 3 },
      ],
      entities: [helena, other],
      facts: [],
      relations: [
        {
          id: "old",
          fromEntityId: "helena",
          toEntityId: "tomas",
          relation: "aliados",
          outlineNodeId: "ch-1",
          createdAt: "2026-11-01T00:00:00.000Z",
        },
        {
          id: "now",
          fromEntityId: "helena",
          toEntityId: "tomas",
          relation: "desconfiados",
          outlineNodeId: "ch-2",
          createdAt: "2026-11-02T00:00:00.000Z",
        },
        {
          id: "later",
          fromEntityId: "helena",
          toEntityId: "tomas",
          relation: "inimigos",
          outlineNodeId: "ch-3",
          createdAt: "2026-11-03T00:00:00.000Z",
        },
      ],
      threads: [
        {
          id: "here",
          title: "A maré",
          description: "",
          status: "planted",
          evidenceNodeIds: [],
          targetFromNodeId: "ch-1",
          targetToNodeId: "ch-2",
        },
        {
          id: "elsewhere",
          title: "O porto",
          description: "",
          status: "planted",
          evidenceNodeIds: [],
          targetFromNodeId: null,
          targetToNodeId: null,
        },
      ],
    });

    expect(desk.relations.map((relation) => relation.relation)).toEqual([
      "desconfiados",
    ]);
    expect(desk.threads.map((thread) => thread.id)).toEqual(["here"]);
  });
});
