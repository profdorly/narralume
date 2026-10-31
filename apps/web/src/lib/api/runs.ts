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
   Runs
   ========================================================================== */

export async function createChapterRun(
  projectId: string,
  input: {
    /**
     * Idempotency key of one submission; network retries reuse the same
     * requestId, only a new submission gets a new one.
     */
    requestId: string;
    targetOutlineNodeId: string;
    planningMode?: "auto" | "confirm";
    origin?: RunOriginInput | null;
    maxRevisionCycles: number;
    /** Sparse override: contains only fields the user changed explicitly. */
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

/**
 * Create a continuation run using partial as the prefix (202; runId is
 * idempotent).
 */
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

/**
 * Append partial to the chapter document's immutable version chain (repeated
 * calls replay idempotently).
 */
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

/** Discard partial and make the harness retry the source step. */
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
