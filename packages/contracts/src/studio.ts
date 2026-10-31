import { z } from "zod";

import { ModelExecutionPolicySchema } from "./execution-policy.js";
import { DocumentSchema, DocumentVersionSchema } from "./story.js";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const DocumentCommentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  documentId: IdSchema,
  versionId: IdSchema,
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  quote: z.string(),
  body: z.string(),
  status: z.enum(["open", "resolved"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const CreateDocumentCommentRequestSchema = z.object({
  versionId: IdSchema,
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  quote: z.string().min(1).max(100_000),
  body: z.string().trim().min(1).max(30_000),
});
export const UpdateDocumentCommentRequestSchema = z.object({
  status: z.enum(["open", "resolved"]),
});

export const EditProposalSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  documentId: IdSchema,
  baseVersionId: IdSchema,
  runId: IdSchema,
  instruction: z.string(),
  selectionStart: z.number().int().nonnegative(),
  selectionEnd: z.number().int().positive(),
  originalText: z.string(),
  replacementText: z.string(),
  proposedContent: z.string(),
  diff: JsonObjectSchema,
  status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
  acceptedVersionId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
});
export const CreateSelectionEditRequestSchema = z
  .object({
    baseVersionId: IdSchema,
    draftContentHash: z.string().length(64).nullable().default(null),
    selectionStart: z.number().int().nonnegative(),
    selectionEnd: z.number().int().positive(),
    instruction: z.string().trim().min(1).max(20_000),
    policy: ModelExecutionPolicySchema.optional(),
  })
  .strict();
export const DecideEditProposalRequestSchema = z.object({
  requestId: IdSchema,
  action: z.enum(["accept", "reject"]),
});

export const DocumentDraftSchema = z.object({
  projectId: IdSchema,
  documentId: IdSchema,
  baseVersionId: IdSchema.nullable(),
  content: z.string(),
  contentHash: z.string(),
  updatedAt: TimestampSchema,
});
export const SaveDocumentDraftRequestSchema = z.object({
  baseVersionId: IdSchema.nullable(),
  /**
   * The draft updatedAt the client last saw; null asserts there is currently no
   * draft.
   */
  expectedDraftUpdatedAt: TimestampSchema.nullable(),
  content: z.string().max(5_000_000),
});
export const SetDocumentArchivedRequestSchema = z.object({
  archived: z.boolean(),
  expectedUpdatedAt: TimestampSchema,
});

export const StudioDocumentDetailSchema = z.object({
  document: DocumentSchema,
  currentVersion: DocumentVersionSchema.nullable(),
  draft: DocumentDraftSchema.nullable(),
  versions: z.array(DocumentVersionSchema),
  comments: z.array(DocumentCommentSchema),
  proposals: z.array(EditProposalSchema),
});

export type StudioDocumentDetailDto = z.infer<
  typeof StudioDocumentDetailSchema
>;
