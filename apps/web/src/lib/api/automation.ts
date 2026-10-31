import type { ModelExecutionPolicy } from "@lapis/contracts";

import { jsonRequest, requestJson } from "./transport";
import type {
  AutopilotSession,
  AutopilotSessionDetail,
  RunOriginInput,
  SessionActionRequest,
  StorySteer,
} from "./types";

export async function createAutopilotSession(
  projectId: string,
  input: {
    /**
     * Idempotency key of one submission; network retries reuse the same
     * requestId, only a new submission gets a new one.
     */
    requestId: string;
    /**
     * continuous = multi-chapter continuous production (AI quick create);
     * per_chapter = chapter-by-chapter approval.
     */
    approvalMode?: "continuous" | "per_chapter";
    planningMode?: "auto" | "confirm";
    origin?: RunOriginInput | null;
    targetChapters: number;
    windowSize: number;
    maxRevisionCycles: number;
    /** Sparse override. */
    chapterPolicy?: ModelExecutionPolicy;
  },
): Promise<AutopilotSession & { idempotentReplay: boolean }> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/autopilot/sessions`,
    jsonRequest("POST", input),
  );
}

export async function getAutopilotSessions(
  projectId: string,
  signal?: AbortSignal,
): Promise<AutopilotSession[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/autopilot/sessions`,
    signal ? { signal } : {},
  );
}

export async function getAutopilotSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<AutopilotSessionDetail> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}`,
    signal ? { signal } : {},
  );
}

export async function controlAutopilotSession(
  sessionId: string,
  action: SessionActionRequest,
): Promise<AutopilotSessionDetail> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/actions`,
    jsonRequest("POST", action),
  );
}

export async function resolveAutopilotFailure(
  sessionId: string,
  action: "retry-current" | "skip-chapter" | "replan" | "stop",
): Promise<AutopilotSessionDetail> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/resolutions`,
    jsonRequest("POST", { action }),
  );
}

export async function sendStorySteer(
  sessionId: string,
  input: { requestId: string; content: string },
): Promise<StorySteer> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/steers`,
    jsonRequest("POST", input),
  );
}

export async function decideStorySteer(
  sessionId: string,
  steerId: string,
  action: "apply" | "reject",
): Promise<{ steer: StorySteer; detail: AutopilotSessionDetail }> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/steers/${encodeURIComponent(steerId)}/decisions`,
    jsonRequest("POST", { action }),
  );
}

export async function advanceAutopilotSession(
  sessionId: string,
): Promise<{ processed: boolean; detail: AutopilotSessionDetail }> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/advance`,
    jsonRequest("POST", {}),
  );
}
