import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../apps/server/src/app.js";
import type { ServerConfig } from "../apps/server/src/config.js";
import { SqliteLlmCallRepository } from "@lapis/persistence";
import { NodeNarrativeDatabase } from "@lapis/persistence/node";

import {
  configureSmokeModelTarget,
  createSmokeWorkspace,
  currentGitCommit,
  finalizeSmokeWorkspace,
  installSignalFlush,
  interruptOrphanedWork,
  originOf,
  parseRealSmokeArgs,
  RunWatcher,
  RunStateTracker,
  SmokeLogger,
  writeSmokeSummary,
  workspaceFromDir,
  type SmokeCheck,
  type SmokeWorkspace,
} from "./real-smoke-harness.js";

loadDotEnv({ path: resolve(process.cwd(), ".env.local"), quiet: true });

const scenario = "studio-real";
/** A fixed manuscript scene the selection edit rewrites with the real model. */
const SCENE_TEXT = [
  "沈砚把姐姐留下的空白信移到煤油灯上方，先在桌角放了一小碟海盐作对照。",
  "灯芯向海的方向偏了偏。信纸背面慢慢析出三枚盐晶，排成一支细小的箭头，指向门外退潮后裸露的石阶。",
  "她没有立刻拆开信封，只用指腹沿着封口的胶痕摸了一遍，确认那道折痕比她记忆中更旧。",
].join("\n\n");
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const modelIds: Record<string, string> = {
  "openai-chat": "environment-chat",
  "openai-responses": "environment-responses",
  "anthropic-messages": "environment-anthropic",
};
const args = parseRealSmokeArgs(process.argv.slice(2), {
  script: "studio-real-smoke.ts",
  defaultProtocols: ["openai-responses"],
  singleProtocol: true,
  allowResume: true,
});

if (args.resumeFrom) {
  await resumeMain(args.resumeFrom);
} else {
  await main();
}

interface ResumeState {
  protocol: string;
  modelId: string;
  projectId: string;
  documentId: string;
  versionId: string;
  completedRunIds: string[];
  diagnostic: boolean;
  keepArtifacts: boolean;
  startedAt: string;
  checks: SmokeCheck[];
  childChecks?: SmokeCheck[];
}

