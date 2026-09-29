import { z } from "zod";

import { CanonSpreadSchema, type CanonSpread } from "./canon-candidate.js";

const IdSchema = z.string().trim().min(1).max(300);

/**
 * 「从正文补全故事圣经」：按章节顺序逐章走手动结算管线。
 * review_each —— 每章产出的变更集等作者在审阅面板裁定后再结算下一章；
 * auto_apply_stop_on_conflict —— 自动应用，遇到正典冲突即停下等作者处理。
 */
export const BibleBackfillModeSchema = z.enum([
  "review_each",
  "auto_apply_stop_on_conflict",
]);
export type BibleBackfillMode = z.infer<typeof BibleBackfillModeSchema>;

/**
 * Mode of a start request. `end_to_end` is the one-button preset: chapters
 * run as `auto_apply_stop_on_conflict` (the job records that mode) and,
 * unless `sections` says otherwise, the default sections are generated
 * after the chapter pass.
 */
export const BibleBackfillRequestModeSchema = z.enum([
  ...BibleBackfillModeSchema.options,
  "end_to_end",
]);
export type BibleBackfillRequestMode = z.infer<
  typeof BibleBackfillRequestModeSchema
>;

/**
 * Order in which a job generates its Story Bible sections after the chapter
 * pass: what the book is about first, then who is in it, then its structure,
 * then the finer canon that refers to all of them.
 */
export const BIBLE_BACKFILL_SECTION_ORDER: readonly CanonSpread[] = [
  "intent",
  "entities",
  "outline",
  "facts",
  "relations",
  "timeline",
  "foreshadows",
];

/** Sections an `end_to_end` request generates when it names none. */
export const DEFAULT_BIBLE_BACKFILL_SECTIONS: readonly CanonSpread[] = [
  "intent",
  "entities",
  "outline",
];

/** Sections deduplicated and put in BIBLE_BACKFILL_SECTION_ORDER. */
export function orderBibleBackfillSections(
  sections: readonly CanonSpread[],
): CanonSpread[] {
  const requested = new Set(sections);
  return BIBLE_BACKFILL_SECTION_ORDER.filter((spread) =>
    requested.has(spread),
  );
}

/**
 * Where a job is: settling chapters in reading order, generating the
 * requested sections from the whole book, or done.
 */
export const BibleBackfillPhaseSchema = z.enum(["chapters", "sections", "done"]);
export type BibleBackfillPhase = z.infer<typeof BibleBackfillPhaseSchema>;

/**
 * A section of the plan: pending, generating its candidate set, or finished
 * as applied (every item applied), partially_applied (some items applied,
 * the rest wait for review), needs_review (nothing applied automatically;
 * every item waits in the Bible), failed (the candidate run failed; the job
 * moved on, retry_section runs it again) or skipped (the job was cancelled
 * before it ran).
 */
export const BibleBackfillSectionStatusSchema = z.enum([
  "pending",
  "generating",
  "applied",
  "partially_applied",
  "needs_review",
  "failed",
  "skipped",
]);
export type BibleBackfillSectionStatus = z.infer<
  typeof BibleBackfillSectionStatusSchema
>;

/**
 * Why an item of a section's candidate set was left for the author in auto
 * mode:
 * - `locked` — it changes locked content;
 * - `author_record` — it updates or withdraws a record the author created,
 *   or one whose origin is unknown;
 * - `author_edited` — it overwrites `fields` whose current values neither the
 *   import nor a Story Bible completion wrote;
 * - `reopens` — it moves a resolved or abandoned foreshadow out of that
 *   status;
 * - `apply_failed` — applying it failed (`code`, `message`), for example a
 *   name or outline position that is already taken.
 */
export const BibleBackfillSectionPendingReasonSchema = z.enum([
  "locked",
  "author_record",
  "author_edited",
  "reopens",
  "apply_failed",
]);

export const BibleBackfillSectionPendingItemSchema = z.object({
  itemId: IdSchema,
  title: z.string(),
  operation: z.enum(["create", "update", "withdraw"]),
  targetId: IdSchema.nullable(),
  reason: BibleBackfillSectionPendingReasonSchema,
  fields: z.array(z.string()).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});
export type BibleBackfillSectionPendingItemDto = z.infer<
  typeof BibleBackfillSectionPendingItemSchema
>;

/**
 * A job only ends as completed or cancelled. Anything that stops it early —
 * a failed chapter, a conflict, an unexpected error — parks it in
 * awaiting_user, from which the author can resume, retry, skip or cancel.
 * A failed section does not stop it: the job moves on to the next section
 * and can still complete; retry_section on a completed job reopens it
 * (running, phase sections) to run that section again.
 */
