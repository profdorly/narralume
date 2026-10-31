import type { AssistantActivity } from "@lapis/persistence";
import type { AssistantActivityTextDto } from "@lapis/contracts";

/**
 * Display text descriptor builder: the key is rendered by the frontend label
 * table; the server produces no natural language.
 */
export function activityText(
  key: string,
  params: Record<string, string | number> = {},
): AssistantActivityTextDto {
  return { key, params };
}

export function activityProgress(completed: number, target: number): string {
  return `${completed}/${target}`;
}

/**
 * Interpolation parameters for a tool activity goal, extracted from the
 * persisted tool input.
 */
export function toolGoalParams(
  activity: AssistantActivity,
): Record<string, string | number> {
  const input = activity.input;
  const params: Record<string, string | number> = {};
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.targetChapters === "number")
      params.count = record.targetChapters;
    if (typeof record.spread === "string") params.spread = record.spread;
    if (typeof record.action === "string") params.action = record.action;
  }
  return params;
}

/**
 * Stage line of a tool activity card (machine code chosen by status /
 * executionMode).
 */
export function toolStage(
  activity: AssistantActivity,
): AssistantActivityTextDto {
  if (activity.status === "proposed")
    return activityText("activity.stage.toolProposed");
  if (activity.status === "running") {
    if (activity.executionMode === "auto")
      return activityText("activity.stage.toolRunningDelegated");
    return activityText("activity.stage.toolRunning");
  }
  if (activity.status === "completed") {
    return activity.executionMode === "auto"
      ? activityText("activity.stage.toolCompletedDelegated")
      : activityText("activity.stage.toolCompleted");
  }
  if (activity.status === "rejected")
    return activityText("activity.stage.toolRejected");
  if (activity.status === "cancelled")
    return activityText("activity.stage.toolCancelled");
  return activityText("activity.stage.toolFailed");
}

/** Summary line after a tool activity completes or is rejected. */
export function toolResultSummary(
  activity: AssistantActivity,
): AssistantActivityTextDto | null {
  if (activity.status === "completed") {
    return activity.executionMode === "auto"
      ? activityText("activity.summary.toolDelegated")
      : activityText("activity.summary.toolCreated");
  }
  if (activity.status === "rejected")
    return activityText("activity.summary.toolRejected");
  return null;
}