async function main() {
  const protocol = args.protocols[0]!;
  const modelId = modelIds[protocol];
  if (!modelId) throw new Error(`Unsupported protocol: ${protocol}`);

  const workspace = createSmokeWorkspace(scenario, {
    outputDir: args.outputDir,
  });
  const logger = new SmokeLogger(workspace.jsonlPath, scenario, {
    diagnostic: args.diagnostic,
  });
  installSignalFlush(logger);
  const startedAt = new Date().toISOString();
  const checks: SmokeCheck[] = [];

  const database = new NodeNarrativeDatabase(workspace.dbPath);
  database.migrate();
  interruptOrphanedWork(logger, database);
  const tracker = new RunStateTracker(logger, database, {
    diagnostic: args.diagnostic,
  });
  const watcher = new RunWatcher(tracker);
  watcher.startPolling();

  logger.event("scenario.start", {
    protocols: args.protocols,
    workspace: workspace.dir,
    gitCommit: currentGitCommit(),
  });

  const recordCheck = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    logger.event("scenario.check", { name, ok, ...(detail ? { detail } : {}) });
  };

  let app: FastifyInstance | null = null;
  let databaseOpen = true;
  try {
    app = await createApp(database, workspace.dbPath);
    const target = configureSmokeModelTarget(database, modelId);
    if (!target) {
      throw new Error(`${protocol} model limits/credential are not configured`);
    }
    process.stdout.write(`model ${protocol}: configured\n`);
    logger.event("model.resolved", {
      modelId,
      protocol,
      model: target.model.modelId,
      baseUrlOrigin: originOf(target.provider.baseUrl),
    });

    const project = await jsonRequest<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "回声邮局",
        premise:
          "退潮时营业的邮局能把未寄出的信送到记忆消失之前；每寄一封，寄信人会失去一段相关记忆。",
      },
      [201],
    );
    const document = await jsonRequest<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/documents`,
      {
        requestId: globalThis.crypto.randomUUID(),
        kind: "manuscript",
        title: "灯下潮痕",
        outlineNodeId: null,
      },
      [201],
    );
    const version = await jsonRequest<{ id: string; content: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/documents/${document.id}/versions`,
      {
        content: SCENE_TEXT,
        source: "manual",
        expectedCurrentVersionId: null,
      },
      [201],
    );
    process.stdout.write(`manuscript: ${version.content.length} chars saved\n`);
    recordCheck("manuscript version saved", true);
    const completedRunIds: string[] = [];

    const state: ResumeState = {
      protocol,
      modelId,
      projectId: project.id,
      documentId: document.id,
      versionId: version.id,
      completedRunIds,
      diagnostic: args.diagnostic,
      keepArtifacts: args.keepArtifacts,
      startedAt,
      checks,
    };
    writeFileSync(
      join(workspace.dir, "resume-state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    watcher.stop();
    await app.close();
    app = null;
    database.close();
    databaseOpen = false;

    logger.event("scenario.restart", { workspace: workspace.dir });
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(import.meta.url),
        `--resume-from=${workspace.dir}`,
      ],
      { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
    );
    const resumed = readResumeState(workspace);
    const childChecks = resumed?.childChecks ?? [];
    checks.push(...childChecks);
    const restartOk =
      child.status === 0 && childChecks.every((check) => check.ok);
    checks.push({
      name: "cross-process restart recovery",
      ok: restartOk,
      detail: `child exit=${child.status ?? child.error?.message ?? "unknown"}`,
    });
    logger.event("scenario.check", {
      name: "cross-process restart recovery",
      ok: restartOk,
      exitCode: child.status,
    });
    const success = restartOk && checks.every((check) => check.ok);

    const summaryDatabase = new NodeNarrativeDatabase(workspace.dbPath);
    try {
      logger.event("scenario.end", {
        success,
        durationMs: Date.now() - Date.parse(startedAt),
      });
      writeSmokeSummary({
        workspace,
        database: summaryDatabase,
        scenario,
        protocols: args.protocols,
        startedAt,
        success,
        checks,
      });
    } finally {
      summaryDatabase.close();
    }
    finalizeSmokeWorkspace(workspace, {
      success,
      keepArtifacts: args.keepArtifacts,
    });
    if (!success) {
      process.stderr.write("studio smoke: FAIL\n");
      process.exitCode = 1;
    }
  } catch (error) {
    if (databaseOpen) watcher.stop();
    logger.event("scenario.error", {
      message: error instanceof Error ? error.message : String(error),
    });
    checks.push({
      name: "scenario completed",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    logger.event("scenario.end", {
      success: false,
      durationMs: Date.now() - Date.parse(startedAt),
    });
    writeSmokeSummary({
      workspace,
      database: databaseOpen ? database : null,
      scenario,
      protocols: args.protocols,
      startedAt,
      success: false,
      checks,
    });
    if (app) await app.close();
    if (databaseOpen) database.close();
    finalizeSmokeWorkspace(workspace, { success: false, keepArtifacts: true });
    process.stderr.write("studio smoke: FAIL\n");
    process.exitCode = 1;
  }
}

async function resumeMain(resumeFrom: string) {
  const workspace = workspaceFromDir(resumeFrom);
  const state = readResumeState(workspace);
  if (!state) throw new Error(`missing resume state in ${resumeFrom}`);
  const logger = new SmokeLogger(workspace.jsonlPath, scenario, {
    diagnostic: state.diagnostic,
  });
  installSignalFlush(logger);
  const childChecks: SmokeCheck[] = [];
  let success = false;

  const database = new NodeNarrativeDatabase(workspace.dbPath);
  database.migrate();
  interruptOrphanedWork(logger, database);
  const tracker = new RunStateTracker(logger, database, {
    diagnostic: state.diagnostic,
  });
  const watcher = new RunWatcher(tracker);
  watcher.startPolling();
  logger.event("scenario.resumed", {
    workspace: workspace.dir,
    documentId: state.documentId,
  });
  const recordCheck = (name: string, ok: boolean, detail?: string): void => {
    childChecks.push({ name, ok, ...(detail ? { detail } : {}) });
    logger.event("scenario.check", { name, ok, ...(detail ? { detail } : {}) });
  };

  let app: FastifyInstance | null = null;
  try {
    app = await createApp(database, workspace.dbPath);
    let document = await jsonRequest<StudioDocument>(
      app,
      "GET",
      `/api/projects/${state.projectId}/studio/documents/${state.documentId}`,
      undefined,
      [200],
    );
    const current = required(document.currentVersion, "manuscript version");
    if (current.id !== state.versionId || current.content !== SCENE_TEXT) {
      throw new Error("manuscript version did not survive app restart");
    }
    process.stdout.write("recovery: manuscript survived restart\n");
    recordCheck(
      "manuscript survived cross-process restart",
      true,
      `${current.content.length} chars`,
    );

    const selectionEnd = Math.min(36, current.content.length);
    const quote = current.content.slice(0, selectionEnd);
    await jsonRequest(
      app,
      "POST",
      `/api/projects/${state.projectId}/studio/documents/${state.documentId}/comments`,
      {
        versionId: current.id,
        startOffset: 0,
        endOffset: selectionEnd,
        quote,
        body: "检查这一段是否保持有限视角，并强化纸张的触感。",
      },
      [201],
    );

    const editRun = await jsonRequest<{ run: { id: string } }>(
      app,
      "POST",
      `/api/projects/${state.projectId}/studio/documents/${state.documentId}/selection-edits`,
      {
        baseVersionId: current.id,
        selectionStart: 0,
        selectionEnd,
        instruction:
          "只改写这个短选区，替换文本不超过 50 个汉字；保持事件、视角与专名不变，加强纸张触感，不添加新设定。",
      },
      [202],
    );
    logger.event("run.created", {
      runId: editRun.run.id,
      projectId: state.projectId,
      kind: "selection-edit",
    });
    watcher.track(editRun.run.id);
    await finishRun(
      app,
      watcher,
      editRun.run.id,
      state.projectId,
      "selection edit",
    );
    state.completedRunIds.push(editRun.run.id);
    document = await jsonRequest<StudioDocument>(
      app,
      "GET",
      `/api/projects/${state.projectId}/studio/documents/${state.documentId}`,
      undefined,
      [200],
    );
    const proposal = required(
      document.proposals.find((candidate) => candidate.status === "proposed"),
      "edit proposal",
    );
    await jsonRequest(
      app,
      "POST",
      `/api/studio/edit-proposals/${proposal.id}/actions`,
      { action: "accept", requestId: `${proposal.id}:accept` },
      [200],
    );
    document = await jsonRequest<StudioDocument>(
      app,
      "GET",
      `/api/projects/${state.projectId}/studio/documents/${state.documentId}`,
      undefined,
      [200],
    );
    if (document.versions.length !== 2 || document.comments.length !== 1) {
      throw new Error("accepted diff or anchored comment was not persisted");
    }
    recordCheck("edit proposal accepted", true);

    const calls = state.completedRunIds.flatMap((runId) =>
      new SqliteLlmCallRepository(database).listForRun(runId),
    );
    const totalOutputTokens = calls.reduce(
      (sum, call) => sum + (call.usage?.outputTokens ?? 0),
      0,
    );
    process.stdout.write(
      [
        "studio smoke: PASS",
        `runs=${state.completedRunIds.length}`,
        `model_calls=${calls.length}`,
        `output_tokens=${totalOutputTokens}`,
        `versions=${document.versions.length}`,
        `elapsed_ms=${Date.now() - Date.parse(state.startedAt)}`,
      ].join(" | ") + "\n",
    );
    success = true;
  } catch (error) {
    logger.event("scenario.error", {
      message: error instanceof Error ? error.message : String(error),
    });
    childChecks.push({
      name: "post-restart scenario",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    watcher.stop();
    writeFileSync(
      join(workspace.dir, "resume-state.json"),
      `${JSON.stringify({ ...state, childChecks }, null, 2)}\n`,
      "utf8",
    );
    if (app) await app.close();
    database.close();
    if (!success) process.exitCode = 1;
  }
}

function readResumeState(workspace: SmokeWorkspace): ResumeState | null {
  try {
    return JSON.parse(
      readFileSync(join(workspace.dir, "resume-state.json"), "utf8"),
    ) as ResumeState;
  } catch {
    return null;
  }
}

async function createApp(database: NodeNarrativeDatabase, dbPath: string) {
  const config: ServerConfig = {
    dataDirectory: ".",
    databasePath: dbPath,
    host: "127.0.0.1",
    port: 4317,
    environment: "test",
  };
  return buildApp({
    config,
    database,
    environment: process.env,
    logger: false,
    enableRunWorker: false,
  });
}

async function finishRun(
  app: FastifyInstance,
  watcher: RunWatcher,
  runId: string,
  projectId: string,
  label: string,
) {
  let snapshot = await jsonRequest<RunSnapshot>(
    app,
    "GET",
    `/api/runs/${runId}?projectId=${projectId}`,
    undefined,
    [200],
  );
  let lastStep = "";
  for (let index = 0; index < 5_000; index += 1) {
    if (
      ["completed", "failed", "cancelled", "awaiting_user"].includes(
        snapshot.run.status,
      )
    )
      break;
    const step =
      snapshot.steps.find((candidate) => candidate.status === "running") ??
      snapshot.steps.find((candidate) => candidate.status === "pending");
    if (step?.kind && step.kind !== lastStep) {
      process.stdout.write(`${label}: ${step.kind}\n`);
      lastStep = step.kind;
    }
    const result = await jsonRequest<{ snapshot: RunSnapshot }>(
      app,
      "POST",
      `/api/runs/${runId}/advance`,
      { projectId },
      [200],
    );
    watcher.diffAll();
    snapshot = result.snapshot;
    if (snapshot.run.status === "failed_recoverable") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (snapshot.run.status !== "completed") {
    const failure = snapshot.steps.find(
      (step) => step.status === "failed",
    )?.error;
    throw new Error(
      `${label} ended as ${snapshot.run.status}: ${safeError(failure)}`,
    );
  }
}

async function jsonRequest<T = unknown>(
  target: FastifyInstance,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload: Record<string, unknown> | undefined,
  expected: readonly number[],
): Promise<T> {
  const response =
    payload === undefined
      ? await target.inject({ method, url })
      : await target.inject({ method, url, payload });
  if (!expected.includes(response.statusCode)) {
    let error: unknown;
    try {
      error = response.json();
    } catch {
      error = { statusCode: response.statusCode };
    }
    throw new Error(
      `${method} ${url} returned ${response.statusCode}: ${safeError(error)}`,
    );
  }
  return response.json() as T;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined)
    throw new Error(`missing ${label}`);
  return value;
}

function safeError(value: unknown) {
  if (!value || typeof value !== "object") return "no structured error";
  const record = value as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : record;
  return (
    [nested.code, nested.message]
      .filter((item) => typeof item === "string")
      .join(" | ") || "unknown error"
  );
}

interface RunSnapshot {
  run: { id: string; status: string };
  steps: {
    kind: string;
    status: string;
    error: Record<string, unknown> | null;
  }[];
}

interface StudioDocument {
  currentVersion: { id: string; content: string } | null;
  versions: { id: string }[];
  comments: { id: string }[];
  proposals: { id: string; status: string }[];
}