export const BibleBackfillJobStatusSchema = z.enum([
  "running",
  "paused",
  "awaiting_decision",
  "awaiting_user",
  "completed",
  "cancelled",
]);
export type BibleBackfillJobStatus = z.infer<
  typeof BibleBackfillJobStatusSchema
>;

export const BibleBackfillItemStatusSchema = z.enum([
  "pending",
  "settling",
  "awaiting_decision",
  "applied",
  "rejected",
  "empty",
  "failed",
  "skipped",
]);
export type BibleBackfillItemStatus = z.infer<
  typeof BibleBackfillItemStatusSchema
>;

export const BibleBackfillSkipReasonSchema = z.enum([
  "already_settled",
  "author_skipped",
]);

export const BibleBackfillActionSchema = z.enum([
  "pause",
  "resume",
  "cancel",
  "skip_item",
  "retry_item",
  "retry_section",
]);
export type BibleBackfillAction = z.infer<typeof BibleBackfillActionSchema>;

export const CreateBibleBackfillRequestSchema = z
  .object({
    requestId: IdSchema,
    mode: BibleBackfillRequestModeSchema.default("review_each"),
    /** Outline chapter node ids to include; omitted = every chapter with a manuscript. */
    chapterIds: z.array(IdSchema).min(1).max(5_000).optional(),
    /**
     * Sections to generate from the whole book after the chapter pass, in any
     * order (deduplicated and run in BIBLE_BACKFILL_SECTION_ORDER). Omitted:
     * DEFAULT_BIBLE_BACKFILL_SECTIONS for `end_to_end`, none otherwise.
     */
    sections: z.array(CanonSpreadSchema).max(20).optional(),
    /**
     * Settle chapters whose current text was already settled again (a
     * re-read) instead of skipping them as already_settled.
     */
    rereadSettled: z.boolean().optional(),
  })
  .strict();
export type CreateBibleBackfillRequest = z.infer<
  typeof CreateBibleBackfillRequestSchema
>;

/** Actions that name a chapter item or a section by its ordinal. */
const ORDINAL_ACTIONS: ReadonlySet<BibleBackfillAction> = new Set([
  "skip_item",
  "retry_item",
  "retry_section",
]);

export const BibleBackfillActionRequestSchema = z
  .object({
    requestId: IdSchema,
    action: BibleBackfillActionSchema,
    /** Item ordinal for skip_item/retry_item, section ordinal for retry_section. */
    ordinal: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsOrdinal = ORDINAL_ACTIONS.has(value.action);
    if (needsOrdinal && value.ordinal === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ordinal"],
        message: `${value.action} requires the ${value.action === "retry_section" ? "section" : "item"} ordinal`,
      });
    }
    if (!needsOrdinal && value.ordinal !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["ordinal"],
        message: `${value.action} does not take an ordinal`,
      });
    }
  });
export type BibleBackfillActionRequest = z.infer<
  typeof BibleBackfillActionRequestSchema
>;

/** Why a job stopped or an item failed; `code` is machine-readable. */
export const BibleBackfillErrorSchema = z
  .object({ code: z.string(), message: z.string().optional() })
  .catchall(z.unknown());

/**
 * What happened to a chapter besides its status; `code` is the latest event:
 * - `bible_backfill.item.retargeted` — the chapter was edited during the job,
 *   which reads the current text instead (`retargetedFromVersionId`; a
 *   superseded run is `supersededRunId` + `supersededRunAction`
 *   cancelled|detached|finished, a superseded change set that stays
 *   reviewable in Studio is `supersededChangeSetId`);
 * - `bible_backfill.item.adopted` — an existing settlement of exactly this
 *   text was used instead of settling it again (`adoptedRunId`,
 *   `adoptedChangeSetId`, `adoptedOutcome` in_progress|candidate|applied|empty);
 * - `bible_backfill.item.detached` — the job was cancelled while an adopted
 *   Studio settlement was still running; it continues in Studio
 *   (`detachedRunId`);
 * - `bible_backfill.item.handed_back` — the job was cancelled before it read
 *   a chapter edited during the job, so the writing-path settlement that
 *   edit would have started was started (`handedBackRunId`).
 */
export const BibleBackfillNoteSchema = z
  .object({ code: z.string() })
  .catchall(z.unknown());

