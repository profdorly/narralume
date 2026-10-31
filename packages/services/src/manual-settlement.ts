import type { Document } from "@lapis/domain";
import type { NarrativeDatabase } from "@lapis/persistence";

import { retargetBackfillChapter } from "./bible-backfill-service.js";
import { randomUuid } from "./internal/crypto.js";
import {
  createManualSettlementRun,
  findActiveManualSettlementRun,
} from "./manual-settlement-run.js";
import { hasWritingAssignment } from "./run-policy.js";

export {
  createManualSettlementRun,
  findActiveManualSettlementRun,
  type ManualSettlementOrigin,
} from "./manual-settlement-run.js";

/**
 * 写作台路径：作者正式提交正文版本后自动开一个后台结算 Run。
 * 没有可用写作模型时静默跳过——手动写作永远不能被模型配置阻塞。
 * （「从正文补全故事圣经」走 createManualSettlementRun，缺模型时显式报错。）
 * 若进行中的补全任务仍要结算这一章，则改由任务按新版本只结算一次，
 * 不另开结算（见 retargetBackfillChapter）。
 */
export function startManualSettlementRun(input: {
  database: NarrativeDatabase;
  environment: Readonly<Record<string, string | undefined>>;
  coordinatorWake: () => void;
  projectId: string;
  document: Pick<Document, "id" | "kind" | "outlineNodeId">;
  versionId: string;
  /** Interrupts a superseded, running Story Bible completion child run. */
  interruptRun?: (runId: string, reason: string) => void;
  /** Wakes the Story Bible completion after it took over this version. */
  bibleBackfillWake?: () => void;
}): string | null {
  const { database, environment, projectId, document, versionId } = input;
  if (document.kind !== "chapter" || !document.outlineNodeId) return null;
  const now = new Date().toISOString();
  const retarget = retargetBackfillChapter(database, {
    projectId,
    documentId: document.id,
    outlineNodeId: document.outlineNodeId,
    versionId,
    now,
  });
  if (retarget.handled) {
    database.afterCommit(() => {
      if (retarget.interruptRunId) {
        input.interruptRun?.(
          retarget.interruptRunId,
          "bible_backfill_retargeted",
        );
      }
      input.bibleBackfillWake?.();
    });
    return null;
  }
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
    now,
  });
  input.coordinatorWake();
  return run.id;
}
