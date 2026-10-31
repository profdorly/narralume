import {
  createDocument,
  createOutlineNode,
  createProject,
} from "@lapis/domain";
import {
  buildManualSettlementRecipe,
  HarnessSupervisor,
} from "@lapis/harness";
import {
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
} from "@lapis/persistence";
import { NodeNarrativeDatabase } from "@lapis/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { ChapterWorkerSuite, type NarrativeModelClient } from "../src/index.js";

/**
 * 章节结算的产出语言跟随章节正文（而非作品语言 / 指令语言）：
 * 指令追加语言不变量，检测出原稿语言时用户消息再加一行参考。
 */

const now = "2026-09-01T00:00:00.000Z";
const PORTUGUESE_CHAPTER =
  "Helena chega a Vila do Sal com o pedido de Joaquim guardado no bolso do casaco.\n\nEla não sabe ainda que o farol já foi vendido, mas a dona da pensão olha para ela com pena.";
const databases: NodeNarrativeDatabase[] = [];

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

interface CapturedRequest {
  instructions: string;
  content: string;
}

function setup(language: string, content: string) {
  const database = new NodeNarrativeDatabase();
  databases.push(database);
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "Vila do Sal", language, now }),
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
  story.insertOutlineNode(
    createOutlineNode({
      id: "chapter-1",
      projectId: "p1",
      parent: root,
      kind: "chapter",
      ordinal: 0,
      title: "Capítulo 1",
      now,
    }),
  );
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
    content,
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
    policy: { documentId: "doc-1", documentVersionId: "version-1" },
    steps: recipe.steps,
    now,
  });
  return { database, runs };
}

function capturingModel(requests: CapturedRequest[]): NarrativeModelClient {
  return {
    async text() {
      throw new Error("a manual settlement must not generate prose");
    },
    async structured(_run, _step, purpose, request, _contract, validate) {
      if (purpose !== "chapter-settlement")
        throw new Error(`unexpected purpose ${purpose}`);
      requests.push({
        instructions: String(request.instructions),
        content: String(request.messages[0]?.content),
      });
      const checked = validate({
        summary: "Helena chega a Vila do Sal.",
        stateDelta: [],
        factCandidates: [],
        timelineCandidates: [],
        relationshipCandidates: [],
        foreshadowCandidates: [],
      });
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

async function settle(language: string, content: string) {
  const { database, runs } = setup(language, content);
  const requests: CapturedRequest[] = [];
  const supervisor = new HarnessSupervisor(
    runs,
    new ChapterWorkerSuite(
      database,
      capturingModel(requests),
      () => new Date(now),
    ).registry(),
    { now: () => new Date(now), retryDelayMs: 0 },
  );
  for (let index = 0; index < 6; index += 1) {
    if (!(await supervisor.processNext("settlement-language"))) break;
  }
  expect(runs.getRun("run-1")?.status).toBe("completed");
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

describe("chapter settlement output language", () => {
  it.each([
    {
      language: "en",
      invariant:
        "Language invariant: write every natural-language field (summary, stateDelta key/before/after, fact predicate and text value, timeline event title/description, relationship relation/change, and foreshadow title) in the same language as the <manuscript> text",
      hint: "Manuscript language (detected): Portuguese. Write the natural-language fields in this language; if the text itself is clearly in another language, follow the text.",
    },
    {
      language: "pt-BR",
      invariant:
        "Invariante de idioma: escreva todo campo em linguagem natural (summary, stateDelta key/before/after, predicate e value textual do fato, title/description de evento, relation/change, title de semente) no mesmo idioma do texto em <manuscript>",
      hint: "Idioma do manuscrito (detectado): português. Escreva os campos em linguagem natural nesse idioma; se o texto estiver claramente em outra língua, siga o texto.",
    },
  ])(
    "tells a $language settlement to keep a Portuguese chapter's language",
    async ({ language, invariant, hint }) => {
      const request = await settle(language, PORTUGUESE_CHAPTER);
      expect(request.instructions).toContain(invariant);
      expect(request.instructions).toContain(
        language === "en"
          ? "reuse the exact predicate an existing fact of the same subject already uses"
          : "reutilize o predicate exato de um fato já existente do mesmo sujeito",
      );
      // The hint sits right before the manuscript it describes.
      expect(request.content).toContain(`${hint}\n<manuscript>`);
    },
  );

  it("adds the Chinese hint to a Chinese chapter of a Chinese work", async () => {
    const request = await settle(
      "pt-BR",
      "雾从海面推上石阶，林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。\n\n灯灭的一刻，父亲忽然问她为何对着空椅子说话。",
    );
    expect(request.instructions).toContain("Invariante de idioma");
    expect(request.content).toContain(
      "Idioma do manuscrito (detectado): chinês. Escreva os campos em linguagem natural nesse idioma; se o texto estiver claramente em outra língua, siga o texto.",
    );
  });

  it("keeps the invariant but adds no hint when the language cannot be detected", async () => {
    const request = await settle("en", "Helena.\n\nVila do Sal.");
    expect(request.instructions).toContain("Language invariant:");
    expect(request.content).not.toMatch(/detected|自动检测/u);
  });
});
