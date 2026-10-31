import { z } from "zod";

import {
  AgentSkillSchema as AgentSkillDtoSchema,
  ImportedAgentSkillSchema,
} from "./agent-skills.js";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const AssistantCanonSpreadSchema = z.enum([
  "intent",
  "outline",
  "entities",
  "facts",
  "relations",
  "timeline",
  "foreshadows",
]);

export const AssistantContextSchema = z
  .object({
    surface: z.string().trim().min(1).max(100),
    documentId: IdSchema.nullable().default(null),
    outlineNodeId: IdSchema.nullable().default(null),
    canonSpread: AssistantCanonSpreadSchema.nullable().default(null),
    selection: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: z.string().max(40_000).nullable().default(null),
      })
      .nullable()
      .default(null),
  })
  .strict();
export type AssistantContext = z.infer<typeof AssistantContextSchema>;

/**
 * Reasoning tier: off = send no parameter and let the model decide; low is the
 * assistant default.
 */
export const AssistantReasoningEffortSchema = z.enum([
  "off",
  "low",
  "medium",
  "high",
]);
export type AssistantReasoningEffort = z.infer<
  typeof AssistantReasoningEffortSchema
>;

export const AssistantConversationSettingsSchema = z
  .object({
    /**
     * Override the model used by the conversation (models.id); null = follow
     * the global writing assignment.
     */
    modelId: IdSchema.nullable(),
    reasoningEffort: AssistantReasoningEffortSchema.nullable(),
  })
  .strict();
export type AssistantConversationSettings = z.infer<
  typeof AssistantConversationSettingsSchema
>;

export const AssistantConversationSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string().min(1).max(200),
  status: z.enum(["active", "archived"]),
  /**
   * Conversation-level model and reasoning tier; a null field means follow the
   * global default.
   */
  settings: AssistantConversationSettingsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AssistantConversationDto = z.infer<
  typeof AssistantConversationSchema
>;

export const AssistantMessageSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(100_000),
  context: AssistantContextSchema.nullable(),
  sourceRunId: IdSchema.nullable(),
  replyToMessageId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});
export type AssistantMessageDto = z.infer<typeof AssistantMessageSchema>;

export const AssistantToolNameSchema = z.enum([
  "story.inspect",
  "review.inspect",
  "foundation.start",
  "chapter.start",
  "autopilot.start",
  "outline.plan.start",
  "canon.candidate.start",
  "selection.edit.start",
  "long_goal.start",
  "task.control",
]);
export type AssistantToolName = z.infer<typeof AssistantToolNameSchema>;

