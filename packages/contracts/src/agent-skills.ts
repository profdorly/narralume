import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);

/**
 * Agent Skill: a code-owned task orchestration declaration, separate from
 * Writing Skills (the writing prompt layer). A Skill only declares its trigger
 * scope, required context, allowed existing domain capabilities, output type
 * and stopping points; it cannot register new tools or write to the database
 * directly. Specialist roles (Writer/Reviewer) exist only as internal steps.
 */
export const AgentSkillOutputKindSchema = z.enum([
  "answer",
  "candidate",
  "task_handle",
  "long_goal",
]);
export type AgentSkillOutputKind = z.infer<typeof AgentSkillOutputKindSchema>;

export const AgentSkillCheckpointSchema = z.enum([
  "none",
  "confirm_start",
  "candidate_adoption",
]);
export type AgentSkillCheckpoint = z.infer<typeof AgentSkillCheckpointSchema>;

export const AgentSkillSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(2_000),
  triggerDescription: z.string().min(1).max(2_000),
  requiredContext: z.array(z.string().min(1).max(100)),
  allowedCapabilities: z.array(z.string().trim().min(1).max(100)),
  outputKind: AgentSkillOutputKindSchema,
  checkpoint: AgentSkillCheckpointSchema,
  builtin: z.literal(true),
});
export type AgentSkillDto = z.infer<typeof AgentSkillSchema>;

/**
 * Imported Agent Skill (R9): same shape as the built-in registry, but with
 * builtin=false, plus its source and content hash, and enabled per project.
 * The package format may only declare name, version, trigger description,
 * instructions, references, capability allowlist, output contract and stopping
 * policy; scripts, shell, network plugins, database writes and dynamic tool
 * registration are not allowed. The first phase only allows read-only and
 * candidate-type capabilities.
 */
export const ImportedAgentSkillSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  label: z.string().min(1).max(100),
  version: z.string().trim().min(1).max(50),
  description: z.string().min(1).max(2_000),
  triggerDescription: z.string().min(1).max(2_000),
  instructions: z.string().min(1).max(100_000),
  references: z.array(
    z.object({
      path: z.string().min(1).max(500),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  ),
  requiredContext: z.array(z.string().min(1).max(100)),
  allowedCapabilities: z.array(z.string().trim().min(1).max(100)),
  outputKind: AgentSkillOutputKindSchema,
  checkpoint: AgentSkillCheckpointSchema,
  enabled: z.boolean(),
  source: z.string().min(1).max(500),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ImportedAgentSkillDto = z.infer<typeof ImportedAgentSkillSchema>;

export const ImportAgentSkillPackageRequestSchema = z
  .object({
    filename: z.string().trim().min(1).max(300),
    contentBase64: z.string().min(1).max(12_000_000),
  })
  .strict();
export type ImportAgentSkillPackageRequest = z.infer<
  typeof ImportAgentSkillPackageRequestSchema
>;

/**
 * The only capabilities first-phase imported Skills may use: read-only queries
 * (story/review.inspect) and candidate-type capabilities
 * (outline/canon/selection candidate generation, task.control task control).
 * Confirm-level capabilities that advance official state or spend a large
 * writing budget (foundation/chapter/autopilot/long_goal) are not open to
 * imported packages; they still go through the system's built-in decision
 * endpoints.
 */
export const IMPORTABLE_AGENT_SKILL_CAPABILITIES: readonly string[] = [
  "story.inspect",
  "review.inspect",
  "outline.plan.start",
  "canon.candidate.start",
  "selection.edit.start",
  "task.control",
];

export const SetImportedAgentSkillEnabledRequestSchema = z
  .object({
    enabled: z.boolean(),
    expectedUpdatedAt: TimestampSchema,
  })
  .strict();
export type SetImportedAgentSkillEnabledRequest = z.infer<
  typeof SetImportedAgentSkillEnabledRequestSchema
>;

export const AssistantLongGoalPhaseSchema = z.enum([
  "foundation",
  "outline",
  "writing",
  "done",
]);
export type AssistantLongGoalPhase = z.infer<
  typeof AssistantLongGoalPhaseSchema
>;

export const AssistantLongGoalStatusSchema = z.enum([
  "active",
  "paused_baseline",
  "completed",
  "failed",
  "cancelled",
]);
export type AssistantLongGoalStatus = z.infer<
  typeof AssistantLongGoalStatusSchema
>;

export const AssistantLongGoalSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  conversationId: IdSchema,
  activityId: IdSchema,
  title: z.string().min(1).max(200),
  targetChapters: z.number().int().min(1).max(500),
  phase: AssistantLongGoalPhaseSchema,
  status: AssistantLongGoalStatusSchema,
  baselineHash: z.string().min(1),
  sessionId: IdSchema.nullable(),
  foundationRunId: IdSchema.nullable(),
  outlineSessionId: IdSchema.nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AssistantLongGoalDto = z.infer<typeof AssistantLongGoalSchema>;

export const StartAssistantLongGoalRequestSchema = z
  .object({
    requestId: IdSchema,
    targetChapters: z.number().int().min(1).max(50),
    braindump: z.string().trim().min(1).max(100_000).nullable().default(null),
  })
  .strict();
export type StartAssistantLongGoalRequest = z.infer<
  typeof StartAssistantLongGoalRequestSchema
>;

export const AssistantLongGoalAcceptedSchema = z.object({
  goal: AssistantLongGoalSchema,
  idempotentReplay: z.boolean(),
});
export type AssistantLongGoalAcceptedDto = z.infer<
  typeof AssistantLongGoalAcceptedSchema
>;

export const AssistantLongGoalActionRequestSchema = z
  .object({ action: z.enum(["resume", "cancel"]) })
  .strict();
