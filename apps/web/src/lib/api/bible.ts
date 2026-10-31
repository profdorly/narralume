import type {
  BibleBackfillAction,
  BibleBackfillCreatedDto,
  BibleBackfillDetailDto,
  BibleBackfillMode,
  CanonCandidateSetDto,
  CanonSpread,
  KnowledgeEditorDto,
  KnowledgeWrite,
  KnowledgeWriteResult,
  ModelExecutionPolicy,
  OutlineChangePreview,
  OutlineChangeRequest,
  RetrievalIndexStatusDto,
  RetrievalReindexResultDto,
  StoryLineProposalSetDto,
  StoryStateQuery,
  StoryStateSnapshotDto,
} from "@lapis/contracts";

import { ApiError, jsonRequest, requestJson } from "./transport";
import type {
  AuthorIntent,
  BackgroundRunCreated,
  CanonEntity,
  CanonFact,
  Foreshadow,
  FoundationCandidate,
  FoundationCandidateSet,
  NarrativeMemory,
  OutlineNode,
  PlotPrediction,
  ProjectFoundationTaskCreated,
  RelationshipEvent,
  RetrievalHit,
  StoryBible,
  StoryCompass,
  StoryDevelopmentReview,
  TimelineEvent,
} from "./types";

export async function getStoryBible(
  projectId: string,
  signal?: AbortSignal,
): Promise<StoryBible> {
  return requestJson<StoryBible>(
    `/api/projects/${encodeURIComponent(projectId)}/story-bible`,
    signal ? { signal } : {},
  );
}

export async function getStoryState(projectId: string, input: StoryStateQuery, signal?: AbortSignal): Promise<StoryStateSnapshotDto> {
  const query = new URLSearchParams(input);
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/story-state?${query}`, signal ? { signal } : {});
}

export async function getKnowledgeEditor(projectId: string, signal?: AbortSignal): Promise<KnowledgeEditorDto> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, signal ? { signal } : {});
}

export async function writeKnowledge(projectId: string, input: KnowledgeWrite): Promise<KnowledgeWriteResult> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, jsonRequest("POST", input));
}

export async function startCanonCandidate(
  projectId: string,
  spread: CanonSpread,
  input: { requestId: string; instruction: string },
): Promise<{ runId: string; idempotentReplay: boolean }> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-spreads/${encodeURIComponent(spread)}/candidates`,
    jsonRequest("POST", input),
  );
}

export async function getCanonCandidates(
  projectId: string,
  spread: CanonSpread,
  signal?: AbortSignal,
): Promise<CanonCandidateSetDto[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-spreads/${encodeURIComponent(spread)}/candidates`,
    signal ? { signal } : {},
  );
}

export async function decideCanonCandidateItem(
  projectId: string,
  candidateSetId: string,
  itemId: string,
  input: { action: "apply" | "reject"; confirmLocked?: boolean },
): Promise<{
  candidateSet: CanonCandidateSetDto;
  item: CanonCandidateSetDto["items"][number];
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-candidates/${encodeURIComponent(candidateSetId)}/items/${encodeURIComponent(itemId)}/decisions`,
    jsonRequest("POST", input),
  );
}

export async function updateAuthorIntent(
  projectId: string,
  input: Partial<Omit<AuthorIntent, "projectId" | "updatedAt">> & {
    expectedUpdatedAt: string | null;
  },
): Promise<AuthorIntent> {
  return requestJson<AuthorIntent>(
    `/api/projects/${encodeURIComponent(projectId)}/intent`,
    jsonRequest("PUT", input),
  );
}

export async function createCanonEntity(
  projectId: string,
  input: {
    type: CanonEntity["type"];
    name: string;
    aliases: string[];
    description: string | null;
    attributes?: Record<string, unknown>;
  },
): Promise<CanonEntity> {
  return requestJson<CanonEntity>(
    `/api/projects/${encodeURIComponent(projectId)}/entities`,
    jsonRequest("POST", input),
  );
}

export async function updateCanonEntity(
  projectId: string,
  entityId: string,
  input: Pick<
    CanonEntity,
    "name" | "aliases" | "description" | "attributes" | "status"
  > & { expectedUpdatedAt: string },
): Promise<CanonEntity> {
  return requestJson<CanonEntity>(
    `/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entityId)}`,
    jsonRequest("PUT", input),
  );
}

