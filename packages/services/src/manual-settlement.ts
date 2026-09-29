import type { Document, NarrativeRun } from "@narralume/domain";
import { buildManualSettlementRecipe } from "@narralume/harness";
import {
  type NarrativeDatabase,
  SqliteRunRepository,
} from "@narralume/persistence";

import { randomUuid } from "./internal/crypto.js";
import {
  hasWritingAssignment,
  RunServiceError,
  withRuntimeModelPolicy,
} from "./run-policy.js";

/**
 * 手动结算 Run 的来源：写作台提交、或「从正文补全故事圣经」任务。
 * 形状受 RunOriginSchema（strict）约束；补全任务的 jobId 放在 run.policy。
 */
export type ManualSettlementOrigin = {
  surface: "writing" | "bible-backfill";
  documentId: string;
};

/**
 * 手动结算 Run 的共享创建器：从一个已提交的章节版本提取故事变化候选。
 * 它复用章节链的 settle/commit 步骤，但只产 candidate，不追加版本、
 * 不占主创作链互斥（targetOutlineNodeId 保持 null；锚点在应用时由
 * 文档所属大纲节点解析）。调用方负责模型可用性与去重策略。
 */
export function createManualSettlementRun(input: {
  database: NarrativeDatabase;
  environment: Readonly<Record<string, string | undefined>>;
  runId: string;
  projectId: string;
  document: Pick<Document, "id" | "kind" | "outlineNodeId">;
  versionId: string;
  origin: ManualSettlementOrigin;
  /** Extra run-policy flags read by the settlement worker. */
  policy?: Readonly<Record<string, unknown>>;
  now: string;
}): NarrativeRun {
  const { document } = input;
  if (document.kind !== "chapter" || !document.outlineNodeId) {
    throw new RunServiceError(
      "manual_settlement.target.not_chapter",
      "Only a manuscript bound to a chapter outline node can be settled",
      422,
    );
  }
  const recipe = buildManualSettlementRecipe(input.runId);
  return new SqliteRunRepository(input.database).create({
    id: input.runId,
    projectId: input.projectId,
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    targetOutlineNodeId: null,
    policy: withRuntimeModelPolicy(
      {
        ...input.policy,
        documentId: document.id,
        documentVersionId: input.versionId,
        origin: input.origin,
      },
      input.environment,
    ),
    steps: recipe.steps,
    now: input.now,
  }).run;
}

/** 某个版本仍在进行中的手动结算 Run（任何来源）。 */
export function findActiveManualSettlementRun(
  database: NarrativeDatabase,
  projectId: string,
  versionId: string,
): NarrativeRun | null {
  return (
    new SqliteRunRepository(database)
      .listActiveRuns(projectId)
      .find(
        (run) =>
          run.recipe === "manual-settlement" &&
          run.policy.documentVersionId === versionId,
      ) ?? null
  );
}

/**
 * 写作台路径：作者正式提交正文版本后自动开一个后台结算 Run。
 * 没有可用写作模型时静默跳过——手动写作永远不能被模型配置阻塞。
 * （「从正文补全故事圣经」走 createManualSettlementRun，缺模型时显式报错。）
 */
export function startManualSettlementRun(input: {
  database: NarrativeDatabase;
  environment: Readonly<Record<string, string | undefined>>;
  coordinatorWake: () => void;
  projectId: string;
  document: Pick<Document, "id" | "kind" | "outlineNodeId">;
  versionId: string;
}): string | null {
  const { database, environment, projectId, document, versionId } = input;
  if (document.kind !== "chapter" || !document.outlineNodeId) return null;
  if (!hasWritingAssignment(database, environment)) return null;
  /* 每个版本最多一条结算 Run；不同版本各自结算，串行或并发都安全。 */
  if (findActiveManualSettlementRun(database, projectId, versionId)) {
    return null;
  }
  const run = createManualSettlementRun({
    database,
    environment,
    runId: randomUuid(),
    projectId,
    document,
    versionId,
    origin: { surface: "writing", documentId: document.id },
    now: new Date().toISOString(),
  });
  input.coordinatorWake();
  return run.id;
}
