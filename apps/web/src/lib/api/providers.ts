import type {
  AssignmentRole,
  ModelAssignmentDto,
  ModelConfigDto,
  PublicProviderDto,
  UpsertModelRequest,
  UpsertProviderRequest,
} from "@lapis/contracts";

import { jsonRequest, requestJson, requestVoid } from "./transport";

export async function listProviders(
  signal?: AbortSignal,
): Promise<PublicProviderDto[]> {
  return requestJson("/api/providers", signal ? { signal } : {});
}

export async function createProvider(
  input: UpsertProviderRequest,
): Promise<PublicProviderDto> {
  return requestJson("/api/providers", jsonRequest("POST", input));
}

export async function updateProvider(
  providerId: string,
  input: UpsertProviderRequest & { expectedUpdatedAt: string },
): Promise<PublicProviderDto> {
  return requestJson(
    `/api/providers/${encodeURIComponent(providerId)}`,
    jsonRequest("PUT", input),
  );
}

export async function deleteProvider(providerId: string): Promise<void> {
  return requestVoid(`/api/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

export interface ProbeStage {
  stage:
    | "text"
    | "stream"
    | "tool"
    | "structured-output"
    | "embedding"
    | "decision";
  status: "passed" | "failed" | "unsupported" | "skipped";
  latencyMs: number;
  detail: string;
  /** 仅 structured-output 阶段返回：native | json-mode | prompt | none */
  capability?: string;
  /**
   * Set only on the text stage once the provider accepted a request, even
   * when the response then failed the text check: the accepted request shape,
   * measured without reasoning effort when the provider rejected it.
   * samplingParameters covers temperature only; the probe never sends top_p.
   */
  requestCapabilities?: {
    samplingParameters: boolean;
    maxCompletionTokens: boolean;
  };
}

export interface ProviderProbeResult {
  providerId: string;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  stages: ProbeStage[];
}

export async function probeProvider(input: {
  providerId: string;
  modelId: string;
  includeStreaming?: boolean;
  includeTools?: boolean;
  includeStructuredOutput?: boolean;
}): Promise<ProviderProbeResult> {
  return requestJson(
    "/api/providers/test",
    jsonRequest("POST", {
      providerId: input.providerId,
      modelId: input.modelId,
      includeStreaming: input.includeStreaming ?? true,
      includeTools: input.includeTools ?? true,
      includeStructuredOutput: input.includeStructuredOutput ?? true,
    }),
  );
}

export async function listModels(
  providerId?: string,
  signal?: AbortSignal,
): Promise<ModelConfigDto[]> {
  const query = providerId
    ? `?providerId=${encodeURIComponent(providerId)}`
    : "";
  return requestJson(`/api/models${query}`, signal ? { signal } : {});
}

export async function createModel(
  input: UpsertModelRequest,
): Promise<ModelConfigDto> {
  return requestJson("/api/models", jsonRequest("POST", input));
}

export async function updateModel(
  modelId: string,
  input: UpsertModelRequest & { expectedUpdatedAt: string },
): Promise<ModelConfigDto> {
  return requestJson(
    `/api/models/${encodeURIComponent(modelId)}`,
    jsonRequest("PUT", input),
  );
}

export async function deleteModel(modelId: string): Promise<void> {
  return requestVoid(`/api/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
}

export async function listAssignments(
  signal?: AbortSignal,
): Promise<ModelAssignmentDto[]> {
  return requestJson("/api/assignments", signal ? { signal } : {});
}

export async function setAssignment(
  role: AssignmentRole,
  modelId: string,
): Promise<ModelAssignmentDto> {
  return requestJson(
    `/api/assignments/${encodeURIComponent(role)}`,
    jsonRequest("PUT", { modelId }),
  );
}

export async function deleteAssignment(role: AssignmentRole): Promise<void> {
  return requestVoid(`/api/assignments/${encodeURIComponent(role)}`, {
    method: "DELETE",
  });
}