interface StoryResourceRemoval {
  id: string;
  disposition: "deleted" | "abandoned" | "retired" | "voided";
  references: number;
}

function removeStoryResource(path: string, expectedUpdatedAt: string) {
  return requestJson<StoryResourceRemoval>(
    path,
    jsonRequest("DELETE", { expectedUpdatedAt }),
  );
}

export function removeCanonEntity(projectId: string, entity: CanonEntity) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entity.id)}`,
    entity.updatedAt,
  );
}

export async function createOutlineNode(
  projectId: string,
  input: {
    parentId: string;
    kind: OutlineNode["kind"];
    ordinal: number;
    title: string;
    summary: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<OutlineNode> {
  return requestJson<OutlineNode>(
    `/api/projects/${encodeURIComponent(projectId)}/outline`,
    jsonRequest("POST", input),
  );
}

export async function updateOutlineNode(
  projectId: string,
  nodeId: string,
  input: Partial<
    Pick<
      OutlineNode,
      | "title"
      | "summary"
      | "goal"
      | "conflict"
      | "outcome"
      | "povEntityId"
      | "storyTime"
      | "status"
      | "metadata"
    >
  > & { expectedUpdatedAt: string },
): Promise<OutlineNode> {
  return requestJson<OutlineNode>(
    `/api/projects/${encodeURIComponent(projectId)}/outline/${encodeURIComponent(nodeId)}`,
    jsonRequest("PUT", input),
  );
}

export type { OutlineChangeRequest } from "@lapis/contracts";

export function previewOutlineChange(projectId: string, change: OutlineChangeRequest): Promise<OutlineChangePreview> {
  return requestJson<OutlineChangePreview>(`/api/projects/${encodeURIComponent(projectId)}/outline/changes/preview`, jsonRequest("POST", change));
}

export function applyOutlineChange(projectId: string, change: OutlineChangeRequest, previewFingerprint: string): Promise<OutlineNode[]> {
  return requestJson<OutlineNode[]>(`/api/projects/${encodeURIComponent(projectId)}/outline/changes`, jsonRequest("POST", { change, previewFingerprint }));
}

export function removeOutlineNode(projectId: string, node: OutlineNode) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/outline/${encodeURIComponent(node.id)}`,
    node.updatedAt,
  );
}

export async function createCanonFact(
  projectId: string,
  input: {
    subjectId: string;
    predicate: string;
    objectEntityId?: string | null;
    value?: unknown;
    authority: CanonFact["authority"];
    knowledgeScope: CanonFact["knowledgeScope"];
    knowledgeSubjectId?: string | null;
    confidence?: number;
  },
): Promise<{
  fact: CanonFact;
  conflicts: { reason: string; fact: CanonFact }[];
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/facts`,
    jsonRequest("POST", input),
  );
}

export async function reviseCanonFact(
  projectId: string,
  factId: string,
  input: {
    subjectId: string;
    predicate: string;
    objectEntityId: string | null;
    value?: unknown;
    validFromNodeId: string | null;
    validToNodeId: string | null;
    knowledgeScope: CanonFact["knowledgeScope"];
    knowledgeSubjectId: string | null;
    authority: CanonFact["authority"];
    confidence: number;
    confirmLockedRevision: boolean;
  },
): Promise<{
  fact: CanonFact;
  conflicts: { reason: string; fact: CanonFact }[];
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/facts/${encodeURIComponent(factId)}`,
    jsonRequest("PUT", input),
  );
}

export async function promoteCanonFact(
  projectId: string,
  factId: string,
  authority: "inferred" | "confirmed" | "locked",
): Promise<CanonFact> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/facts/${encodeURIComponent(factId)}/promote`,
    jsonRequest("POST", { authority }),
  );
}

export async function withdrawCanonFact(
  projectId: string,
  factId: string,
  input: {
    reason: string;
    confirmLockedWithdrawal: boolean;
  },
): Promise<{
  factId: string;
  projectId: string;
  reason: string;
  withdrawnAt: string;
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/facts/${encodeURIComponent(factId)}/withdraw`,
    jsonRequest("POST", input),
  );
}

export async function createRelationshipEvent(
  projectId: string,
  input: Omit<RelationshipEvent, "id" | "projectId" | "createdAt">,
): Promise<RelationshipEvent> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/relationships`,
    jsonRequest("POST", input),
  );
}

export function removeRelationshipEvent(
  projectId: string,
  relationship: RelationshipEvent,
) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/relationships/${encodeURIComponent(relationship.id)}`,
    relationship.createdAt,
  );
}

