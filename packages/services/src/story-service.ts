import type { ProjectCoverMutation } from "@lapis/contracts";
import { createCanonFact, type CanonAuthority } from "@lapis/domain";
import {
  SqliteAutomationRepository,
  SqliteBibleBackfillRepository,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteProjectCoverRepository,
  SqliteProjectRepository,
  SqliteManuscriptIndexer,
  SqliteRunRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

import { randomUuid } from "./internal/crypto.js";
import { ServiceError } from "./service-error.js";
import { startManualSettlementRun } from "./manual-settlement.js";

export class StoryServiceError extends ServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "StoryServiceError";
  }
}

/**
 * Business rules for soft-deleting a work: it must be archived, pass the
 * optimistic lock precondition and have its title confirmed; deletion must
 * actually stop further writes. Active Runs are set to cancelled directly (the
 * terminal route is a no-op, so leftover leases advance nothing more), and
 * active autopilot sessions are cancelled as well. Returns the list of run ids
 * that need an interrupt.
 */
export function softDeleteProject(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    expectedUpdatedAt: string;
    confirmationTitle: string;
    now: string;
  },
): {
  recycled: ReturnType<SqliteProjectRepository["softDelete"]>;
  activeRunIds: string[];
} {
  const projects = new SqliteProjectRepository(database);
  const runs = new SqliteRunRepository(database);
  const automation = new SqliteAutomationRepository(database);
  const project = projects.get(input.projectId);
  if (!project)
    throw new StoryServiceError("project.not_found", "Project not found", 404);
  if (!project.archivedAt)
    throw new StoryServiceError(
      "project.delete.archive_required",
      "Archive the project before moving it to the recycle bin",
      409,
    );
  if (project.updatedAt !== input.expectedUpdatedAt)
    throw new StoryServiceError(
      "project.version.conflict",
      "The project was updated; refresh and try again",
      409,
    );
  if (project.title !== input.confirmationTitle)
    throw new StoryServiceError(
      "project.delete.confirmation_mismatch",
      "The confirmation title does not match the project title",
      422,
    );
  const activeRuns = runs.listActiveRuns(input.projectId);
  const activeSessions = automation
    .listSessions(input.projectId)
    .filter((session) => !["completed", "cancelled"].includes(session.status));
  const recycled = database.transaction(() => {
    for (const run of activeRuns)
      runs.setRunStatus(run.id, "cancelled", input.now, "project_deleted");
    for (const session of activeSessions)
      automation.setSessionStatus(session.id, "cancelled", input.now);
    new SqliteBibleBackfillRepository(database).cancelActiveJobs(
      input.projectId,
      input.now,
    );
    return projects.softDelete(
      input.projectId,
      input.expectedUpdatedAt,
      input.now,
    );
  });
  return { recycled, activeRunIds: activeRuns.map((run) => run.id) };
}

/**
 * The fact is still current effective canon (not superseded by a
 * revision/retraction): the shared precondition of revising and raising
 * authority.
 */
function requireEffectiveFact(
  canon: SqliteCanonRepository,
  projectId: string,
  factId: string,
  code: string,
  message: string,
) {
  const isEffective = canon
    .listEffectiveFacts(projectId, { includeCandidates: true })
    .some((fact) => fact.id === factId);
  if (!isEffective) throw new StoryServiceError(code, message, 409);
}

/**
 * Fact revision: the real concurrency precondition is that the fact is still
 * current effective canon, otherwise two revisions would fork under the same
 * supersedesFactId; locked facts need explicit confirmation. Returns the new
 * fact and the conflict list.
 */
