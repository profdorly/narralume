import { z } from "zod";

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
 * A job only ends as completed or cancelled. Anything that stops it early —
 * a failed chapter, a conflict, an unexpected error — parks it in
 * awaiting_user, from which the author can resume, retry, skip or cancel.
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
]);
export type BibleBackfillAction = z.infer<typeof BibleBackfillActionSchema>;

export const CreateBibleBackfillRequestSchema = z
  .object({
    requestId: IdSchema,
    mode: BibleBackfillModeSchema.default("review_each"),
    /** Outline chapter node ids to include; omitted = every chapter with a manuscript. */
    chapterIds: z.array(IdSchema).min(1).max(5_000).optional(),
  })
  .strict();
export type CreateBibleBackfillRequest = z.infer<
  typeof CreateBibleBackfillRequestSchema
>;

export const BibleBackfillActionRequestSchema = z
  .object({
    requestId: IdSchema,
    action: BibleBackfillActionSchema,
    ordinal: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsOrdinal =
      value.action === "skip_item" || value.action === "retry_item";
    if (needsOrdinal && value.ordinal === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ordinal"],
        message: `${value.action} requires the item ordinal`,
      });
    }
    if (!needsOrdinal && value.ordinal !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["ordinal"],
        message: `${value.action} does not take an item ordinal`,
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
  error: BibleBackfillErrorSchema.nullable(),
  pauseRequested: z.boolean(),
  cancelRequested: z.boolean(),
  /** Ordinal of the item currently being settled or awaiting a decision. */
  currentOrdinal: z.number().int().nonnegative().nullable(),
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
  usage: BibleBackfillUsageSchema,
  availableActions: z.array(BibleBackfillActionSchema),
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
