import type { Document, NarrativeRun } from "@lapis/domain";
import { buildManualSettlementRecipe } from "@lapis/harness";
import {
  type NarrativeDatabase,
  SqliteRunRepository,
} from "@lapis/persistence";

import { RunServiceError, withRuntimeModelPolicy } from "./run-policy.js";

/**
 * Origin of a manual settlement Run: a writing desk commit, or a "Fill in the
 * story bible from the manuscript" job. The shape is constrained by
 * RunOriginSchema (strict); the fill-in job's jobId goes in run.policy.
 */
export type ManualSettlementOrigin = {
  surface: "writing" | "bible-backfill";
  documentId: string;
};

/**
 * Shared creator of manual settlement Runs: extracts story change candidates
 * from a committed chapter version. It reuses the settle/commit steps of the
 * chapter chain, but only produces candidates: it appends no version and does
 * not take the main writing chain's mutual exclusion (targetOutlineNodeId stays
 * null; the anchor chapter is written into the payload when the change set is
 * committed, see SETTLED_OUTLINE_NODE_KEY). The caller is responsible for model
 * availability and the deduplication policy.
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

/**
 * Manual settlement Runs still in progress for a given version (any origin).
 */
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
