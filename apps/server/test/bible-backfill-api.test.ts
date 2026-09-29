import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanonEntity, createCanonFact } from "@narralume/domain";
import {
  SettlementApplicationService,
  type NarrativeModelClient,
} from "@narralume/narrative";
import {
  SqliteBibleBackfillRepository,
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  /** Priced usage per call (the default call is unpriced). */
  costUsd?: number;
}

function scriptedModel(script: ModelScript): NarrativeModelClient {
  const usage = {
    inputTokens: 100,
    outputTokens: 100,
    calls: 1,
    costUsd: script.costUsd ?? 0,
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
    note: Record<string, unknown> | null;
  }[];
  counts: Record<string, number>;
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  };
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
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
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
      // One settle call per chapter; the scripted model is unpriced.
      usage: { calls: 3, inputTokens: 300, outputTokens: 300, costUsd: null },
      availableActions: [],
    });
    expect((await current(app, book.projectId)).job!.id).toBe(jobId);

    // Applied and empty chapters count as settled; the rejected chapter is
    // read again by a new completion.
    const again = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    expect(again.statusCode, again.body).toBe(202);
    const againDetail = again.json() as BackfillDetail;
    expect(againDetail).toMatchObject({
      job: { status: "running", currentOrdinal: 2 },
      counts: { skipped: 2, pending: 1 },
      usage: { calls: 0 },
    });
    expect(againDetail.items.map((item) => item.skipReason)).toEqual([
      "already_settled",
      "already_settled",
      null,
    ]);
    const rereading = await settle(app, book.projectId, againDetail.job!.id);
    expect(rereading.items[2]).toMatchObject({ status: "settling" });
    expect(rereading.items[2]!.runId).not.toBe(detail.items[2]!.runId);
    expect(
      (
        await act(app, book.projectId, againDetail.job!.id, {
          action: "cancel",
        })
      ).json(),
    ).toMatchObject({ job: { status: "cancelled" } });

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

  it("parks a job on an unexpected error without stalling other projects, then resumes it", async () => {
    const heroes = new Map<string, string>();
    const script: ModelScript = {
      calls: [],
      costUsd: 0.002,
      respond: (call) =>
        settlement([
          fact(
            heroes.get(String(call.policy.documentId))!,
            `第${Number(call.policy.bibleBackfillOrdinal) + 1}章状态`,
            "清醒",
          ),
        ]),
    };
    const { app } = await setup(script, { enableRunWorker: true });
    const stalled = await importBook(app);
    const other = await importBook(app);
    for (const book of [stalled, other]) {
      for (const chapter of book.chapters) {
        heroes.set(chapter.documentId, book.heroId);
      }
    }
    // The first auto-apply of the stalled project throws something that is
    // not a settlement error, as a vanished entity would.
    const apply = SettlementApplicationService.prototype.apply;
    let thrown = false;
    vi.spyOn(
      SettlementApplicationService.prototype,
      "apply",
    ).mockImplementation(function (
      this: SettlementApplicationService,
      input: Parameters<SettlementApplicationService["apply"]>[0],
    ) {
      if (!thrown && input.projectId === stalled.projectId) {
        thrown = true;
        throw new Error("canon entity vanished mid-apply");
      }
      return apply.call(this, input);
    });

    const stalledJob = (
      (
        await startBackfill(app, stalled.projectId, {
          requestId: globalThis.crypto.randomUUID(),
          mode: "auto_apply_stop_on_conflict",
        })
      ).json() as BackfillDetail
    ).job!.id;
    const otherJob = await startBackfill(app, other.projectId, {
      requestId: globalThis.crypto.randomUUID(),
      mode: "auto_apply_stop_on_conflict",
    });
    expect(otherJob.statusCode, otherJob.body).toBe(202);

    const parked = await waitFor(app, stalled.projectId, (state) =>
      state.job?.status === "awaiting_user" ? state : null,
    );
    expect(parked.job).toMatchObject({
      status: "awaiting_user",
      error: {
        code: "bible_backfill.unexpected",
        message: "canon entity vanished mid-apply",
        ordinal: 0,
      },
    });
    expect(parked.items[0]!.status).toBe("awaiting_decision");
    expect(parked.availableActions).toEqual(
      expect.arrayContaining(["resume", "cancel"]),
    );

    // The other project's job keeps advancing to the end meanwhile.
    const finished = await waitFor(app, other.projectId, (state) =>
      state.job?.status === "completed" ? state : null,
    );
    expect(finished.counts).toMatchObject({ applied: 3 });
    expect(finished.usage).toMatchObject({
      calls: 3,
      inputTokens: 300,
      outputTokens: 300,
    });
    expect(finished.usage.costUsd).toBeCloseTo(0.006, 10);
    const stillParked = await current(app, stalled.projectId);
    expect(stillParked.job!.status).toBe("awaiting_user");
    expect(stillParked.items.map((item) => item.status)).toEqual([
      "awaiting_decision",
      "pending",
      "pending",
    ]);

    // Resume retries the same transition and the job runs to completion.
    const resumed = await act(app, stalled.projectId, stalledJob, {
      action: "resume",
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const done = await waitFor(app, stalled.projectId, (state) =>
      state.job?.status === "completed" ? state : null,
    );
    expect(done).toMatchObject({
      job: { error: null },
      counts: { applied: 3 },
      usage: { calls: 3 },
    });
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

async function commitChapter(
  app: App,
  projectId: string,
  documentId: string,
  content: string,
  expectedCurrentVersionId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/documents/${documentId}/versions`,
    payload: { content, source: "manual", expectedCurrentVersionId },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}

function originOf(run: { policy: Record<string, unknown> }): string {
  return (run.policy.origin as { surface: string }).surface;
}

describe("Story Bible backfill with mid-job edits and author canon", () => {
  it("re-targets a chapter edited while it waits and settles only its current text", async () => {
    let heroId = "";
    const script: ModelScript = {
      calls: [],
      respond: (call) =>
        settlement([
          fact(
            heroId,
            `第${Number(call.policy.bibleBackfillOrdinal) + 1}章状态`,
            "清醒",
          ),
        ]),
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;

    // Chapter 1 is the next item to start; chapter 2 waits behind it.
    const first = await commitChapter(
      app,
      book.projectId,
      book.chapters[0]!.documentId,
      "雾退了。\n\n林昼推开灯塔的门，看见一条新的航线。",
      book.chapters[0]!.versionId,
    );
    const second = await commitChapter(
      app,
      book.projectId,
      book.chapters[1]!.documentId,
      "旧邮局改成了灯塔的仓库。\n\n林昼把空白信交给了父亲。",
      book.chapters[1]!.versionId,
    );
    // No separate writing-path settlement was started for either edit.
    expect(await settlementRuns(app, book.projectId)).toEqual([]);
    let detail = await current(app, book.projectId);
    expect(detail.items[0]).toMatchObject({
      status: "pending",
      versionId: first,
      note: {
        code: "bible_backfill.item.retargeted",
        retargetedFromVersionId: book.chapters[0]!.versionId,
      },
    });
    expect(detail.items[1]).toMatchObject({
      status: "pending",
      versionId: second,
      note: {
        code: "bible_backfill.item.retargeted",
        retargetedFromVersionId: book.chapters[1]!.versionId,
      },
    });

    detail = await settle(app, book.projectId, jobId);
    const runs = await settlementRuns(app, book.projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: detail.items[0]!.runId,
      policy: {
        documentVersionId: first,
        origin: { surface: "bible-backfill" },
      },
    });
    expect(await driveRun(app, book.projectId, runs[0]!.id)).toBe("completed");
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]!.content).toContain("新的航线");
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[0]).toMatchObject({ status: "awaiting_decision" });
    // The change set records the chapter it settled, for anchoring at apply.
    expect(
      new SqliteReviewRepository(database).requireCanonChangeSet(
        book.projectId,
        detail.items[0]!.changeSetId!,
      ).changes,
    ).toMatchObject({ settledOutlineNodeId: book.chapters[0]!.outlineNodeId });
  });

  it("re-targets a chapter edited while it is settled or awaiting review", async () => {
    let heroId = "";
    const script: ModelScript = {
      calls: [],
      respond: () => settlement([fact(heroId, "状态", "清醒")]),
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    const chapter = book.chapters[0]!;

    let detail = await settle(app, book.projectId, jobId);
    const superseded = detail.items[0]!.runId!;
    expect(detail.items[0]!.status).toBe("settling");

    // Edited while its settlement is queued: the job's run is cancelled and
    // the job settles the new text instead.
    const v2 = await commitChapter(
      app,
      book.projectId,
      chapter.documentId,
      "第二稿：雾退了，灯塔亮着。\n\n林昼沿着码头走回家。",
      chapter.versionId,
    );
    detail = await current(app, book.projectId);
    expect(detail.items[0]).toMatchObject({
      status: "pending",
      versionId: v2,
      runId: null,
      note: {
        code: "bible_backfill.item.retargeted",
        retargetedFromVersionId: chapter.versionId,
        supersededRunId: superseded,
        supersededRunAction: "cancelled",
      },
    });
    let runs = await settlementRuns(app, book.projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: superseded, status: "cancelled" });

    detail = await settle(app, book.projectId, jobId);
    const secondRun = detail.items[0]!.runId!;
    expect(secondRun).not.toBe(superseded);
    expect(await driveRun(app, book.projectId, secondRun)).toBe("completed");
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("awaiting_decision");
    const staleChangeSet = detail.items[0]!.changeSetId!;

    // Edited while its change set awaits review: the undecided change set
    // stays reviewable in Studio and the job reads the newest text.
    const v3 = await commitChapter(
      app,
      book.projectId,
      chapter.documentId,
      "第三稿：雾散尽，港口的钟重新敲响。\n\n林昼终于睡着了。",
      v2,
    );
    detail = await current(app, book.projectId);
    expect(detail.job!.status).toBe("running");
    expect(detail.items[0]).toMatchObject({
      status: "pending",
      versionId: v3,
      changeSetId: null,
      note: {
        code: "bible_backfill.item.retargeted",
        retargetedFromVersionId: v2,
        supersededRunId: secondRun,
        supersededRunAction: "finished",
        supersededChangeSetId: staleChangeSet,
      },
    });
    expect(
      new SqliteReviewRepository(database).requireCanonChangeSet(
        book.projectId,
        staleChangeSet,
      ).status,
    ).toBe("candidate");
    detail = await settle(app, book.projectId, jobId);
    expect(await driveRun(app, book.projectId, detail.items[0]!.runId!)).toBe(
      "completed",
    );
    runs = await settlementRuns(app, book.projectId);
    expect(runs.map(originOf)).toEqual([
      "bible-backfill",
      "bible-backfill",
      "bible-backfill",
    ]);
    // The cancelled run never reached the model; each later text once.
    expect(script.calls.map((call) => call.runId)).toEqual([
      secondRun,
      detail.items[0]!.runId,
    ]);
    expect(script.calls[1]!.content).toContain("港口的钟重新敲响");
  });

  it("adopts an undecided Studio settlement of the same text instead of settling it again", async () => {
    let heroId = "";
    const script: ModelScript = {
      calls: [],
      respond: (call) =>
        originOf(call) === "writing"
          ? settlement([fact(heroId, "信件", "空白信")])
          : settlement([
              fact(
                heroId,
                `第${Number(call.policy.bibleBackfillOrdinal) + 1}章状态`,
                "清醒",
              ),
            ]),
    };
    const { app } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    // Before the completion: chapter 2 is revised in Studio and settled
    // there; its change set is still undecided.
    const revised = await commitChapter(
      app,
      book.projectId,
      book.chapters[1]!.documentId,
      "旧邮局的柜台积着盐霜。\n\n林昼找到一封写给自己的空白信。",
      book.chapters[1]!.versionId,
    );
    const studioRun = (await settlementRuns(app, book.projectId))[0]!;
    expect(originOf(studioRun)).toBe("writing");
    expect(await driveRun(app, book.projectId, studioRun.id)).toBe("completed");

    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const createdDetail = created.json() as BackfillDetail;
    expect(createdDetail.items[1]).toMatchObject({
      versionId: revised,
      status: "pending",
      skipReason: null,
    });
    const jobId = createdDetail.job!.id;
    let detail = await settle(app, book.projectId, jobId);
    expect(await driveRun(app, book.projectId, detail.items[0]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
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
    detail = await settle(app, book.projectId, jobId);
    const studioChangeSet = `${studioRun.id}:canon-change-set`;
    expect(detail.job!.status).toBe("awaiting_decision");
    expect(detail.items[1]).toMatchObject({
      status: "awaiting_decision",
      runId: studioRun.id,
      changeSetId: studioChangeSet,
      note: {
        code: "bible_backfill.item.adopted",
        adoptedRunId: studioRun.id,
        adoptedChangeSetId: studioChangeSet,
        adoptedOutcome: "candidate",
      },
    });
    // The same text was not settled a second time.
    expect(await settlementRuns(app, book.projectId)).toHaveLength(2);
    expect(script.calls).toHaveLength(2);

    expect(
      (await decide(app, book.projectId, studioChangeSet, "apply")).statusCode,
    ).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[1]!.status).toBe("applied");
    expect(detail.items[2]!.status).toBe("settling");
  });

  it("adopts an in-flight Studio settlement and detaches it on cancel", async () => {
    const script: ModelScript = { calls: [], respond: () => settlement() };
    const { app } = await setup(script);
    const book = await importBook(app);
    const revised = await commitChapter(
      app,
      book.projectId,
      book.chapters[0]!.documentId,
      "雾从海面推上石阶。\n\n林昼听见第三下钟声。",
      book.chapters[0]!.versionId,
    );
    const studioRun = (await settlementRuns(app, book.projectId))[0]!;
    expect(studioRun).toMatchObject({
      status: "pending",
      policy: { documentVersionId: revised },
    });

    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    const detail = await settle(app, book.projectId, jobId);
    expect(detail.items[0]).toMatchObject({
      status: "settling",
      runId: studioRun.id,
      note: {
        code: "bible_backfill.item.adopted",
        adoptedRunId: studioRun.id,
        adoptedOutcome: "in_progress",
      },
    });
    expect(await settlementRuns(app, book.projectId)).toHaveLength(1);

    const cancelled = await act(app, book.projectId, jobId, {
      action: "cancel",
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({
      job: { status: "cancelled" },
      items: [
        {
          status: "pending",
          runId: null,
          note: {
            code: "bible_backfill.item.detached",
            detachedRunId: studioRun.id,
          },
        },
        { status: "pending" },
        { status: "pending" },
      ],
    });
    // The author's Studio settlement was left running and still finishes.
    expect(
      (await settlementRuns(app, book.projectId)).find(
        (run) => run.id === studioRun.id,
      )?.status,
    ).toBe("pending");
    expect(await driveRun(app, book.projectId, studioRun.id)).toBe("completed");
  });

  it("pauses without pausing an adopted Studio settlement, which is detached still running", async () => {
    const script: ModelScript = { calls: [], respond: () => settlement() };
    const { app } = await setup(script);
    const book = await importBook(app);
    await commitChapter(
      app,
      book.projectId,
      book.chapters[0]!.documentId,
      "雾从海面推上石阶。\n\n林昼听见第三下钟声。",
      book.chapters[0]!.versionId,
    );
    const studioRun = (await settlementRuns(app, book.projectId))[0]!;
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    let detail = await settle(app, book.projectId, jobId);
    expect(detail.items[0]).toMatchObject({
      status: "settling",
      runId: studioRun.id,
    });

    // Pausing the completion leaves the author's Studio run alone.
    const paused = await act(app, book.projectId, jobId, { action: "pause" });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({ job: { status: "paused" } });
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("paused");
    const studioRunNow = async () =>
      (await settlementRuns(app, book.projectId)).find(
        (run) => run.id === studioRun.id,
      );
    expect(await studioRunNow()).toMatchObject({
      status: "pending",
      pauseRequested: false,
    });

    const cancelled = await act(app, book.projectId, jobId, {
      action: "cancel",
    });
    expect(cancelled.json()).toMatchObject({
      job: { status: "cancelled" },
      items: [
        {
          status: "pending",
          note: {
            code: "bible_backfill.item.detached",
            detachedRunId: studioRun.id,
          },
        },
        { status: "pending" },
        { status: "pending" },
      ],
    });
    expect(await studioRunNow()).toMatchObject({
      status: "pending",
      pauseRequested: false,
    });
    expect(await driveRun(app, book.projectId, studioRun.id)).toBe("completed");
  });

  it("hands an edited chapter it never read back to the writing path on cancel", async () => {
    const script: ModelScript = { calls: [], respond: () => settlement() };
    const { app } = await setup(script);
    const book = await importBook(app);
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    const revised = await commitChapter(
      app,
      book.projectId,
      book.chapters[1]!.documentId,
      "旧邮局改成了灯塔的仓库。\n\n林昼把空白信交给了父亲。",
      book.chapters[1]!.versionId,
    );
    expect(await settlementRuns(app, book.projectId)).toEqual([]);

    const cancelled = await act(app, book.projectId, jobId, {
      action: "cancel",
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const detail = cancelled.json() as BackfillDetail;
    const runs = await settlementRuns(app, book.projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "pending",
      policy: { documentVersionId: revised, origin: { surface: "writing" } },
    });
    expect(detail.items[1]).toMatchObject({
      status: "pending",
      note: {
        code: "bible_backfill.item.handed_back",
        retargetedFromVersionId: book.chapters[1]!.versionId,
        handedBackRunId: runs[0]!.id,
      },
    });
    // Chapters that were never edited are not settled behind the author's back.
    expect(detail.items[0]!.note).toBeNull();
    expect(detail.items[2]!.note).toBeNull();
    expect(await driveRun(app, book.projectId, runs[0]!.id)).toBe("completed");
  });

  it("keeps a finished chapter's real outcome when the job is cancelled", async () => {
    let heroId = "";
    const script: ModelScript = {
      calls: [],
      respond: () => settlement([fact(heroId, "状态", "清醒")]),
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    const detail = await settle(app, book.projectId, jobId);
    const runId = detail.items[0]!.runId!;
    // The run finishes, but the job is cancelled before it reconciles.
    expect(await driveRun(app, book.projectId, runId)).toBe("completed");
    const cancelled = await act(app, book.projectId, jobId, {
      action: "cancel",
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const changeSetId = `${runId}:canon-change-set`;
    expect(cancelled.json()).toMatchObject({
      job: { status: "cancelled" },
      items: [
        { status: "awaiting_decision", changeSetId, error: null },
        { status: "pending" },
        { status: "pending" },
      ],
      counts: { awaitingDecision: 1, failed: 0 },
    });
    // Its change set stays reviewable in Studio.
    expect(
      new SqliteReviewRepository(database).requireCanonChangeSet(
        book.projectId,
        changeSetId,
      ).status,
    ).toBe("candidate");
  });

  it("pauses while awaiting a decision, takes a Studio decision and resumes", async () => {
    let heroId = "";
    const script: ModelScript = {
      calls: [],
      respond: () => settlement([fact(heroId, "状态", "清醒")]),
    };
    const { app } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    let detail = await settle(app, book.projectId, jobId);
    expect(await driveRun(app, book.projectId, detail.items[0]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("awaiting_decision");

    const paused = await act(app, book.projectId, jobId, { action: "pause" });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({ job: { status: "paused" } });
    // Decided in Studio while paused: recorded, but nothing advances.
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
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("paused");
    expect(detail.items.map((item) => item.status)).toEqual([
      "awaiting_decision",
      "pending",
      "pending",
    ]);
    expect(await settlementRuns(app, book.projectId)).toHaveLength(1);

    const resumed = await act(app, book.projectId, jobId, {
      action: "resume",
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("running");
    expect(detail.items[0]!.status).toBe("applied");
    expect(detail.items[1]!.status).toBe("settling");
  });

  it("stops auto-apply before it changes records this job and the import did not create", async () => {
    let heroId = "";
    let projectId = "";
    let readCanon: () => SqliteCanonRepository = () => {
      throw new Error("not ready");
    };
    const now = new Date().toISOString();
    const script: ModelScript = {
      calls: [],
      respond: (call) => {
        const ordinal = call.policy.bibleBackfillOrdinal;
        if (ordinal === 0) return settlement([fact(heroId, "航线", "北方")]);
        if (ordinal === 1) {
          const route = readCanon()
            .listEffectiveFacts(projectId)
            .find((candidate) => candidate.predicate === "航线");
          return {
            ...settlement([
              fact(heroId, "航线", "南方", {
                operation: "supersede",
                factId: route?.id ?? null,
              }),
            ]),
            relationshipCandidates: [
              {
                action: "end",
                relationshipId: "imported-relation",
                fromEntityId: heroId,
                toEntityId: "rival",
                relation: "对手",
                change: "两人在旧邮局和解",
                evidenceParagraphs: [1],
              },
            ],
          };
        }
        return {
          ...settlement([
            fact(heroId, "身份", "守灯人", {
              operation: "supersede",
              factId: "author-identity",
              knowledgeScope: "omniscient",
              knowledgeSubjectId: null,
            }),
          ]),
          foreshadowCandidates: [
            {
              foreshadowId: "unsourced-foreshadow",
              title: "空白信",
              action: "resolve",
              expectedStatus: "planted",
              importance: 3,
              targetFromNodeId: null,
              targetToNodeId: null,
              evidenceParagraphs: [1],
            },
          ],
        };
      },
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    const canon = new SqliteCanonRepository(database);
    const state = new SqliteNarrativeStateRepository(
      database,
      canon,
      new SqliteStoryRepository(database),
    );
    readCanon = () => canon;
    projectId = book.projectId;
    canon.insertEntity(
      createCanonEntity({
        id: "rival",
        projectId: book.projectId,
        type: "character",
        name: "沈潮",
        now,
      }),
    );
    // An author-entered, unlocked fact.
    canon.insertFact(
      createCanonFact({
        id: "author-identity",
        projectId: book.projectId,
        subjectId: heroId,
        predicate: "身份",
        value: "邮差",
        authority: "confirmed",
        sourceType: "author",
        now,
      }),
    );
    // A relationship the manuscript import created (sourced from its candidate).
    const batch = database.raw
      .prepare("SELECT id FROM import_batches WHERE target_project_id = ?")
      .get(book.projectId) as { id: string };
    database.raw
      .prepare(
        `INSERT INTO import_candidates(
           id, batch_id, kind, ordinal, title, payload_json, status, created_at, updated_at
         ) VALUES (?, ?, 'relationship', 900, ?, '{}', 'applied', ?, ?)`,
      )
      .run("imported-relation-candidate", batch.id, "林昼与沈潮", now, now);
    state.insertRelationship({
      id: "imported-relation",
      projectId: book.projectId,
      fromEntityId: heroId,
      toEntityId: "rival",
      relation: "对手",
      intensity: null,
      state: {},
      outlineNodeId: null,
      storyTime: null,
      sourceId: "imported-relation-candidate",
      supersedesEventId: null,
      createdAt: now,
    });
    // A foreshadow with no recorded source (entered by the author, or
    // imported before sources were recorded) counts as the author's.
    state.insertForeshadow({
      id: "unsourced-foreshadow",
      projectId: book.projectId,
      title: "空白信",
      description: "无人认领的空白信。",
      status: "planted",
      importance: 3,
      targetFromNodeId: null,
      targetToNodeId: null,
      dependencies: [],
      evidenceNodeIds: [],
      resolutionNodeId: null,
      sourceId: null,
      createdAt: now,
      updatedAt: now,
    });

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
    // Chapter 2 replaces this job's own fact and ends the imported
    // relationship: applied without stopping.
    expect(await driveRun(app, book.projectId, detail.items[1]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[1]!.status).toBe("applied");
    expect(
      canon
        .listEffectiveFacts(book.projectId)
        .filter((candidate) => candidate.predicate === "航线")
        .map((candidate) => candidate.value),
    ).toEqual(["南方"]);
    expect(
      state
        .listCurrentRelationships(book.projectId)
        .find((event) => event.supersedesEventId === "imported-relation")
        ?.state,
    ).toMatchObject({ status: "ended" });

    // Chapter 3 would replace the author's fact and resolve a foreshadow of
    // unknown origin: the job stops for review and changes nothing.
    expect(await driveRun(app, book.projectId, detail.items[2]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    const changeSetId = detail.items[2]!.changeSetId!;
    expect(detail.job).toMatchObject({
      status: "awaiting_user",
      error: {
        code: "bible_backfill.review_required",
        ordinal: 2,
        changeSetId,
        targets: [
          {
            path: "factCandidates.0",
            kind: "fact",
            action: "supersede",
            id: "author-identity",
            label: "林昼 · 身份: 邮差",
          },
          {
            path: "foreshadowCandidates.0",
            kind: "foreshadow",
            action: "resolve",
            id: "unsourced-foreshadow",
            label: "空白信",
          },
        ],
      },
    });
    expect(detail.items[2]!.status).toBe("awaiting_decision");
    expect(canon.getFact(book.projectId, "author-identity")).toBeTruthy();
    expect(
      canon
        .listEffectiveFacts(book.projectId)
        .find((candidate) => candidate.predicate === "身份")?.id,
    ).toBe("author-identity");
    expect(
      state
        .listForeshadows(book.projectId)
        .find((item) => item.id === "unsourced-foreshadow")?.status,
    ).toBe("planted");

    // Resuming without a review stops again, explicitly.
    expect(
      (await act(app, book.projectId, jobId, { action: "resume" })).statusCode,
    ).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.error).toMatchObject({
      code: "bible_backfill.review_required",
    });

    // The author reviews and applies the chapter, then the job finishes.
    expect(
      (await decide(app, book.projectId, changeSetId, "apply")).statusCode,
    ).toBe(200);
    expect(
      (await act(app, book.projectId, jobId, { action: "resume" })).statusCode,
    ).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail).toMatchObject({
      job: { status: "completed" },
      counts: { applied: 3 },
    });
    expect(
      canon
        .listEffectiveFacts(book.projectId)
        .find((candidate) => candidate.predicate === "身份"),
    ).toMatchObject({ value: "守灯人", supersedesFactId: "author-identity" });
  });

  it("stops auto-apply before it develops an author's foreshadow or reopens a finished one", async () => {
    let projectId = "";
    let readState: () => SqliteNarrativeStateRepository = () => {
      throw new Error("not ready");
    };
    const now = new Date().toISOString();
    const planted = () =>
      readState()
        .listForeshadows(projectId)
        .find((item) => item.title === "灯塔钥匙")!;
    const foreshadow = (overrides: Record<string, unknown>) => ({
      foreshadowId: null,
      title: "灯塔钥匙",
      action: "plant",
      expectedStatus: null,
      importance: 3,
      targetFromNodeId: null,
      targetToNodeId: null,
      evidenceParagraphs: [1],
      ...overrides,
    });
    const script: ModelScript = {
      calls: [],
      respond: (call) => {
        const ordinal = call.policy.bibleBackfillOrdinal;
        if (ordinal === 0) {
          return { ...settlement(), foreshadowCandidates: [foreshadow({})] };
        }
        if (ordinal === 1) {
          return {
            ...settlement(),
            foreshadowCandidates: [
              foreshadow({
                foreshadowId: planted().id,
                action: "develop",
                expectedStatus: "planted",
              }),
            ],
          };
        }
        return {
          ...settlement(),
          foreshadowCandidates: [
            foreshadow({
              foreshadowId: planted().id,
              action: "develop",
              expectedStatus: "resolved",
            }),
            foreshadow({
              foreshadowId: "author-foreshadow",
              title: "空白信",
              action: "develop",
              expectedStatus: "developing",
            }),
          ],
        };
      },
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    projectId = book.projectId;
    const state = new SqliteNarrativeStateRepository(
      database,
      new SqliteCanonRepository(database),
      new SqliteStoryRepository(database),
    );
    readState = () => state;
    state.insertForeshadow({
      id: "author-foreshadow",
      projectId: book.projectId,
      title: "空白信",
      description: "无人认领的空白信。",
      status: "developing",
      importance: 3,
      targetFromNodeId: null,
      targetToNodeId: null,
      dependencies: [],
      evidenceNodeIds: [],
      resolutionNodeId: null,
      sourceId: null,
      createdAt: now,
      updatedAt: now,
    });

    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
      mode: "auto_apply_stop_on_conflict",
    });
    expect(created.statusCode, created.body).toBe(202);
    const jobId = (created.json() as BackfillDetail).job!.id;
    let detail = await settle(app, book.projectId, jobId);
    for (const ordinal of [0, 1]) {
      expect(
        await driveRun(app, book.projectId, detail.items[ordinal]!.runId!),
      ).toBe("completed");
      detail = await settle(app, book.projectId, jobId);
      expect(detail.items[ordinal]!.status).toBe("applied");
    }
    // Developing the foreshadow this job planted applies without stopping.
    expect(planted().status).toBe("developing");
    // The author then resolves it.
    state.updateForeshadow({
      ...planted(),
      status: "resolved",
      updatedAt: now,
    });

    // Chapter 3 would reopen it and develop the author's own foreshadow.
    expect(await driveRun(app, book.projectId, detail.items[2]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job).toMatchObject({
      status: "awaiting_user",
      error: {
        code: "bible_backfill.review_required",
        ordinal: 2,
        targets: [
          {
            path: "foreshadowCandidates.0",
            kind: "foreshadow",
            action: "develop",
            id: planted().id,
            reopens: true,
          },
          {
            path: "foreshadowCandidates.1",
            kind: "foreshadow",
            action: "develop",
            id: "author-foreshadow",
          },
        ],
      },
    });
    expect(
      (detail.job!.error!.targets as Record<string, unknown>[])[1],
    ).not.toHaveProperty("reopens");
    expect(planted().status).toBe("resolved");
    expect(
      state
        .listForeshadows(book.projectId)
        .find((item) => item.id === "author-foreshadow")?.evidenceNodeIds,
    ).toEqual([]);
  });

  it("anchors an imported timeline event instead of duplicating it, and stops before anchoring the author's", async () => {
    const now = new Date().toISOString();
    const anchor = (eventId: string, title: string) => ({
      anchorEventId: eventId,
      title,
      description: null,
      storyTime: null,
      participantIds: [],
      causeEventIds: [],
      visibility: "reader",
      knownBy: [],
      evidenceParagraphs: [1],
    });
    const script: ModelScript = {
      calls: [],
      respond: (call) => {
        const ordinal = call.policy.bibleBackfillOrdinal;
        if (ordinal === 0) {
          return {
            ...settlement(),
            timelineCandidates: [anchor("imported-bell", "灯塔敲响第三下钟")],
          };
        }
        if (ordinal === 1) {
          return {
            ...settlement(),
            timelineCandidates: [anchor("author-letter", "找到空白信")],
          };
        }
        return settlement();
      },
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    const state = new SqliteNarrativeStateRepository(
      database,
      new SqliteCanonRepository(database),
      new SqliteStoryRepository(database),
    );
    // A timeline event the manuscript import created (sourced from its
    // candidate), and one the author entered; neither is anchored yet.
    const batch = database.raw
      .prepare("SELECT id FROM import_batches WHERE target_project_id = ?")
      .get(book.projectId) as { id: string };
    database.raw
      .prepare(
        `INSERT INTO import_candidates(
           id, batch_id, kind, ordinal, title, payload_json, status, created_at, updated_at
         ) VALUES (?, ?, 'timeline', 902, ?, '{}', 'applied', ?, ?)`,
      )
      .run("imported-bell-candidate", batch.id, "灯塔敲响第三下钟", now, now);
    for (const [id, title, sequence, sourceId] of [
      ["imported-bell", "灯塔敲响第三下钟", 1, "imported-bell-candidate"],
      ["author-letter", "找到空白信", 2, null],
    ] as const) {
      state.insertTimelineEvent({
        id,
        projectId: book.projectId,
        title,
        description: null,
        outlineNodeId: null,
        storyTimeStart: null,
        storyTimeEnd: null,
        sequence,
        participants: [],
        causes: [],
        visibility: "reader",
        sourceId,
        createdAt: now,
        updatedAt: now,
      });
    }
    const event = (id: string) =>
      state.listTimeline(book.projectId).find((item) => item.id === id)!;

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
    // The settlement saw both unanchored events with their ids.
    expect(script.calls[0]!.content).toContain(
      "[timeline:imported-bell] #1 灯塔敲响第三下钟",
    );
    expect(script.calls[0]!.content).toContain(
      "[timeline:author-letter] #2 找到空白信",
    );
    detail = await settle(app, book.projectId, jobId);
    // Anchoring the imported event applies without stopping, and creates
    // no second event for the same thing.
    expect(detail.items[0]!.status).toBe("applied");
    expect(state.listTimeline(book.projectId)).toHaveLength(2);
    expect(event("imported-bell")).toMatchObject({
      title: "灯塔敲响第三下钟",
      outlineNodeId: book.chapters[0]!.outlineNodeId,
      sourceId: "imported-bell-candidate",
    });

    // Anchoring the author's event waits for review and changes nothing.
    expect(await driveRun(app, book.projectId, detail.items[1]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    const changeSetId = detail.items[1]!.changeSetId!;
    expect(detail.job).toMatchObject({
      status: "awaiting_user",
      error: {
        code: "bible_backfill.review_required",
        ordinal: 1,
        changeSetId,
        targets: [
          {
            path: "timelineCandidates.0",
            kind: "timeline",
            action: "anchor",
            id: "author-letter",
            label: "找到空白信",
          },
        ],
      },
    });
    expect(event("author-letter").outlineNodeId).toBeNull();

    // The author applies the chapter; the completion then finishes.
    expect(
      (await decide(app, book.projectId, changeSetId, "apply")).statusCode,
    ).toBe(200);
    expect(
      (await act(app, book.projectId, jobId, { action: "resume" })).statusCode,
    ).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail.items[1]!.status).toBe("applied");
    expect(detail.items[2]!.status).toBe("settling");
    expect(await driveRun(app, book.projectId, detail.items[2]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job).toMatchObject({ status: "completed" });
    expect(event("author-letter").outlineNodeId).toBe(
      book.chapters[1]!.outlineNodeId,
    );
    expect(state.listTimeline(book.projectId)).toHaveLength(2);
  });

  it("develops and resolves an imported foreshadow without stopping, but not reopens it", async () => {
    const now = new Date().toISOString();
    const imported = (action: string, expectedStatus: string) => ({
      foreshadowId: "imported-letter",
      title: "空白信",
      action,
      expectedStatus,
      importance: 3,
      targetFromNodeId: null,
      targetToNodeId: null,
      evidenceParagraphs: [1],
    });
    const script: ModelScript = {
      calls: [],
      respond: (call) => {
        const ordinal = call.policy.bibleBackfillOrdinal;
        return {
          ...settlement(),
          foreshadowCandidates: [
            ordinal === 0
              ? imported("develop", "planted")
              : ordinal === 1
                ? imported("resolve", "developing")
                : imported("develop", "resolved"),
          ],
        };
      },
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    const state = new SqliteNarrativeStateRepository(
      database,
      new SqliteCanonRepository(database),
      new SqliteStoryRepository(database),
    );
    // A foreshadow the manuscript import created (sourced from its candidate).
    const batch = database.raw
      .prepare("SELECT id FROM import_batches WHERE target_project_id = ?")
      .get(book.projectId) as { id: string };
    database.raw
      .prepare(
        `INSERT INTO import_candidates(
           id, batch_id, kind, ordinal, title, payload_json, status, created_at, updated_at
         ) VALUES (?, ?, 'foreshadow', 901, ?, '{}', 'applied', ?, ?)`,
      )
      .run("imported-letter-candidate", batch.id, "空白信", now, now);
    state.insertForeshadow({
      id: "imported-letter",
      projectId: book.projectId,
      title: "空白信",
      description: "无人认领的空白信。",
      status: "planted",
      importance: 3,
      targetFromNodeId: null,
      targetToNodeId: null,
      dependencies: [],
      evidenceNodeIds: [],
      resolutionNodeId: null,
      sourceId: "imported-letter-candidate",
      createdAt: now,
      updatedAt: now,
    });
    const letter = () =>
      state
        .listForeshadows(book.projectId)
        .find((item) => item.id === "imported-letter")!;

    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
      mode: "auto_apply_stop_on_conflict",
    });
    expect(created.statusCode, created.body).toBe(202);
    const jobId = (created.json() as BackfillDetail).job!.id;
    let detail = await settle(app, book.projectId, jobId);
    for (const ordinal of [0, 1]) {
      expect(
        await driveRun(app, book.projectId, detail.items[ordinal]!.runId!),
      ).toBe("completed");
      detail = await settle(app, book.projectId, jobId);
      expect(detail.items[ordinal]!.status).toBe("applied");
    }
    expect(letter()).toMatchObject({
      status: "resolved",
      resolutionNodeId: book.chapters[1]!.outlineNodeId,
      sourceId: "imported-letter-candidate",
    });
    expect([...letter().evidenceNodeIds].sort()).toEqual(
      [book.chapters[0]!.outlineNodeId, book.chapters[1]!.outlineNodeId].sort(),
    );

    // Reopening the resolved foreshadow is the author's call.
    expect(await driveRun(app, book.projectId, detail.items[2]!.runId!)).toBe(
      "completed",
    );
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job).toMatchObject({
      status: "awaiting_user",
      error: {
        code: "bible_backfill.review_required",
        ordinal: 2,
        targets: [
          {
            path: "foreshadowCandidates.0",
            kind: "foreshadow",
            action: "develop",
            id: "imported-letter",
            reopens: true,
          },
        ],
      },
    });
    expect(letter().status).toBe("resolved");
  });

  it("stops auto-apply on a non-conflict settlement error and continues past a skipped chapter", async () => {
    let heroId = "";
    const script: ModelScript = {
      calls: [],
      respond: () => settlement([fact(heroId, "状态", "清醒")]),
    };
    const { app, database } = await setup(script);
    const book = await importBook(app);
    heroId = book.heroId;
    const created = await startBackfill(app, book.projectId, {
      requestId: globalThis.crypto.randomUUID(),
      mode: "auto_apply_stop_on_conflict",
    });
    const jobId = (created.json() as BackfillDetail).job!.id;
    let detail = await settle(app, book.projectId, jobId);
    const runId = detail.items[0]!.runId!;
    expect(await driveRun(app, book.projectId, runId)).toBe("completed");
    // The recorded change set can no longer be read as a settlement.
    const changeSetId = `${runId}:canon-change-set`;
    database.raw
      .prepare("UPDATE canon_change_sets SET changes_json = ? WHERE id = ?")
      .run(JSON.stringify({ summary: "损坏的变更集" }), changeSetId);

    detail = await settle(app, book.projectId, jobId);
    expect(detail.job).toMatchObject({
      status: "awaiting_user",
      error: {
        code: "settlement.changes.invalid",
        ordinal: 0,
        changeSetId,
      },
    });
    expect(detail.items[0]!.status).toBe("awaiting_decision");
    expect(detail.availableActions).toEqual(
      expect.arrayContaining(["resume", "skip_item", "cancel"]),
    );

    const skipped = await act(app, book.projectId, jobId, {
      action: "skip_item",
      ordinal: 0,
    });
    expect(skipped.statusCode, skipped.body).toBe(200);
    detail = await settle(app, book.projectId, jobId);
    expect(detail.job!.status).toBe("running");
    expect(detail.items[0]).toMatchObject({
      status: "skipped",
      skipReason: "author_skipped",
    });
    expect(detail.items[1]!.status).toBe("settling");
    expect(
      new SqliteReviewRepository(database).requireCanonChangeSet(
        book.projectId,
        changeSetId,
      ).status,
    ).toBe("candidate");
  });
});