export const BibleBackfillJobSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  status: BibleBackfillJobStatusSchema,
  mode: BibleBackfillModeSchema,
  phase: BibleBackfillPhaseSchema,
  /** Chapters whose current text was already settled are read again. */
  rereadSettled: z.boolean(),
  /** The sections this job generates after the chapter pass, in run order. */
  sections: z.array(CanonSpreadSchema),
  error: BibleBackfillErrorSchema.nullable(),
  pauseRequested: z.boolean(),
  cancelRequested: z.boolean(),
  /** Ordinal of the item currently being settled or awaiting a decision. */
  currentOrdinal: z.number().int().nonnegative().nullable(),
  /** Ordinal of the section currently being generated. */
  currentSectionOrdinal: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().nonnegative(),
});
export type BibleBackfillJobDto = z.infer<typeof BibleBackfillJobSchema>;

export const BibleBackfillItemSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  outlineNodeId: IdSchema,
  documentId: IdSchema,
  versionId: IdSchema,
  /** Chapter title at read time; null when the outline node no longer exists. */
  title: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  runId: IdSchema.nullable(),
  changeSetId: IdSchema.nullable(),
  status: BibleBackfillItemStatusSchema,
  skipReason: BibleBackfillSkipReasonSchema.nullable(),
  error: BibleBackfillErrorSchema.nullable(),
  note: BibleBackfillNoteSchema.nullable(),
  updatedAt: z.string(),
});
export type BibleBackfillItemDto = z.infer<typeof BibleBackfillItemSchema>;

/**
 * One section of the job's plan. Its candidate set is an ordinary Canon
 * Spread candidate set: items left pending are reviewed in that Bible
 * section like any other candidates. `appliedCount`/`pendingCount` are the
 * set's applied and undecided items when the job finished the section;
 * `candidateSetStatus` is the set's live status (null before it exists or
 * when it was removed).
 */
export const BibleBackfillSectionSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  spread: CanonSpreadSchema,
  status: BibleBackfillSectionStatusSchema,
  attempt: z.number().int().nonnegative(),
  runId: IdSchema.nullable(),
  candidateSetId: IdSchema.nullable(),
  candidateSetStatus: z
    .enum(["candidate", "partially_applied", "applied", "rejected"])
    .nullable(),
  appliedCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  /** Auto mode: the items left pending and why (empty in review_each). */
  pendingItems: z.array(BibleBackfillSectionPendingItemSchema),
  error: BibleBackfillErrorSchema.nullable(),
  updatedAt: z.string(),
});
export type BibleBackfillSectionDto = z.infer<typeof BibleBackfillSectionSchema>;

export const BibleBackfillSectionCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  generating: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  partiallyApplied: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const BibleBackfillCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  settling: z.number().int().nonnegative(),
  awaitingDecision: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  empty: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

/**
 * Model usage recorded by the settlement runs this job created or adopted,
 * retries and embedding calls included.
 */
export const BibleBackfillUsageSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /**
   * Estimated cost; null when no recorded call carried a price
   * (NARRATIVE_MODEL_PRICING_JSON unset or not covering the model).
   */
  costUsd: z.number().positive().nullable(),
});
export type BibleBackfillUsageDto = z.infer<typeof BibleBackfillUsageSchema>;

export const BibleBackfillDetailSchema = z.object({
  job: BibleBackfillJobSchema.nullable(),
  items: z.array(BibleBackfillItemSchema),
  counts: BibleBackfillCountsSchema,
  sections: z.array(BibleBackfillSectionSchema),
  sectionCounts: BibleBackfillSectionCountsSchema,
  usage: BibleBackfillUsageSchema,
  availableActions: z.array(BibleBackfillActionSchema),
  /**
   * Current timeline events the manuscript import created that are still not
   * anchored to a chapter: no settled chapter showed them happening (for
   * example backstory the prose only mentions). Shown to the author when the
   * job finishes so leftover events are never silent.
   */
  unanchoredImportedEvents: z.number().int().nonnegative(),
});
export type BibleBackfillDetailDto = z.infer<typeof BibleBackfillDetailSchema>;

export const BibleBackfillCreatedSchema = BibleBackfillDetailSchema.extend({
  job: BibleBackfillJobSchema,
  idempotentReplay: z.boolean(),
});
export type BibleBackfillCreatedDto = z.infer<
  typeof BibleBackfillCreatedSchema
>;

/** Response of POST …/bible-backfills/:jobId/actions (same shape as creation). */
export const BibleBackfillActionResponseSchema = BibleBackfillCreatedSchema;
export type BibleBackfillActionResponseDto = BibleBackfillCreatedDto;
