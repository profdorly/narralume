import { z } from "zod";

export * from "./story.js";
export * from "./story-state.js";
export * from "./knowledge.js";
export * from "./run.js";
export * from "./automation.js";
export * from "./studio.js";
export * from "./persona-card.js";
export * from "./persona-card-api.js";
export * from "./lore.js";
export * from "./delivery.js";
export * from "./review.js";
export * from "./long-novel.js";
export * from "./templates.js";
export * from "./lifecycle.js";
export * from "./execution-policy.js";
export * from "./provider-config.js";
export * from "./assistant.js";
export * from "./assistant-tool-policy.js";
export * from "./agent-skills.js";
export * from "./canon-candidate.js";
export * from "./bible-backfill.js";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("narralume"),
  version: z.string(),
  database: z.object({
    status: z.literal("ready"),
    migration: z.number().int().nonnegative(),
  }),
  now: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Request for POST /api/providers/test. `modelId` is the id of a row in the
 * models table (not the provider-side model identifier); the probe result
 * capabilities are written back to that row.
 */
export const ProviderConnectionTestRequestSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  includeStreaming: z.boolean().default(true),
  includeTools: z.boolean().default(true),
  includeStructuredOutput: z.boolean().default(true),
});

export const ConnectionTestStageSchema = z.object({
  stage: z.enum(["text", "stream", "tool", "structured-output"]),
  status: z.enum(["passed", "failed", "unsupported", "skipped"]),
  latencyMs: z.number().int().nonnegative(),
  detail: z.string(),
  /** Set only on the structured-output stage. */
  capability: z.enum(["native", "json-mode", "prompt", "none"]).optional(),
  /**
   * Set only on the text stage once the provider accepted a request, even
   * when the response then failed the text check: the accepted request shape,
   * measured without reasoning effort when the provider rejected it.
   * samplingParameters covers temperature only; the probe never sends top_p.
   */
  requestCapabilities: z
    .object({
      samplingParameters: z.boolean(),
      maxCompletionTokens: z.boolean(),
    })
    .optional(),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("connected"), at: z.string() }),
  z.object({ type: z.literal("heartbeat"), at: z.string() }),
  z.object({
    type: z.literal("model.event"),
    runId: z.string(),
    event: z.unknown(),
  }),
  z.object({
    type: z.literal("run.status"),
    runId: z.string(),
    status: z.string(),
  }),
  z.object({
    type: z.literal("run.event"),
    runId: z.string(),
    stepId: z.string().nullable(),
    sequence: z.number().int().nonnegative(),
    /** The persisted run_events type, e.g. "run.step.retry_scheduled". */
    eventType: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("bible_backfill.status"),
    projectId: z.string(),
    jobId: z.string(),
    /** Job status after the transition. */
    status: z.string(),
    /** Coordinator transition, e.g. "item.settling" or "job.awaiting_decision". */
    action: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export * from "./story-line-proposals.js";
