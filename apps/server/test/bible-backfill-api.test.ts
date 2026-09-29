import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanonFact } from "@narralume/domain";
import type { NarrativeModelClient } from "@narralume/narrative";
import {
  SqliteBibleBackfillRepository,
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

/**
 * 「从正文补全故事圣经」：导入的已完成章节按阅读顺序逐章走手动结算管线，
 * 每章变更集保持可审阅候选（或显式 auto-apply，遇冲突即停）。
 */

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};

const MODEL_ENVIRONMENT = {
  NARRATIVE_LLM_API_KEY: "server-only-test-key",
  NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
  NARRATIVE_LLM_MODEL: "test-model",
  NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
  NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
};

type App = Awaited<ReturnType<typeof buildApp>>;

const resources: { app: App; database: NodeNarrativeDatabase }[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()!;
    await resource.app.close();
    resource.database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const MANUSCRIPT = `# 第一章 雾港

雾从海面推上石阶，林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。

灯灭的一刻，父亲忽然问她为何对着空椅子说话。窗外所有船铃同时沉默。

# 第二章 旧邮局

旧邮局的柜台积着盐霜，林昼在无人认领的信堆里找到一封写给自己的空白信。

她把信夹进日志，决定等潮水退去再去码头。

# 第三章 灯塔

林昼摸黑走下旋梯，海面在脚下翻涌，雾里没有一艘船亮着灯。

她点亮灯芯，港口的人终于想起了失踪者的名字。
`;

interface SettlementCall {
  runId: string;
  policy: Record<string, unknown>;
  content: string;
}

interface ModelScript {
  calls: SettlementCall[];
  /** Returns the settlement value for a call, or throws a model error. */
  respond: (call: SettlementCall) => unknown;
}

function scriptedModel(script: ModelScript): NarrativeModelClient {
  const usage = {
    inputTokens: 100,
    outputTokens: 100,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 5,
  };
  return {
    async text() {
      throw new Error("the Story Bible backfill must not generate prose");
    },
    async structured(run, _step, purpose, request, _contract, validate) {
      if (purpose !== "chapter-settlement") {
        throw new Error(`unexpected purpose ${purpose}`);
      }
      const call = {
        runId: run.id,
        policy: run.policy as Record<string, unknown>,
        content: String(
          (request as { messages: { content: string }[] }).messages[0]!.content,
        ),
      };
      script.calls.push(call);
      const checked = validate(script.respond(call));
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return { value: checked.data, usage, mode: "native", attempts: 1 };
    },
  } as NarrativeModelClient;
}

function settlement(
  facts: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    summary: "林昼沿着灯塔的线索前进。",
    stateDelta: [],
    factCandidates: facts,
    timelineCandidates: [],
    relationshipCandidates: [],
    foreshadowCandidates: [],
  };
}

function fact(
  subjectId: string,
  predicate: string,
  value: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operation: "assert",
    factId: null,
    subjectId,
    predicate,
    objectEntityId: null,
    value,
    knowledgeScope: "character",
    knowledgeSubjectId: subjectId,
    belief: "known",
    evidenceParagraphs: [1],
    ...overrides,
  };
}

async function setup(
  script: ModelScript,
  options: {
    databasePath?: string;
    environment?: Record<string, string>;
    enableRunWorker?: boolean;
  } = {},
) {
  const database = new NodeNarrativeDatabase(options.databasePath);
  const app = await buildApp({
    config,
    database,
    environment: options.environment ?? MODEL_ENVIRONMENT,
    narrativeModelClient: scriptedModel(script),
    enableRunWorker: options.enableRunWorker ?? false,
    logger: false,
  });
  const resource = { app, database };
  resources.push(resource);
  return resource;
}

async function close(resource: { app: App; database: NodeNarrativeDatabase }) {
  await resource.app.close();
  resource.database.close();
  resources.splice(resources.indexOf(resource), 1);
}

