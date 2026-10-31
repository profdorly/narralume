import type { NarrativeModelClient } from "@lapis/narrative";
import { SqliteRunRepository } from "@lapis/persistence";
import { NodeNarrativeDatabase } from "@lapis/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4329,
  environment: "test",
};

const environment = {
  NARRATIVE_LLM_API_KEY: "server-only-test-key",
  NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
  NARRATIVE_LLM_MODEL: "test-model",
  NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
  NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
};

type App = Awaited<ReturnType<typeof buildApp>>;

const apps: App[] = [];
const databases: NodeNarrativeDatabase[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
  while (databases.length) databases.pop()?.close();
});

/*
 * Co-creation is gone: no recipe creates cocreate-reply or scene-adoption
 * runs and no worker runs their steps. Libraries written by older versions
 * can still hold such runs, including pending ones. They must keep loading,
 * and a pending one must end as a failed run instead of crashing the worker.
 */
describe("runs left by the retired co-creation feature", () => {
  it("list and load, and a pending one fails with worker.missing", async () => {
    const database = newDatabase();
    const app = await startApp(database, false);
    const projectId = await createProject(app);
    const replyRunId = insertRetiredRun(database, projectId, "cocreate-reply");
    const adoptionRunId = insertRetiredRun(
      database,
      projectId,
      "scene-adoption",
    );

    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/runs`,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      (list.json() as { id: string; recipe: string }[]).map(({ id }) => id),
    ).toEqual(expect.arrayContaining([replyRunId, adoptionRunId]));

    const detail = await app.inject({
      method: "GET",
      url: `/api/runs/${replyRunId}?projectId=${projectId}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      run: { recipe: "cocreate-reply", mode: "co-create", status: "pending" },
      origin: { surface: "cocreate" },
    });

    for (const runId of [replyRunId, adoptionRunId]) {
      expect(await advanceUntilSettled(app, projectId, runId)).toBe("failed");
      const snapshot = new SqliteRunRepository(database).getSnapshot(runId);
      expect(snapshot.steps[0]).toMatchObject({
        status: "failed",
        error: { code: "worker.missing", retryable: false },
      });
      // The run stops at the first step; later steps never start.
      expect(
        snapshot.steps.slice(1).every((step) => step.status !== "running"),
      ).toBe(true);
    }

    const afterFailure = await app.inject({
      method: "GET",
      url: `/api/runs/${adoptionRunId}?projectId=${projectId}`,
    });
    expect(afterFailure.statusCode, afterFailure.body).toBe(200);
    expect(afterFailure.json()).toMatchObject({ run: { status: "failed" } });
  });

  it("the background worker fails a pending one at boot without crashing", async () => {
    const database = newDatabase();
    const seeding = await startApp(database, false);
    const projectId = await createProject(seeding);
    const runId = insertRetiredRun(database, projectId, "cocreate-reply");
    await seeding.close();
    apps.splice(apps.indexOf(seeding), 1);

    const app = await startApp(database, true);
    const runs = new SqliteRunRepository(database);
    const deadline = Date.now() + 10_000;
    while (
      runs.getSnapshot(runId).run.status !== "failed" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runs.getSnapshot(runId).run.status).toBe("failed");
    expect(runs.getSnapshot(runId).steps[0]?.error?.code).toBe(
      "worker.missing",
    );

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
  });
});

function newDatabase(): NodeNarrativeDatabase {
  const database = new NodeNarrativeDatabase();
  databases.push(database);
  return database;
}

async function startApp(
  database: NodeNarrativeDatabase,
  enableRunWorker: boolean,
): Promise<App> {
  const app = await buildApp({
    config,
    database,
    environment,
    narrativeModelClient: unusedModel(),
    enableRunWorker,
    logger: false,
  });
  apps.push(app);
  return app;
}

async function createProject(app: App): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      title: "旧共创记录",
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

/** Writes a run the way co-creation used to store it. */
function insertRetiredRun(
  database: NodeNarrativeDatabase,
  projectId: string,
  recipe: "cocreate-reply" | "scene-adoption",
): string {
  const runId = `retired-${recipe}-run`;
  const steps =
    recipe === "cocreate-reply"
      ? (["cocreate.context", "cocreate.respond", "cocreate.stage"] as const)
      : (["adoption.prepare", "adoption.settle", "adoption.commit"] as const);
  new SqliteRunRepository(database).create({
    id: runId,
    projectId,
    recipe,
    recipeVersion: 1,
    mode: "co-create",
    targetOutlineNodeId: null,
    policy: {
      sessionId: "retired-session",
      branchId: "retired-branch",
      origin: {
        surface: "cocreate",
        documentId: null,
        selection: null,
        sessionId: "retired-session",
        branchId: "retired-branch",
      },
    },
    steps: steps.map((kind, ordinal) => ({
      id: `${runId}:${kind}`,
      ordinal,
      kind,
      cycle: 0,
      idempotencyKey: `${runId}/${kind}`,
      maxAttempts: 2,
    })),
    now: new Date().toISOString(),
  });
  return runId;
}

async function advanceUntilSettled(
  app: App,
  projectId: string,
  runId: string,
): Promise<string> {
  let status = "pending";
  for (let index = 0; index < 10; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(response.statusCode, response.body).toBe(200);
    status = (response.json() as { snapshot: { run: { status: string } } })
      .snapshot.run.status;
    if (["completed", "failed", "cancelled", "awaiting_user"].includes(status))
      break;
  }
  return status;
}

function unusedModel(): NarrativeModelClient {
  const fail = () => {
    throw new Error("No model call is expected for a retired run");
  };
  return { text: fail, structured: fail } as unknown as NarrativeModelClient;
}
