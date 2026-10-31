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
    /** 同一次提交的幂等键；网络重试复用同一个 requestId，重新提交才换新。 */
    requestId: string;
    /** continuous = 多章连续生产（AI 快速创作）；per_chapter = 逐章验收。 */
    approvalMode?: "continuous" | "per_chapter";
    planningMode?: "auto" | "confirm";
    origin?: RunOriginInput | null;
    targetChapters: number;
    windowSize: number;
    maxRevisionCycles: number;
    /** 稀疏覆盖。 */
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