interface ImportedBook {
  projectId: string;
  heroId: string;
  chapters: { outlineNodeId: string; documentId: string; versionId: string }[];
}

async function importBook(app: App): Promise<ImportedBook> {
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { requestId: globalThis.crypto.randomUUID(), title: "雾港灯塔" },
  });
  expect(project.statusCode, project.body).toBe(201);
  const projectId = project.json().id as string;
  const preview = await app.inject({
    method: "POST",
    url: "/api/imports/preview",
    payload: {
      targetProjectId: projectId,
      filename: "book.md",
      format: "markdown",
      contentBase64: Buffer.from(MANUSCRIPT).toString("base64"),
    },
  });
  expect(preview.statusCode, preview.body).toBe(201);
  const detail = preview.json() as {
    batch: { id: string };
    candidates: { id: string }[];
  };
  const applied = await app.inject({
    method: "POST",
    url: `/api/imports/${detail.batch.id}/actions`,
    payload: {
      action: "apply",
      selectedCandidateIds: detail.candidates.map((candidate) => candidate.id),
    },
  });
  expect(applied.statusCode, applied.body).toBe(200);
  const hero = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/entities`,
    payload: {
      type: "character",
      name: "林昼",
      aliases: [],
      description: "守灯人的女儿。",
    },
  });
  expect(hero.statusCode, hero.body).toBe(201);
  const bible = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/story-bible`,
    })
  ).json() as { outline: { id: string; kind: string }[] };
  const documents = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/documents`,
    })
  ).json() as {
    id: string;
    kind: string;
    outlineNodeId: string | null;
    currentVersionId: string | null;
  }[];
  const chapters = bible.outline
    .filter((node) => node.kind === "chapter")
    .map((node) => {
      const document = documents.find(
        (candidate) => candidate.outlineNodeId === node.id,
      )!;
      return {
        outlineNodeId: node.id,
        documentId: document.id,
        versionId: document.currentVersionId!,
      };
    });
  expect(chapters).toHaveLength(3);
  return { projectId, heroId: hero.json().id as string, chapters };
}

interface BackfillDetail {
  job: {
    id: string;
    status: string;
    mode: string;
    error: Record<string, unknown> | null;
    pauseRequested: boolean;
    cancelRequested: boolean;
    currentOrdinal: number | null;
  } | null;
  items: {
    ordinal: number;
    outlineNodeId: string;
    versionId: string;
    title: string | null;
    attempt: number;
    runId: string | null;
    changeSetId: string | null;
    status: string;
    skipReason: string | null;
    error: Record<string, unknown> | null;
  }[];
  counts: Record<string, number>;
  availableActions: string[];
  idempotentReplay?: boolean;
}

async function startBackfill(
  app: App,
  projectId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/bible-backfills`,
    payload,
  });
}

async function advance(
  app: App,
  projectId: string,
  jobId: string,
): Promise<{ processed: boolean; detail: BackfillDetail }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/bible-backfills/${jobId}/advance`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

/** Advances until the coordinator reports no further transition. */
async function settle(
  app: App,
  projectId: string,
  jobId: string,
): Promise<BackfillDetail> {
  for (let index = 0; index < 20; index += 1) {
    const { processed, detail } = await advance(app, projectId, jobId);
    if (!processed) return detail;
  }
  throw new Error("the backfill coordinator did not settle");
}

async function current(app: App, projectId: string): Promise<BackfillDetail> {
  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/bible-backfills/current`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function act(
  app: App,
  projectId: string,
  jobId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/bible-backfills/${jobId}/actions`,
    payload: { requestId: globalThis.crypto.randomUUID(), ...payload },
  });
}

async function driveRun(
  app: App,
  projectId: string,
  runId: string,
): Promise<string> {
  let status = "pending";
  for (let index = 0; index < 20; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(response.statusCode, response.body).toBe(200);
    status = response.json().snapshot.run.status as string;
    if (["completed", "failed", "cancelled", "paused"].includes(status)) {
      return status;
    }
  }
  return status;
}

async function decide(
  app: App,
  projectId: string,
  changeSetId: string,
  action: "apply" | "reject",
  conflictPolicy: "reject" | "force" = "reject",
) {
  return app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/canon-change-sets/${changeSetId}/decisions`,
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      action,
      conflictPolicy,
    },
  });
}