export async function createTimelineEvent(
  projectId: string,
  input: Omit<TimelineEvent, "id" | "projectId" | "createdAt" | "updatedAt">,
): Promise<TimelineEvent> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/timeline`,
    jsonRequest("POST", input),
  );
}

export async function updateTimelineEvent(
  projectId: string,
  eventId: string,
  input: Omit<TimelineEvent, "id" | "projectId" | "createdAt" | "updatedAt"> & {
    expectedUpdatedAt: string;
  },
): Promise<TimelineEvent> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/timeline/${encodeURIComponent(eventId)}`,
    jsonRequest("PUT", input),
  );
}

export function removeTimelineEvent(projectId: string, event: TimelineEvent) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/timeline/${encodeURIComponent(event.id)}`,
    event.updatedAt,
  );
}

export async function createForeshadow(
  projectId: string,
  input: Omit<Foreshadow, "id" | "projectId" | "createdAt" | "updatedAt">,
): Promise<Foreshadow> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/foreshadows`,
    jsonRequest("POST", input),
  );
}

export async function updateForeshadow(
  projectId: string,
  foreshadowId: string,
  input: Omit<Foreshadow, "id" | "projectId" | "createdAt" | "updatedAt"> & {
    expectedUpdatedAt: string;
  },
): Promise<Foreshadow> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/foreshadows/${encodeURIComponent(foreshadowId)}`,
    jsonRequest("PUT", input),
  );
}

export function removeForeshadow(projectId: string, item: Foreshadow) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/foreshadows/${encodeURIComponent(item.id)}`,
    item.updatedAt,
  );
}

export type {
  BibleBackfillAction,
  BibleBackfillDetailDto,
  BibleBackfillCreatedDto,
  BibleBackfillItemDto,
  BibleBackfillJobDto,
  BibleBackfillMode,
  BibleBackfillUsageDto,
} from "@lapis/contracts";

/** 建任务；同一 requestId 重放返回原任务（idempotentReplay）。 */
export async function startBibleBackfill(
  projectId: string,
  input: {
    requestId: string;
    mode?: BibleBackfillMode;
    chapterIds?: string[];
    /** 重新读已结算过的章节（“Re-read chapter”），补缺漏、纠正错误。 */
    rereadSettled?: boolean;
  },
): Promise<BibleBackfillCreatedDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/bible-backfills`,
    jsonRequest("POST", input),
  );
}

/** 当前任务：有活动任务取活动任务，否则取最近一次；从未开始时 job 为 null。 */
export async function getCurrentBibleBackfill(
  projectId: string,
  signal?: AbortSignal,
): Promise<BibleBackfillDetailDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/bible-backfills/current`,
    signal ? { signal } : {},
  );
}

/** 作者控制：pause / resume / cancel，skip_item / retry_item 需带 ordinal。 */
export async function actOnBibleBackfill(
  projectId: string,
  jobId: string,
  input: {
    requestId: string;
    action: BibleBackfillAction;
    ordinal?: number;
  },
): Promise<BibleBackfillCreatedDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/bible-backfills/${encodeURIComponent(jobId)}/actions`,
    jsonRequest("POST", input),
  );
}

/* ==========================================================================
   建书（foundation）/ 自动驾驶
   ========================================================================== */

export async function generateFoundation(
  projectId: string,
  input: {
    requestId: string;
    braindump: string;
    /** 稀疏覆盖；qualityPreset 在这里选择。 */
    policy?: ModelExecutionPolicy;
    preferences: {
      genre: string | null;
      audience: string | null;
      tone: string | null;
      targetChapters: number;
      wordsPerChapter: number;
      volumes: number;
    };
  },
): Promise<BackgroundRunCreated> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/foundation/generate`,
    jsonRequest("POST", input),
  );
}

/** AI 引导建书：一次请求同时立项并发起 foundation 后台任务（202，幂等）。 */
export async function createProjectWithFoundation(input: {
  requestId: string;
  title: string;
  subtitle?: string | null;
  premise?: string | null;
  language?: string;
  form?: "short-story" | "novella" | "novel";
  braindump: string;
  policy?: ModelExecutionPolicy;
  preferences?: {
    genre: string | null;
    audience: string | null;
    tone: string | null;
    targetChapters: number;
    wordsPerChapter: number;
    volumes: number;
  };
}): Promise<ProjectFoundationTaskCreated> {
  return requestJson("/api/projects/with-foundation", jsonRequest("POST", input));
}

