import type {
  AdoptRunStreamResponse,
  ChapterRunCreatedDto,
  ContinueRunStreamRequest,
  ModelExecutionPolicy,
  RegenerateRunStreamResponse,
} from "@lapis/contracts";

import { jsonRequest, requestJson } from "./transport";
import type {
  ContextPreview,
  NarrativeRun,
  RunActionRequest,
  RunDetail,
  RunOriginInput,
  RunSnapshot,
} from "./types";

export async function previewContext(
  projectId: string,
  input: {
    task: string;
    query: string;
    entityIds: string[];
    currentOutlineNodeId: string | null;
    access: { audience: "author"; includeCandidates: boolean };
  },
): Promise<ContextPreview> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/context/preview`,
    jsonRequest("POST", { purpose: "studio-preview", ...input }),
  );
}

/* ==========================================================================
   运行
   ========================================================================== */

export async function createChapterRun(
  projectId: string,
  input: {
    /** 同一次提交的幂等键；网络重试复用同一个 requestId，重新提交才换新。 */
    requestId: string;
    targetOutlineNodeId: string;
    planningMode?: "auto" | "confirm";
    origin?: RunOriginInput | null;
    maxRevisionCycles: number;
    /** 稀疏覆盖：只包含用户显式改过的字段。 */
    policy?: ModelExecutionPolicy;
  },
): Promise<ChapterRunCreatedDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/runs/chapter`,
    jsonRequest("POST", input),
  );
}

export async function getProjectRuns(
  projectId: string,
  signal?: AbortSignal,
): Promise<NarrativeRun[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/runs`,
    signal ? { signal } : {},
  );
}

export async function getRunDetail(
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RunDetail> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}?projectId=${encodeURIComponent(projectId)}`,
    signal ? { signal } : {},
  );
}

export async function controlRun(
  projectId: string,
  runId: string,
  action: RunActionRequest,
): Promise<RunSnapshot> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/actions`,
    jsonRequest("POST", { ...action, projectId }),
  );
}

export async function advanceRun(
  projectId: string,
  runId: string,
): Promise<{
  processed: boolean;
  snapshot: RunSnapshot;
}> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/advance`,
    jsonRequest("POST", { projectId }),
  );
}

export async function discardRunStream(
  projectId: string,
  runId: string,
  stepId: string,
  attempt: number,
): Promise<{ discarded: boolean }> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/streams/discard`,
    jsonRequest("POST", { projectId, stepId, attempt }),
  );
}

/** 以 partial 为前缀创建续写运行（202；runId 幂等）。 */
export async function continueRunStream(
  projectId: string,
  runId: string,
  input: Omit<ContinueRunStreamRequest, "projectId">,
): Promise<ChapterRunCreatedDto> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/streams/continue`,
    jsonRequest("POST", { ...input, projectId }),
  );
}

/** 把 partial 追加进章节文档的不可变版本链（重复调用幂等回放）。 */
export async function adoptRunStream(
  projectId: string,
  runId: string,
  input: Omit<ContinueRunStreamRequest, "projectId">,
): Promise<AdoptRunStreamResponse> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/streams/adopt`,
    jsonRequest("POST", { ...input, projectId }),
  );
}

/** 丢弃 partial 并推动 harness 重试来源步骤。 */
export async function regenerateRunStream(
  projectId: string,
  runId: string,
  input: Omit<ContinueRunStreamRequest, "projectId">,
): Promise<RegenerateRunStreamResponse> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/streams/regenerate`,
    jsonRequest("POST", { ...input, projectId }),
  );
}