export const AssistantToolCallSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("story.inspect"),
    arguments: z.object({}).strict(),
  }),
  z.object({
    name: z.literal("review.inspect"),
    arguments: z.object({}).strict(),
  }),
  z.object({
    name: z.literal("foundation.start"),
    arguments: z
      .object({
        braindump: z.string().trim().min(1).max(100_000),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("chapter.start"),
    arguments: z.object({ targetOutlineNodeId: IdSchema }).strict(),
  }),
  z.object({
    name: z.literal("autopilot.start"),
    arguments: z
      .object({
        targetChapters: z.number().int().min(1).max(50),
        approvalMode: z.enum(["continuous", "per_chapter"]),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("outline.plan.start"),
    arguments: z
      .object({
        targetChapters: z.number().int().min(1).max(20),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("canon.candidate.start"),
    arguments: z
      .object({
        spread: AssistantCanonSpreadSchema,
        instruction: z.string().trim().min(1).max(20_000),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("selection.edit.start"),
    arguments: z
      .object({
        documentId: IdSchema,
        selectionStart: z.number().int().nonnegative(),
        selectionEnd: z.number().int().nonnegative(),
        instruction: z.string().trim().min(1).max(20_000),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("long_goal.start"),
    arguments: z
      .object({
        targetChapters: z.number().int().min(1).max(50),
        braindump: z
          .string()
          .trim()
          .min(1)
          .max(100_000)
          .nullable()
          .default(null),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("task.control"),
    arguments: z
      .object({
        sourceType: z.enum(["run", "autopilot"]),
        sourceId: IdSchema,
        action: z.enum([
          "pause",
          "resume",
          "cancel",
          "retry-current",
          "skip-chapter",
          "replan",
          "stop",
        ]),
      })
      .strict(),
  }),
]);
export type AssistantToolCall = z.infer<typeof AssistantToolCallSchema>;

export const AssistantToolDescriptorSchema = z.object({
  name: AssistantToolNameSchema,
  label: z.string(),
  description: z.string(),
  access: z.enum(["read", "auto", "confirm"]),
});
export type AssistantToolDescriptorDto = z.infer<
  typeof AssistantToolDescriptorSchema
>;

export const AssistantActivityArtifactSchema = z.object({
  kind: z.string().trim().min(1).max(100),
  id: IdSchema,
  label: z.string().min(1).max(200),
});
export type AssistantActivityArtifactDto = z.infer<
  typeof AssistantActivityArtifactSchema
>;

/** Display text descriptor: key is a machine key of the frontend label table;
 *  params are for interpolation. The server no longer produces any
 *  natural-language display text (the same goes for waitingReason, which sends
 *  only codes). */
export const AssistantActivityTextSchema = z.object({
  key: z.string().trim().min(1).max(120),
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
export type AssistantActivityTextDto = z.infer<
  typeof AssistantActivityTextSchema
>;

export const AssistantActivityErrorSchema = z.object({
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(2_000),
});

export const AssistantActivitySchema = z.object({
  id: IdSchema,
  conversationId: IdSchema.nullable(),
  kind: z.enum(["assistant_response", "task", "tool", "long_goal"]),
  layer: z.enum(["primary", "local", "assistant"]),
  status: z.enum([
    "proposed",
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "rejected",
  ]),
  /**
   * Task card title: a machine-code descriptor; for long tasks a user-written
   * title is a raw string.
   */
  goal: z.union([z.string(), AssistantActivityTextSchema]),
  stage: AssistantActivityTextSchema,
  summary: AssistantActivityTextSchema.nullable(),
  /** Machine code of the parking/waiting reason (e.g.
   *  chapter_commit_approval_required); the display text is rendered by the
   *  frontend label table, so the server no longer maintains its own wording.
   */
  waitingReason: z.string().nullable(),
  availableActions: z.array(z.string()),
  sourceType: z.enum(["run", "autopilot", "assistant_tool", "long_goal"]),
  sourceId: IdSchema,
  origin: AssistantContextSchema.nullable(),
  result: JsonObjectSchema.nullable(),
  toolCall: AssistantToolCallSchema.nullable(),
  skillId: z.string().trim().min(1).max(300).nullable().default(null),
  phaseKey: z.string().trim().min(1).max(100).nullable().default(null),
  artifacts: z.array(AssistantActivityArtifactSchema).default([]),
  lastError: AssistantActivityErrorSchema.nullable().default(null),
  linkedSources: z
    .array(
      z.object({
        type: z.enum(["run", "autopilot", "long_goal"]),
        id: IdSchema,
      }),
    )
    .default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AssistantActivityDto = z.infer<typeof AssistantActivitySchema>;

export const AssistantConversationDetailSchema = z.object({
  conversation: AssistantConversationSchema,
  messages: z.array(AssistantMessageSchema),
  activities: z.array(AssistantActivitySchema),
  tools: z.array(AssistantToolDescriptorSchema),
  skills: z.array(AgentSkillDtoSchema).default([]),
  importedSkills: z.array(ImportedAgentSkillSchema).default([]),
});
export type AssistantConversationDetailDto = z.infer<
  typeof AssistantConversationDetailSchema
>;

export const CreateAssistantConversationRequestSchema = z
  .object({
    requestId: IdSchema,
    title: z.string().trim().min(1).max(200).default("Colaboração no projeto"),
  })
  .strict();
export type CreateAssistantConversationRequest = z.infer<
  typeof CreateAssistantConversationRequestSchema
>;

export const ArchiveAssistantConversationRequestSchema = z
  .object({ action: z.literal("archive") })
  .strict();

export const RenameAssistantConversationRequestSchema = z
  .object({
    action: z.literal("rename"),
    title: z.string().trim().min(1).max(200),
  })
  .strict();
export type RenameAssistantConversationRequest = z.infer<
  typeof RenameAssistantConversationRequestSchema
>;

/**
 * Carries at least one setting to change; modelId=null clears the override and
 * returns to the global default.
 */
export const ConfigureAssistantConversationRequestSchema = z
  .object({
    action: z.literal("configure"),
    modelId: IdSchema.nullable().optional(),
    reasoningEffort: AssistantReasoningEffortSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.modelId !== undefined || value.reasoningEffort !== undefined,
    { message: "Provide a new model or reasoning effort" },
  );
export type ConfigureAssistantConversationRequest = z.infer<
  typeof ConfigureAssistantConversationRequestSchema
>;

/**
 * Union request body of the conversation action endpoint: archive, rename, or
 * adjust the model/reasoning tier.
 */
export const AssistantConversationActionRequestSchema = z.union([
  ArchiveAssistantConversationRequestSchema,
  RenameAssistantConversationRequestSchema,
  ConfigureAssistantConversationRequestSchema,
]);
export type AssistantConversationActionRequest = z.infer<
  typeof AssistantConversationActionRequestSchema
>;

export const CreateAssistantMessageRequestSchema = z
  .object({
    requestId: IdSchema,
    content: z.string().trim().min(1).max(100_000),
    context: AssistantContextSchema,
  })
  .strict();
export type CreateAssistantMessageRequest = z.infer<
  typeof CreateAssistantMessageRequestSchema
>;

export const AssistantMessageAcceptedSchema = z.object({
  message: AssistantMessageSchema,
  runId: IdSchema,
  idempotentReplay: z.boolean(),
});
export type AssistantMessageAcceptedDto = z.infer<
  typeof AssistantMessageAcceptedSchema
>;

export const AssistantActivityActionRequestSchema = z
  .object({
    action: z.enum(["confirm", "reject", "retry", "resume", "cancel"]),
  })
  .strict();

export const AssistantActivityActionResponseSchema = z.object({
  activity: AssistantActivitySchema,
  source: z
    .object({ type: z.enum(["run", "autopilot", "long_goal"]), id: IdSchema })
    .nullable(),
});
export type AssistantActivityActionResponseDto = z.infer<
  typeof AssistantActivityActionResponseSchema
>;