export function reviseCanonFact(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    factId: string;
    subjectId: string;
    predicate: string;
    objectEntityId: string | null;
    value: unknown;
    validFromNodeId: string | null;
    validToNodeId: string | null;
    knowledgeScope: "omniscient" | "reader" | "character" | "author_secret";
    knowledgeSubjectId: string | null;
    authority: CanonAuthority;
    confidence: number;
    confirmLockedRevision: boolean;
  },
) {
  const canon = new SqliteCanonRepository(database);
  canon.requireFact(input.projectId, input.factId);
  requireEffectiveFact(
    canon,
    input.projectId,
    input.factId,
    "canon.fact.superseded",
    "The fact was superseded by a newer revision or withdrawal; refresh before editing",
  );
  const current = canon.requireFact(input.projectId, input.factId);
  if (current.authority === "locked" && !input.confirmLockedRevision) {
    throw new StoryServiceError(
      "canon.fact.locked",
      "Revising a locked fact requires explicit confirmation",
      409,
    );
  }
  const revised = createCanonFact({
    id: randomUuid(),
    projectId: input.projectId,
    now: new Date().toISOString(),
    subjectId: input.subjectId,
    predicate: input.predicate,
    objectEntityId: input.objectEntityId,
    ...(input.objectEntityId ? {} : { value: input.value }),
    validFromNodeId: input.validFromNodeId,
    validToNodeId: input.validToNodeId,
    knowledgeScope: input.knowledgeScope,
    knowledgeSubjectId: input.knowledgeSubjectId,
    authority: input.authority,
    confidence: input.confidence,
    sourceType: "manual-revision",
    sourceId: input.factId,
    supersedesFactId: input.factId,
  });
  const conflicts = canon.findConflicts(revised);
  canon.insertFact(revised);
  return { revised, conflicts };
}

/**
 * Fact retraction: only currently effective facts can be retracted; locked ones
 * need explicit confirmation.
 */
export function withdrawCanonFact(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    factId: string;
    reason: string;
    confirmLockedWithdrawal: boolean;
  },
) {
  const canon = new SqliteCanonRepository(database);
  const current = canon.requireFact(input.projectId, input.factId);
  requireEffectiveFact(
    canon,
    input.projectId,
    input.factId,
    "canon.fact.not_effective",
    "Only the currently effective fact can be withdrawn",
  );
  if (current.authority === "locked" && !input.confirmLockedWithdrawal) {
    throw new StoryServiceError(
      "canon.fact.locked",
      "Withdrawing a locked fact requires explicit confirmation",
      409,
    );
  }
  return canon.withdrawFact({
    factId: input.factId,
    projectId: input.projectId,
    reason: input.reason,
    withdrawnAt: new Date().toISOString(),
  });
}

/** Raise a fact's authority: superseded facts cannot be raised. */
export function promoteCanonFact(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    factId: string;
    authority: Exclude<CanonAuthority, "candidate">;
  },
) {
  const canon = new SqliteCanonRepository(database);
  canon.requireFact(input.projectId, input.factId);
  requireEffectiveFact(
    canon,
    input.projectId,
    input.factId,
    "canon.fact.superseded",
    "The fact was revised or withdrawn; refresh before promoting its authority",
  );
  return canon.promoteFact(
    input.projectId,
    input.factId,
    randomUuid(),
    input.authority,
    new Date().toISOString(),
  );
}

/**
 * Side-effect chain of formally committing text: append version → delete
 * draft → update retrieval chunks → set outline to committed → (optionally)
 * auto-start a manual settlement. restore goes through the same chain.
 */
