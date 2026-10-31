import { createServer, type Server } from "node:http";

import { NodeNarrativeDatabase } from "@lapis/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

/**
 * Manual chapter settlement: when the author formally commits a manuscript
 * version (source=manual) or restores a version, a manual-settlement Run starts
 * automatically; with no usable writing model it is skipped silently, so manual
 * writing is never blocked.
 */

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
  provider: FakeProvider | null;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()!;
    await resource.app.close();
    resource.database.close();
    await resource.provider?.close();
  }
});

/**
 * Response body of the settlement structured call; subjectId is injected after
 * the entity is created.
 */
let settlementSubjectId: string | null = null;
let settlementWithCandidates = true;

const MANUSCRIPT =
  "雾从海面推上石阶，林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。\n\n" +
  "灯灭的一刻，父亲忽然问她为何对着空椅子说话。窗外所有船铃同时沉默。\n\n" +
  "她合上日志，吹熄油灯，摸黑走下旋梯。海面在脚下翻涌，雾里没有一艘船亮着灯。";

function settlementPayload(): string {
  if (!settlementWithCandidates || !settlementSubjectId) {
    return JSON.stringify({
      summary: "林昼发现灯塔熄灭会触发遗忘。",
      stateDelta: [],
      factCandidates: [],
      timelineCandidates: [],
      relationshipCandidates: [],
      foreshadowCandidates: [],
    });
  }
  return JSON.stringify({
    summary: "林昼发现灯塔熄灭会触发遗忘。",
    stateDelta: [],
    factCandidates: [
      {
        operation: "assert",
        factId: null,
        subjectId: settlementSubjectId,
        predicate: "守夜状态",
        objectEntityId: null,
        value: "独自守塔",
        knowledgeScope: "omniscient",
        knowledgeSubjectId: null,
        belief: "known",
        evidenceParagraphs: [1],
      },
    ],
    timelineCandidates: [],
    relationshipCandidates: [],
    foreshadowCandidates: [],
  });
}

interface ChatCompletionRequestBody {
  messages?: Array<{ role?: string; content?: unknown }>;
  response_format?: { json_schema?: { name?: string } };
}

function schemaNameOf(body: ChatCompletionRequestBody): string | null {
  const fromFormat = body.response_format?.json_schema?.name;
  if (fromFormat) return fromFormat;
  for (const message of body.messages ?? []) {
    if (typeof message.content !== "string") continue;
    const match = /schema named (\w+)/.exec(message.content);
    if (match) return match[1]!;
  }
  return null;
}

interface FakeProvider {
  baseUrl: string;
  close(): Promise<void>;
}

