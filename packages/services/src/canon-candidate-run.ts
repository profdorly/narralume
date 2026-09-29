import type { CanonSpread } from "@narralume/contracts";
import { sha256Hex } from "@narralume/domain";
import { buildCanonCandidateRecipe } from "@narralume/harness";
import {
  SqliteRunRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { requireWritingAssignment, withRuntimeModelPolicy } from "./run-policy.js";

export class CanonCandidateRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CanonCandidateRouteError";
  }
}

/** Deterministic id of the candidate run one (spread, requestId) creates. */
export function canonSpreadCandidateRunId(
  projectId: string,
  spread: CanonSpread,
  requestId: string,
): string {
  const hex = sha256Hex(
    `canon-spread-candidate\0${projectId}:${spread}\0${requestId}`,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Creates the Canon Spread candidate run (context → candidate → stage) for
 * one spread, idempotently per requestId: the same requestId with the same
 * spread and instruction replays; with a different one it conflicts. At most
 * one candidate run per spread is active in a project, and the run needs a
 * writing model (RunServiceError otherwise). The Bible route and the Story
 * Bible completion's section phase both start candidate runs here; the
 * caller wakes the run worker.
 */
export function createCanonSpreadCandidateRun(
  database: NarrativeDatabase,
  environment: Readonly<Record<string, string | undefined>>,
  input: {
    projectId: string;
    spread: CanonSpread;
    requestId: string;
    instruction: string;
    /** Run origin; defaults to the Bible surface. */
    origin?: Readonly<Record<string, unknown>>;
    /** Extra run-policy fields (for example the completion job that owns it). */
    policy?: Readonly<Record<string, unknown>>;
    now: string;
  },
): { runId: string; idempotentReplay: boolean } {
  const runs = new SqliteRunRepository(database);
  const requestHash = hashStable({
    spread: input.spread,
    instruction: input.instruction,
  });
  const runId = canonSpreadCandidateRunId(
    input.projectId,
    input.spread,
    input.requestId,
  );
  return database.transaction(() => {
    const replay = runs.getRun(runId);
    if (replay) {
      if (
        replay.projectId !== input.projectId ||
        replay.policy.creationRequestHash !== requestHash
      ) {
        throw new CanonCandidateRouteError(
          "canon_candidate.idempotency_conflict",
          "The same requestId was already used for a different Canon candidate request",
          409,
        );
      }
      return { runId, idempotentReplay: true };
    }

    const activeRun = runs
      .listActiveRuns(input.projectId)
      .find(
        (candidate) =>
          candidate.recipe === "canon-spread-candidate" &&
          candidate.policy.canonSpread === input.spread,
      );
    if (activeRun) {
      throw new CanonCandidateRouteError(
        "canon_candidate.active_run_exists",
        `The current Canon spread already has an active candidate run: ${activeRun.id}`,
        409,
      );
    }

    requireWritingAssignment(database, environment);
    const recipe = buildCanonCandidateRecipe(runId);
    const policy = withRuntimeModelPolicy(
      {
        ...input.policy,
        canonSpread: input.spread,
        canonInstruction: input.instruction,
        canonMaxOutputTokens: 6_000,
        creationRequestId: input.requestId,
        creationRequestHash: requestHash,
        origin: input.origin ?? {
          surface: "bible",
          canonSpread: input.spread,
        },
      },
      environment,
    );
    runs.create({
      id: runId,
      projectId: input.projectId,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "manual",
      targetOutlineNodeId: null,
      policy,
      steps: recipe.steps,
      now: input.now,
    });
    return { runId, idempotentReplay: false };
  });
}

function hashStable(value: unknown): string {
  return sha256Hex(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