export function commitDocumentVersion(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    documentId: string;
    content: string;
    source: string;
    expectedCurrentVersionId?: string | null | undefined;
    triggerSettlement: boolean;
    environment: Readonly<Record<string, string | undefined>>;
    coordinatorWake: () => void;
    /** See startManualSettlementRun: a Story Bible completion re-target. */
    interruptRun?: (runId: string, reason: string) => void;
    bibleBackfillWake?: () => void;
  },
) {
  const documents = new SqliteDocumentRepository(database);
  const story = new SqliteStoryRepository(database);
  const document = documents.get(input.projectId, input.documentId);
  if (!document)
    throw new StoryServiceError(
      "document.not_found",
      "Manuscript document not found",
      404,
    );
  const now = new Date().toISOString();
  const version = documents.appendVersion(input.projectId, input.documentId, {
    id: randomUuid(),
    content: input.content,
    source: input.source,
    now,
    ...(input.expectedCurrentVersionId === undefined
      ? {}
      : { expectedCurrentVersionId: input.expectedCurrentVersionId }),
  });
  documents.deleteDraft(input.projectId, input.documentId, input.content);
  if (document.outlineNodeId) {
    new SqliteManuscriptIndexer(database).indexDocument({
      projectId: input.projectId,
      documentId: document.id,
      versionId: version.id,
      provenance: { source: input.source },
      now,
    });
    story.updateOutlineStatus(
      input.projectId,
      document.outlineNodeId,
      "committed",
      now,
    );
  }
  /* A formal commit (source=manual) auto-starts a manual settlement; implicit
     versions such as annotation checkpoints and selection baselines do not
     trigger it. */
  if (input.triggerSettlement) {
    startManualSettlementRun({
      database,
      environment: input.environment,
      coordinatorWake: input.coordinatorWake,
      ...(input.interruptRun ? { interruptRun: input.interruptRun } : {}),
      ...(input.bibleBackfillWake
        ? { bibleBackfillWake: input.bibleBackfillWake }
        : {}),
      projectId: input.projectId,
      document,
      versionId: version.id,
    });
  }
  return version;
}

export const MAX_COVER_BYTES = 8 * 1024 * 1024;

/**
 * Apply the cover change inside the work update transaction; a validation
 * failure rolls back the details change. base64 decoding uses a pure
 * implementation (works in browser and Node), and magic bytes check that the
 * media type matches.
 */
export function applyCoverMutation(
  database: NarrativeDatabase,
  projectId: string,
  mutation: ProjectCoverMutation,
  now: string,
): void {
  const covers = new SqliteProjectCoverRepository(database);
  if (mutation.action === "remove") {
    covers.delete(projectId);
    return;
  }
  if (mutation.action === "crop") {
    if (!covers.get(projectId))
      throw new StoryServiceError(
        "project.cover.not_found",
        "This book does not have a custom cover yet",
        404,
      );
    const current = covers.get(projectId)!;
    covers.upsert({
      projectId,
      mediaType: current.mediaType,
      data: current.data,
      width: current.width,
      height: current.height,
      crop: mutation.crop,
      now,
    });
    return;
  }
  const data = decodeCover(mutation.imageBase64);
  if (data.byteLength > MAX_COVER_BYTES)
    throw new StoryServiceError(
      "project.cover.too_large",
      "The cover must not exceed 8 MB after processing",
      413,
    );
  if (!matchesCoverMediaType(data, mutation.mediaType))
    throw new StoryServiceError(
      "project.cover.media_mismatch",
      "The cover content does not match the declared image type",
      422,
    );
  covers.upsert({
    projectId,
    mediaType: mutation.mediaType,
    data,
    width: mutation.width,
    height: mutation.height,
    crop: mutation.crop,
    now,
  });
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Pure base64 decoding (Uint8Array output), avoiding a Node Buffer dependency.
 */
function decodeBase64(source: string): Uint8Array {
  const clean = source.replace(/=+$/u, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) throw new Error("invalid base64 character");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

function decodeCover(source: string): Uint8Array {
  if (source.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(source))
    throw new StoryServiceError(
      "project.cover.invalid_base64",
      "The cover image encoding is invalid",
      400,
    );
  let data: Uint8Array;
  try {
    data = decodeBase64(source);
  } catch {
    throw new StoryServiceError(
      "project.cover.invalid_base64",
      "The cover image encoding is invalid",
      400,
    );
  }
  if (data.byteLength === 0)
    throw new StoryServiceError(
      "project.cover.empty",
      "The cover image must not be empty",
      400,
    );
  return data;
}

type CoverMediaType = Extract<
  ProjectCoverMutation,
  { action: "put" }
>["mediaType"];

function matchesCoverMediaType(
  data: Uint8Array,
  mediaType: CoverMediaType,
): boolean {
  if (mediaType === "image/png")
    return (
      data.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, index) => data[index] === value,
      )
    );
  if (mediaType === "image/jpeg")
    return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  return (
    data.length >= 12 &&
    String.fromCharCode(...data.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...data.slice(8, 12)) === "WEBP"
  );
}