async function startFakeProvider(): Promise<FakeProvider> {
  const server: Server = createServer((request, response) => {
    request.on("error", () => {});
    response.on("error", () => {});
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as ChatCompletionRequestBody;
      const schema = schemaNameOf(body);
      if (schema !== "chapter_settlement_candidates") {
        response.writeHead(500).end(
          JSON.stringify({
            error: { message: `unexpected schema ${schema}` },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "fake-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: settlementPayload() },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 80,
            total_tokens: 200,
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake provider did not bind a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function setup(withProvider = true) {
  const provider = withProvider ? await startFakeProvider() : null;
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: {},
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database, provider });

  if (!provider) return { app, database };

  const providerResponse = await app.inject({
    method: "POST",
    url: "/api/providers",
    payload: {
      name: "本地假 Provider",
      wireApi: "openai-chat",
      baseUrl: provider.baseUrl,
      credentialRef: "fake-provider-key",
    },
  });
  expect(providerResponse.statusCode, providerResponse.body).toBe(201);
  const providerId = (providerResponse.json() as { id: string }).id;

  const modelResponse = await app.inject({
    method: "POST",
    url: "/api/models",
    payload: {
      providerId,
      modelId: "fake-model",
      taskType: "writing",
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
    },
  });
  expect(modelResponse.statusCode, modelResponse.body).toBe(201);
  const modelId = (modelResponse.json() as { id: string }).id;

  const assigned = await app.inject({
    method: "PUT",
    url: "/api/assignments/writing",
    payload: { modelId },
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return { app, database };
}

interface ChapterFixture {
  projectId: string;
  chapterId: string;
  documentId: string;
  entityId: string;
}

async function createChapterWorld(
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<ChapterFixture> {
  const projectResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      title: "潮汐灯塔",
      premise: "灯灭时港口遗忘一个人。",
    },
  });
  const projectId = (projectResponse.json() as { id: string }).id;
  const bible = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/story-bible`,
    })
  ).json() as { outline: { id: string }[] };
  const chapterResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/outline`,
    payload: {
      parentId: bible.outline[0]!.id,
      kind: "chapter",
      ordinal: 0,
      title: "雾港失灯",
      summary: "林昼回港当夜灯塔熄灭。",
      goal: "发现遗忘规则",
      conflict: "父亲否认失踪者存在",
      metadata: {},
    },
  });
  expect(chapterResponse.statusCode).toBe(201);
  const chapterId = (chapterResponse.json() as { id: string }).id;
  const entityResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/entities`,
    payload: {
      type: "character",
      name: "林昼",
      aliases: [],
      description: "守灯人的女儿。",
    },
  });
  expect(entityResponse.statusCode).toBe(201);
  const entityId = (entityResponse.json() as { id: string }).id;
  settlementSubjectId = entityId;
  const documentResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/documents`,
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      kind: "chapter",
      title: "雾港失灯",
      outlineNodeId: chapterId,
    },
  });
  expect(documentResponse.statusCode, documentResponse.body).toBe(201);
  return {
    projectId,
    chapterId,
    documentId: (documentResponse.json() as { id: string }).id,
    entityId,
  };
}

