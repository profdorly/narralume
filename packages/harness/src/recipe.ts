import type { ChapterStepKind, RunStepKind } from "@lapis/domain";

export interface RunStepSeed {
  id: string;
  ordinal: number;
  kind: RunStepKind;
  cycle: number;
  idempotencyKey: string;
  maxAttempts: number;
}

export type ChapterRecipeName = "chapter-production" | "short-story";

export interface ChapterRecipe {
  name: ChapterRecipeName;
  version: number;
  maxRevisionCycles: number;
  steps: readonly RunStepSeed[];
}

export interface RequestedRevisionRecipe {
  name: "chapter-candidate-revision";
  version: number;
  steps: readonly RunStepSeed[];
}

export interface ManualSettlementRecipe {
  name: "manual-settlement";
  version: number;
  steps: readonly RunStepSeed[];
}

export interface DocumentReviewRecipe {
  name: "document-review";
  version: number;
  steps: readonly RunStepSeed[];
}

export function buildChapterRecipe(
  runId: string,
  maxRevisionCycles = 2,
): ChapterRecipe {
  const boundedCycles = Math.max(0, Math.min(maxRevisionCycles, 5));
  /* Model-call steps get 5 attempts across the board (the transport layer does
     not retry; retries belong to the Harness); pure persistence/deterministic
     steps keep 1-2. */
  const steps: RunStepSeed[] = [];
  const append = (
    key: string,
    kind: ChapterStepKind,
    cycle: number,
    maxAttempts: number,
  ) => {
    steps.push({
      id: `${runId}:${key}`,
      ordinal: steps.length,
      kind,
      cycle,
      idempotencyKey: `${runId}/${key}`,
      maxAttempts,
    });
  };
  append("context", "context.compile", 0, 2);
  append("plan", "scene.plan", 0, 5);
  append("draft", "draft.generate", 0, 5);
  for (let cycle = 0; cycle <= boundedCycles; cycle += 1) {
    append(`check:${cycle}`, "deterministic.check", cycle, 1);
    append(`review:${cycle}`, "semantic.review", cycle, 5);
    if (cycle < boundedCycles) {
      append(`revise:${cycle}`, "revision.generate", cycle, 5);
    }
  }
  append("settle", "chapter.settle", boundedCycles, 5);
  append("commit", "chapter.commit", boundedCycles, 1);
  return {
    name: "chapter-production",
    version: 1,
    maxRevisionCycles: boundedCycles,
    steps,
  };
}

export function buildRequestedRevisionRecipe(
  runId: string,
): RequestedRevisionRecipe {
  const steps: RunStepSeed[] = [];
  const append = (
    key: string,
    kind: ChapterStepKind,
    cycle: number,
    maxAttempts: number,
  ) => {
    steps.push({
      id: `${runId}:${key}`,
      ordinal: steps.length,
      kind,
      cycle,
      idempotencyKey: `${runId}/${key}`,
      maxAttempts,
    });
  };
  append("context", "context.compile", 0, 2);
  append("revise:requested", "revision.generate", 0, 5);
  append("check:0", "deterministic.check", 0, 1);
  append("review:0", "semantic.review", 0, 5);
  append("revise:auto", "revision.generate", 0, 5);
  append("check:1", "deterministic.check", 1, 1);
  append("review:1", "semantic.review", 1, 5);
  append("settle", "chapter.settle", 1, 5);
  append("commit", "chapter.commit", 1, 1);
  return { name: "chapter-candidate-revision", version: 1, steps };
}

/* Manual settlement reuses the settle/commit step semantics of the chapter
   chain: the text comes from an existing document version
   (policy.documentVersionId), and commit adds no version, only persists the
   candidate change set. */
export function buildManualSettlementRecipe(
  runId: string,
): ManualSettlementRecipe {
  const steps: RunStepSeed[] = [];
  const append = (key: string, kind: ChapterStepKind, maxAttempts: number) => {
    steps.push({
      id: `${runId}:${key}`,
      ordinal: steps.length,
      kind,
      cycle: 0,
      idempotencyKey: `${runId}/${key}`,
      maxAttempts,
    });
  };
  append("settle", "chapter.settle", 5);
  append("commit", "chapter.commit", 1);
  return { name: "manual-settlement", version: 1, steps };
}

/** Reviews one immutable document version without generating or committing prose. */
export function buildDocumentReviewRecipe(runId: string): DocumentReviewRecipe {
  return {
    name: "document-review",
    version: 1,
    steps: [
      {
        id: `${runId}:context`,
        ordinal: 0,
        kind: "context.compile",
        cycle: 0,
        idempotencyKey: `${runId}/context`,
        maxAttempts: 2,
      },
      {
        id: `${runId}:review`,
        ordinal: 1,
        kind: "semantic.review",
        cycle: 0,
        idempotencyKey: `${runId}/review`,
        maxAttempts: 5,
      },
    ],
  };
}