async function settlementRuns(app: App, projectId: string) {
  const runs = (
    await app.inject({ method: "GET", url: `/api/projects/${projectId}/runs` })
  ).json() as {
    id: string;
    recipe: string;
    status: string;
    targetOutlineNodeId: string | null;
    policy: Record<string, unknown>;
  }[];
  return runs.filter((run) => run.recipe === "manual-settlement");
}

describe("Story Bible backfill API", () => {
  it("settles imported chapters one at a time and waits for each review decision", async () => {
    const script: ModelScript = {
      calls: [],
      respond: (call) => {
        const ordinal = call.policy.bibleBackfillOrdinal;
        if (ordinal === 1) return settlement();
        return settlement([
          fact(heroId, `第${Number(ordinal) + 1}章状态`, "守夜"),
        ]);
      },
    };
    let heroId = "";
    const { app, database } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    const requestId = globalThis.crypto.randomUUID();

    const created = await startBackfill(app, book.projectId, {
      requestId,
      mode: "review_each",
    });
    expect(created.statusCode, created.body).toBe(202);
    const job = created.json() as BackfillDetail;
    expect(job).toMatchObject({
      idempotentReplay: false,
      job: { status: "running", mode: "review_each", currentOrdinal: 0 },
      counts: { total: 3, pending: 3 },
    });
    expect(job.items.map((item) => item.outlineNodeId)).toEqual(
      book.chapters.map((chapter) => chapter.outlineNodeId),
    );
    expect(job.items.map((item) => item.title)).toEqual([
      "第一章 雾港",
      "第二章 旧邮局",
      "第三章 灯塔",
    ]);
    const jobId = job.job!.id;

    const replay = await startBackfill(app, book.projectId, {
      requestId,
      mode: "review_each",
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({
      idempotentReplay: true,
      job: { id: jobId },
    });
    const conflicting = await startBackfill(app, book.projectId, {
      requestId,
      mode: "auto_apply_stop_on_conflict",
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({
      error: { code: "bible_backfill.idempotency_conflict" },
    });
    const second = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: "bible_backfill.active", details: { jobId } },
    });

    // Chapter 1: one settlement run, then the job waits for the author.
    let detail = await settle(app, book.projectId, jobId);
    expect(detail.items[0]).toMatchObject({ status: "settling" });
    const runs = await settlementRuns(app, book.projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: detail.items[0]!.runId,
      targetOutlineNodeId: null,
      policy: {
        documentId: book.chapters[0]!.documentId,
        documentVersionId: book.chapters[0]!.versionId,
        origin: { surface: "bible-backfill" },
        bibleBackfillJobId: jobId,
      },
    });
    expect(await driveRun(app, book.projectId, runs[0]!.id)).toBe("completed");
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job).toMatchObject({ status: "awaiting_decision" });
    expect(detail.items[0]).toMatchObject({ status: "awaiting_decision" });
    const firstChangeSet = detail.items[0]!.changeSetId!;
    expect(firstChangeSet).toBeTruthy();
    expect(await settlementRuns(app, book.projectId)).toHaveLength(1);
    expect(script.calls[0]!.content).toContain("<settlement-note>");

    const applied = await decide(app, book.projectId, firstChangeSet, "apply");
    expect(applied.statusCode, applied.body).toBe(200);

    // The applied chapter is anchored to its own outline node.
    const canon = new SqliteCanonRepository(database);
    const story = new SqliteStoryRepository(database);
    const state = new SqliteNarrativeStateRepository(database, canon, story);
    expect(canon.listEffectiveFacts(book.projectId)).toEqual([
      expect.objectContaining({
        predicate: "第1章状态",
        validFromNodeId: book.chapters[0]!.outlineNodeId,
      }),
    ]);
    expect(state.listKnowledge(book.projectId)).toEqual([
      expect.objectContaining({
        learnedAtNodeId: book.chapters[0]!.outlineNodeId,
      }),
    ]);
    expect(
      state.latestSummary(
        book.projectId,
        "chapter",
        book.chapters[0]!.outlineNodeId,
      ),
    ).toMatchObject({ stateDelta: { changes: [] } });

    // Chapter 2 settles empty and advances without a decision.
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[0]!.status).toBe("applied");
    expect(detail.items[1]!.status).toBe("settling");
    expect(await driveRun(app, book.projectId, detail.items[1]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[1]).toMatchObject({
      status: "empty",
      changeSetId: null,
    });
    expect(detail.items[2]!.status).toBe("settling");
    expect(await driveRun(app, book.projectId, detail.items[2]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("awaiting_decision");
    const rejected = await decide(
      app,
      book.projectId,
      detail.items[2]!.changeSetId!,
      "reject",
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail).toMatchObject({
      job: { status: "completed", currentOrdinal: null },
      counts: { applied: 1, empty: 1, rejected: 1 },
      availableActions: [],
    });
    expect((await current(app, book.projectId)).job!.id).toBe(jobId);

    // Every chapter now carries a settlement summary: a new request skips them all.
    const again = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json()).toMatchObject({
      job: { status: "completed" },
      counts: { skipped: 3 },
    });
    expect(
      (again.json() as BackfillDetail).items.map((item) => item.skipReason),
    ).toEqual(["already_settled", "already_settled", "already_settled"]);

    // A writing-path settlement is unchanged: no backfill note.
    const versions = await app.inject({
      method: "POST",
      url: `/api/projects/${book.projectId}/documents/${book.chapters[0]!.documentId}/versions`,
      payload: {
        content: "雾退了。\n\n林昼推开灯塔的门。",
        source: "manual",
        expectedCurrentVersionId: book.chapters[0]!.versionId,
      },
    });
    expect(versions.statusCode, versions.body).toBe(201);
    const writingRun = (await settlementRuns(app, book.projectId)).find(
      (run) => (run.policy.origin as { surface: string }).surface === "writing",
    )!;
    expect(await driveRun(app, book.projectId, writingRun.id)).toBe(
      "completed",
    );
    expect(script.calls.at(-1)!.runId).toBe(writingRun.id);
    expect(script.calls.at(-1)!.content).not.toContain("<settlement-note>");
  });

  it("auto-applies each chapter and stops for the author on a canon conflict", async () => {
    let heroId = "";
    const script: ModelScript = {
      calls: [],
      respond: (call) => {
        const ordinal = call.policy.bibleBackfillOrdinal;
        if (ordinal === 1) {
          return settlement([
            fact(heroId, "身份", "守灯人", {
              operation: "supersede",
              factId: "locked-identity",
              knowledgeScope: "omniscient",
              knowledgeSubjectId: null,
            }),
          ]);
        }
        return settlement([
          fact(heroId, `第${Number(ordinal) + 1}章状态`, "清醒"),
        ]);
      },
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    new SqliteCanonRepository(database).insertFact(
      createCanonFact({
        id: "locked-identity",
        projectId: book.projectId,
        subjectId: heroId,
        predicate: "身份",
        value: "邮差",
        authority: "locked",
        sourceType: "test",
        now: new Date().toISOString(),
      }),
    );
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
      mode: "auto_apply_stop_on_conflict",
    });
    expect(created.statusCode, created.body).toBe(202);
    const jobId = (created.json() as BackfillDetail).job!.id;

    let detail = await settle(app, book.projectId, jobId);
    expect(await driveRun(app, book.projectId, detail.items[0]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[0]!.status).toBe("applied");
    expect(await driveRun(app, book.projectId, detail.items[1]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job).toMatchObject({
      status: "awaiting_user",
      error: {
        code: "settlement.conflict",
        ordinal: 1,
        changeSetId: detail.items[1]!.changeSetId,
        forceAllowed: true,
        conflicts: [expect.objectContaining({ reason: "target_locked" })],
      },
    });
    expect(detail.items[1]!.status).toBe("awaiting_decision");
    expect(detail.availableActions).toEqual(
      expect.arrayContaining(["resume", "cancel", "skip_item"]),
    );
    expect(await settlementRuns(app, book.projectId)).toHaveLength(2);

    // Resuming without resolving the conflict stops again, explicitly.
    const resumed = await act(app, book.projectId, jobId, { action: "resume" });
    expect(resumed.statusCode, resumed.body).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job).toMatchObject({
      status: "awaiting_user",
      error: { code: "settlement.conflict" },
    });

    // The author resolves it through the existing decision route.
    const forced = await decide(
      app,
      book.projectId,
      detail.items[1]!.changeSetId!,
      "apply",
      "force",
    );
    expect(forced.statusCode, forced.body).toBe(200);
    expect(
      (await act(app, book.projectId, jobId, { action: "resume" })).statusCode,
    ).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[1]!.status).toBe("applied");
    expect(await driveRun(app, book.projectId, detail.items[2]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail).toMatchObject({
      job: { status: "completed" },
      counts: { applied: 3 },
    });
    expect(
      new SqliteCanonRepository(database)
        .listEffectiveFacts(book.projectId)
        .find((candidate) => candidate.predicate === "身份"),
    ).toMatchObject({
      value: "守灯人",
      supersedesFactId: "locked-identity",
      validFromNodeId: book.chapters[1]!.outlineNodeId,
    });
  });

  it("pauses, resumes, skips, retries and cancels without losing its place", async () => {
    let heroId = "";
    let failNext = true;
    const script: ModelScript = {
      calls: [],
      respond: (call) => {
        if (call.policy.bibleBackfillOrdinal === 1 && failNext) {
          failNext = false;
          throw {
            code: "model.authentication",
            message: "API key rejected",
            retryable: false,
          };
        }
        return settlement([
          fact(heroId, "状态", `第${call.policy.bibleBackfillOrdinal}章`),
        ]);
      },
    };
    const { app } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;

    // Pause while the first settlement run is queued.
    let detail = await settle(app, book.projectId, jobId);
    const firstRun = detail.items[0]!.runId!;
    const paused = await act(app, book.projectId, jobId, { action: "pause" });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({
      job: { status: "running", pauseRequested: true },
    });
    expect(await driveRun(app, book.projectId, firstRun)).toBe("paused");
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job).toMatchObject({ status: "paused" });
    expect(detail.availableActions).toContain("resume");

    expect(
      (await act(app, book.projectId, jobId, { action: "resume" })).statusCode,
    ).toBe(200);
    expect(await driveRun(app, book.projectId, firstRun)).toBe("completed");
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("awaiting_decision");

    // Pausing while waiting for a decision parks immediately; the decision
    // is only picked up after resume.
    const parked = await act(app, book.projectId, jobId, { action: "pause" });
    expect(parked.json()).toMatchObject({ job: { status: "paused" } });
    expect(
      (
        await decide(
          app,
          book.projectId,
          detail.items[0]!.changeSetId!,
          "apply",
        )
      ).statusCode,
    ).toBe(200);
    expect((await advance(app, book.projectId, jobId)).processed).toBe(false);
    expect(
      (await act(app, book.projectId, jobId, { action: "resume" })).statusCode,
    ).toBe(200);

    // Skip the last chapter ahead of time.
    const skipped = await act(app, book.projectId, jobId, {
      action: "skip_item",
      ordinal: 2,
    });
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect((skipped.json() as BackfillDetail).items[2]).toMatchObject({
      status: "skipped",
      skipReason: "author_skipped",
    });

    // Chapter 2 fails fatally: the job stops and cannot resume past it.
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[0]!.status).toBe("applied");
    const failedRun = detail.items[1]!.runId!;
    expect(await driveRun(app, book.projectId, failedRun)).toBe("failed");
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[1]).toMatchObject({
      status: "failed",
      error: { code: "child.fatal", runId: failedRun },
    });
    expect(detail.job).toMatchObject({
      status: "awaiting_user",
      error: { code: "child.fatal", ordinal: 1 },
    });
    expect(detail.availableActions).not.toContain("resume");
    const blocked = await act(app, book.projectId, jobId, { action: "resume" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "bible_backfill.item.failed" },
    });

    const retryRequestId = globalThis.crypto.randomUUID();
    const retried = await act(app, book.projectId, jobId, {
      requestId: retryRequestId,
      action: "retry_item",
      ordinal: 1,
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({
      idempotentReplay: false,
      job: { status: "running" },
      items: [{}, { status: "pending", attempt: 1, runId: null }, {}],
    });
    const replayed = await act(app, book.projectId, jobId, {
      requestId: retryRequestId,
      action: "retry_item",
      ordinal: 1,
    });
    expect(replayed.json()).toMatchObject({
      idempotentReplay: true,
      items: [{}, { attempt: 1 }, {}],
    });
    const misused = await act(app, book.projectId, jobId, {
      requestId: retryRequestId,
      action: "skip_item",
      ordinal: 1,
    });
    expect(misused.statusCode).toBe(409);
    expect(misused.json()).toMatchObject({
      error: { code: "bible_backfill.idempotency_conflict" },
    });

    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[1]!.runId).not.toBe(failedRun);
    expect(await driveRun(app, book.projectId, detail.items[1]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("awaiting_decision");

    // Cancelling ends the job; its pending change set stays reviewable.
    const cancelled = await act(app, book.projectId, jobId, {
      action: "cancel",
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({
      job: { status: "cancelled" },
      availableActions: [],
    });
    const changeSets = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${book.projectId}/canon-change-sets`,
      })
    ).json() as { changeSets: { id: string; status: string }[] };
    expect(
      changeSets.changeSets.find(
        (set) => set.id === detail.items[1]!.changeSetId,
      )?.status,
    ).toBe("candidate");
    const late = await act(app, book.projectId, jobId, { action: "resume" });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({
      error: { code: "bible_backfill.terminal" },
    });
  });

  it("cancels a queued chapter settlement together with the job", async () => {
    const script: ModelScript = { calls: [], respond: () => settlement() };
    const { app } = await setup(script);
    const book = await importBook(app);
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
      chapterIds: [
        book.chapters[2]!.outlineNodeId,
        book.chapters[0]!.outlineNodeId,
      ],
    });
    expect(created.statusCode, created.body).toBe(202);
    const detail = created.json() as BackfillDetail;
    // Selection is settled in reading order regardless of request order.
    expect(detail.items.map((item) => item.outlineNodeId)).toEqual([
      book.chapters[0]!.outlineNodeId,
      book.chapters[2]!.outlineNodeId,
    ]);
    const settling = await settle(app, book.projectId, detail.job!.id);
    const runId = settling.items[0]!.runId!;
    const cancelled = await act(app, book.projectId, detail.job!.id, {
      action: "cancel",
    });
    expect(cancelled.json()).toMatchObject({
      job: { status: "cancelled" },
      items: [
        { status: "failed", error: { code: "bible_backfill.cancelled" } },
        { status: "pending" },
      ],
    });
    const run = (await settlementRuns(app, book.projectId)).find(
      (candidate) => candidate.id === runId,
    );
    expect(run?.status).toBe("cancelled");
    const byId = await app.inject({
      method: "GET",
      url: `/api/projects/${book.projectId}/bible-backfills/${detail.job!.id}`,
    });
    expect(byId.statusCode, byId.body).toBe(200);
    expect(byId.json()).toMatchObject({ job: { status: "cancelled" } });
    const elsewhere = await app.inject({
      method: "GET",
      url: `/api/projects/other-project/bible-backfills/${detail.job!.id}`,
    });
    expect(elsewhere.statusCode).toBe(404);

    const invalid = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
      chapterIds: ["missing-chapter"],
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: {
        code: "bible_backfill.chapter.invalid",
        details: { chapterIds: ["missing-chapter"] },
      },
    });
  });

  it("cancels the active job when the project moves to the recycle bin", async () => {
    const script: ModelScript = { calls: [], respond: () => settlement() };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    await settle(app, book.projectId, jobId);
    const project = (
      (await app.inject({ method: "GET", url: "/api/projects" })).json() as {
        id: string;
        title: string;
        updatedAt: string;
      }[]
    ).find((candidate) => candidate.id === book.projectId)!;
    const archived = await app.inject({
      method: "PUT",
      url: `/api/projects/${book.projectId}`,
      payload: {
        title: project.title,
        subtitle: null,
        premise: null,
        archived: true,
        expectedUpdatedAt: project.updatedAt,
      },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${book.projectId}`,
      payload: {
        confirmationTitle: project.title,
        expectedUpdatedAt: (archived.json() as { updatedAt: string }).updatedAt,
      },
    });
    expect(deleted.statusCode, deleted.body).toBe(202);
    expect(
      new SqliteBibleBackfillRepository(database).requireJob(jobId).status,
    ).toBe("cancelled");
    expect(
      new SqliteBibleBackfillRepository(database).listActionableJobs(),
    ).toEqual([]);
  });

  it("refuses to start without a writing model instead of skipping silently", async () => {
    const script: ModelScript = { calls: [], respond: () => settlement() };
    const { app } = await setup(script, { environment: {} });
    const book = await importBook(app);
    const response = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "model.assignment.unavailable" },
    });
    expect((await current(app, book.projectId)).job).toBeNull();
  });

  it("resumes after a restart and drains in the background", async () => {
    const directory = mkdtempSync(join(tmpdir(), "narralume-backfill-"));
    directories.push(directory);
    const databasePath = join(directory, "story.sqlite");
    let heroId = "";
    const script: ModelScript = {
      calls: [],
      respond: () => settlement([fact(heroId, "状态", "清醒")]),
    };
    const first = await setup(script, { databasePath });
    const book = await importBook(first.app);
    heroId = book.heroId;
    const created = await startBackfill(first.app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    const detail = await settle(first.app, book.projectId, jobId);
    expect(
      await driveRun(first.app, book.projectId, detail.items[0]!.runId!),
    ).toBe("completed");
    await close(first);

    // The restarted server reconciles the finished run on its own.
    const second = await setup(script, { databasePath, enableRunWorker: true });
    const waiting = await waitFor(second.app, book.projectId, (state) =>
      state.job?.status === "awaiting_decision" ? state : null,
    );
    expect(waiting.items[0]!.status).toBe("awaiting_decision");

    // The decision route wakes it; the next chapter settles in the background.
    expect(
      (
        await decide(
          second.app,
          book.projectId,
          waiting.items[0]!.changeSetId!,
          "apply",
        )
      ).statusCode,
    ).toBe(200);
    const next = await waitFor(second.app, book.projectId, (state) =>
      state.items[1]?.status === "awaiting_decision" ? state : null,
    );
    expect(next.items[0]!.status).toBe("applied");
    expect(next.job!.status).toBe("awaiting_decision");
    expect(await settlementRuns(second.app, book.projectId)).toHaveLength(2);
  });
});

async function waitFor(
  app: App,
  projectId: string,
  predicate: (detail: BackfillDetail) => BackfillDetail | null,
): Promise<BackfillDetail> {
  const deadline = Date.now() + 5_000;
  let last: BackfillDetail | null = null;
  while (Date.now() < deadline) {
    last = await current(app, projectId);
    const matched = predicate(last);
    if (matched) return matched;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `backfill did not reach the expected state: ${JSON.stringify(last)}`,
  );
}