export async function getFoundationCandidates(
  projectId: string,
  signal?: AbortSignal,
): Promise<FoundationCandidateSet[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/foundation/candidates`,
    signal ? { signal } : {},
  );
}

export async function resolveFoundationCandidate(
  candidateId: string,
  action: "adopt" | "discard",
  payload?: Record<string, unknown>,
): Promise<FoundationCandidate> {
  return requestJson(
    `/api/candidates/${encodeURIComponent(candidateId)}/actions`,
    jsonRequest("POST", { action, ...(payload ? { payload } : {}) }),
  );
}

export async function resolveFoundationCandidateSet(
  setId: string,
  action: "adopt-all" | "discard-all",
): Promise<FoundationCandidateSet> {
  return requestJson(
    `/api/candidate-sets/${encodeURIComponent(setId)}/actions`,
    jsonRequest("POST", { action }),
  );
}

export async function getStoryCompass(
  projectId: string,
  signal?: AbortSignal,
): Promise<StoryCompass | null> {
  try {
    return await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/compass`,
      signal ? { signal } : {},
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "story_compass.not_found") {
      return null;
    }
    throw error;
  }
}

export async function updateStoryCompass(
  projectId: string,
  input: Omit<StoryCompass, "projectId" | "version" | "updatedAt"> & {
    expectedVersion: number | null;
  },
): Promise<StoryCompass> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/compass`,
    jsonRequest("PUT", input),
  );
}

export function getStoryDevelopmentReviews(projectId: string, signal?: AbortSignal): Promise<StoryDevelopmentReview[]> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/compass/reviews`, signal ? { signal } : {});
}

export async function searchProjectMemory(
  projectId: string,
  input: {
    query: string;
    entityIds?: string[];
    limit?: number;
    rerank?: boolean;
    maxPerDocument?: number;
  },
): Promise<RetrievalHit[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/retrieval/search`,
    jsonRequest("POST", input),
  );
}

export async function getRetrievalIndexStatus(
  projectId: string,
  signal?: AbortSignal,
): Promise<RetrievalIndexStatusDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/retrieval/index`,
    signal ? { signal } : {},
  );
}

export async function reindexProjectRetrieval(
  projectId: string,
): Promise<RetrievalReindexResultDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/retrieval/reindex`,
    jsonRequest("POST", {}),
  );
}

export async function getNarrativeMemories(
  projectId: string,
  includeStale = false,
  signal?: AbortSignal,
): Promise<NarrativeMemory[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/memories?includeStale=${includeStale}`,
    signal ? { signal } : {},
  );
}

export async function rebuildNarrativeMemories(
  projectId: string,
): Promise<NarrativeMemory[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/memories/rebuild`,
    jsonRequest("POST", {}),
  );
}

export async function consolidateNarrativeMemory(
  projectId: string,
): Promise<NarrativeMemory | null> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/memories/sleep`,
    jsonRequest("POST", {}),
  );
}

export async function getPlotPredictions(
  projectId: string,
  signal?: AbortSignal,
): Promise<PlotPrediction[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/predictions`,
    signal ? { signal } : {},
  );
}

export async function generatePlotPredictions(
  projectId: string,
  input: { direction: string; horizon: number; count: number },
): Promise<PlotPrediction[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/predictions`,
    jsonRequest("POST", input),
  );
}

export async function decidePlotPrediction(
  projectId: string,
  predictionId: string,
  status: "adopted" | "dismissed",
): Promise<PlotPrediction> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/predictions/${encodeURIComponent(predictionId)}`,
    jsonRequest("PUT", { status }),
  );
}

export function getStoryLineProposals(projectId: string, signal?: AbortSignal): Promise<StoryLineProposalSetDto[]> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/compass/proposals`, signal ? { signal } : {});
}
export function decideStoryLineProposal(projectId: string, setId: string, itemId: string, action: "apply" | "reject"): Promise<StoryLineProposalSetDto> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/compass/proposals/${encodeURIComponent(setId)}/items/${encodeURIComponent(itemId)}/decision`, jsonRequest("POST", { action }));
}
