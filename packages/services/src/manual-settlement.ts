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
 * Writing desk path: after the author formally commits a manuscript version, a
 * background settlement Run starts automatically. When no writing model is
 * available it is skipped silently: manual writing must never be blocked by
 * model configuration. ("Fill in the story bible from the manuscript" uses
 * createManualSettlementRun, which reports an explicit error when the model is
 * missing.) If an in-progress fill-in job still has to settle this chapter, the
 * job settles it once against the new version instead and no separate
 * settlement starts (see retargetBackfillChapter).
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
  /* At most one settlement Run per version; different versions settle
     separately, which is safe serially or concurrently. */
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
