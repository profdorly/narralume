import type { RunStepKind } from "@lapis/domain";

import type { RunStepSeed } from "./recipe.js";

export interface CollaborationRecipe {
  name: "selection-edit";
  version: number;
  steps: readonly RunStepSeed[];
}

export function buildSelectionEditRecipe(runId: string): CollaborationRecipe {
  return recipe(runId, "selection-edit", [
    ["transform", "edit.transform", 5],
    ["stage", "edit.stage", 1],
  ]);
}

function recipe(
  runId: string,
  name: CollaborationRecipe["name"],
  definitions: readonly [key: string, kind: RunStepKind, maxAttempts: number][],
): CollaborationRecipe {
  return {
    name,
    version: 1,
    steps: definitions.map(([key, kind, maxAttempts], ordinal) => ({
      id: `${runId}:${key}`,
      ordinal,
      kind,
      cycle: 0,
      idempotencyKey: `${runId}/${key}`,
      maxAttempts,
    })),
  };
}