async function appendVersion(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  documentId: string,
  source: string,
  content = MANUSCRIPT,
): Promise<string> {
  /* The version list is sorted newest first, so the first entry is the current
     version. */
  const versions = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/documents/${documentId}/versions`,
    })
  ).json() as { id: string }[];
  const current = versions[0]?.id ?? null;
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/documents/${documentId}/versions`,
    payload: { content, source, expectedCurrentVersionId: current },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function listRuns(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
): Promise<
  Array<{
    id: string;
    recipe: string;
    status: string;
    targetOutlineNodeId: string | null;
    policy: Record<string, unknown>;
  }>
> {
  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/runs`,
  });
  return response.json() as never;
}

async function driveRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  runId: string,
  projectId: string,
): Promise<string> {
  let status = "pending";
  for (let index = 0; index < 40; index += 1) {
    const advanced = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(advanced.statusCode, advanced.body).toBe(200);
    const body = advanced.json() as {
      processed: boolean;
      snapshot: { run: { status: string } };
    };
    status = body.snapshot.run.status;
    if (["completed", "failed", "cancelled"].includes(status)) return status;
    if (!body.processed)
      await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return status;
}

describe("manual chapter settlement", () => {
  it("a formal version commit starts a settlement Run, stores a candidate changeset and appends no version", async () => {
    settlementWithCandidates = true;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    const versionId = await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual",
    );

    const runs = await listRuns(app, world.projectId);
    const settlementRuns = runs.filter(
      (run) => run.recipe === "manual-settlement",
    );
    expect(settlementRuns).toHaveLength(1);
    expect(settlementRuns[0]!.targetOutlineNodeId).toBeNull();
    expect(settlementRuns[0]!.policy.documentId).toBe(world.documentId);
    expect(settlementRuns[0]!.policy.documentVersionId).toBe(versionId);

    expect(await driveRun(app, settlementRuns[0]!.id, world.projectId)).toBe(
      "completed",
    );

    const changeSets = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${world.projectId}/canon-change-sets`,
      })
    ).json() as {
      changeSets: Array<{
        id: string;
        status: string;
        runId: string;
        changes: Record<string, unknown>;
      }>;
    };
    const created = changeSets.changeSets.filter(
      (set) => set.runId === settlementRuns[0]!.id,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.status).toBe("candidate");
    const facts = created[0]!.changes.factCandidates as Array<{
      subjectId: string;
      evidence: Array<{ documentVersionId: string }>;
    }>;
    expect(facts[0]!.subjectId).toBe(world.entityId);
    expect(facts[0]!.evidence[0]!.documentVersionId).toBe(versionId);

    /* Settlement appends no manuscript version: there is still only the version
       the author committed. */
    const versions = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${world.projectId}/documents/${world.documentId}/versions`,
      })
    ).json() as unknown[];
    expect(versions).toHaveLength(1);
  });

  it("an empty settlement creates no changeset (avoids noise in the decision panel)", async () => {
    settlementWithCandidates = false;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    await appendVersion(app, world.projectId, world.documentId, "manual");

    const runs = await listRuns(app, world.projectId);
    const settlementRuns = runs.filter(
      (run) => run.recipe === "manual-settlement",
    );
    expect(settlementRuns).toHaveLength(1);
    const finalStatus = await driveRun(
      app,
      settlementRuns[0]!.id,
      world.projectId,
    );
    expect(finalStatus).toBe("completed");

    const changeSets = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${world.projectId}/canon-change-sets`,
      })
    ).json() as { changeSets: unknown[] };
    expect(changeSets.changeSets).toHaveLength(0);
  });

  it("annotation save points and selection baselines do not trigger settlement", async () => {
    settlementWithCandidates = false;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual:comment-checkpoint",
    );
    await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual:selection-baseline",
    );

    const runs = await listRuns(app, world.projectId);
    expect(
      runs.filter((run) => run.recipe === "manual-settlement"),
    ).toHaveLength(0);
  });

  it("restoring a past version also triggers settlement and pins the restored version", async () => {
    settlementWithCandidates = false;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "seed",
      MANUSCRIPT,
    );
    await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual",
      `${MANUSCRIPT}\n\n尾声一句。`,
    );
    let runs = await listRuns(app, world.projectId);
    expect(
      runs.filter((run) => run.recipe === "manual-settlement"),
    ).toHaveLength(1);

    const versions = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${world.projectId}/documents/${world.documentId}/versions`,
      })
    ).json() as { id: string }[];
    const restoreResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${world.projectId}/documents/${world.documentId}/restore`,
      payload: {
        /* The list is newest first: [0] is the current version and the last
           entry is the earliest seed version. */
        targetVersionId: versions.at(-1)!.id,
        expectedCurrentVersionId: versions[0]!.id,
      },
    });
    expect(restoreResponse.statusCode, restoreResponse.body).toBe(201);
    const restoredVersionId = (restoreResponse.json() as { id: string }).id;

    runs = await listRuns(app, world.projectId);
    const settlementRuns = runs.filter(
      (run) => run.recipe === "manual-settlement",
    );
    expect(settlementRuns).toHaveLength(2);
    const restoreRun = settlementRuns.find(
      (run) => run.policy.documentVersionId === restoredVersionId,
    );
    expect(restoreRun).toBeTruthy();
  });

  it("with no usable writing model the commit still succeeds and settlement is skipped silently", async () => {
    settlementWithCandidates = false;
    const { app } = await setup(false);
    const world = await createChapterWorld(app);
    const versionId = await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual",
    );
    expect(versionId).toBeTruthy();
    const runs = await listRuns(app, world.projectId);
    expect(
      runs.filter((run) => run.recipe === "manual-settlement"),
    ).toHaveLength(0);
  });

  it("non-chapter documents (notes) do not trigger settlement", async () => {
    settlementWithCandidates = false;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    const noteResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${world.projectId}/documents`,
      payload: {
        requestId: globalThis.crypto.randomUUID(),
        kind: "note",
        title: "创作笔记",
      },
    });
    expect(noteResponse.statusCode).toBe(201);
    const noteId = (noteResponse.json() as { id: string }).id;
    await appendVersion(app, world.projectId, noteId, "manual");

    const runs = await listRuns(app, world.projectId);
    expect(
      runs.filter((run) => run.recipe === "manual-settlement"),
    ).toHaveLength(0);
  });
});
