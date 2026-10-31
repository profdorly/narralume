import type { QueryClient } from "@tanstack/react-query";

import { getLocale, translate, type MessageKey } from "../../i18n";
import type {
  AssistantActivityDto,
  AssistantContext,
  AssistantConversationDetailDto,
  AssistantMessageDto,
} from "../../lib/api";
import { projectWorkspacePath } from "../../lib/project-route";

type TimelineEntry =
  | { type: "message"; at: string; id: string; message: AssistantMessageDto }
  | {
      type: "activity";
      at: string;
      id: string;
      activity: AssistantActivityDto;
    };

const CONVERSATION_KEY_PREFIX = "lapis:assistant-conversation:";

const PHASE_LABEL_KEYS: Record<string, MessageKey> = {
  queued: "assistant.phase.queued",
  preparing: "assistant.phase.preparing",
  planning: "assistant.phase.planning",
  paused: "assistant.phase.paused",
  awaiting_author: "assistant.phase.awaitingAuthor",
  completed: "assistant.phase.completed",
  cancelled: "assistant.phase.cancelled",
  failed: "assistant.phase.failed",
  chapter: "assistant.phase.chapter",
  "assistant.context": "assistant.phase.assistantContext",
  "assistant.respond": "assistant.phase.assistantRespond",
  "assistant.stage": "assistant.phase.assistantStage",
  "canon.context": "assistant.phase.canonContext",
  "canon.candidate": "assistant.phase.canonCandidate",
  "canon.stage": "assistant.phase.canonStage",
  "foundation.generate": "assistant.phase.foundationGenerate",
  "outline.generate": "assistant.phase.outlineGenerate",
  "outline.entities": "labels.runStepKind.outlineEntities",
  foundation: "assistant.phase.foundation",
  outline: "assistant.phase.outline",
  writing: "assistant.phase.writing",
  done: "assistant.phase.done",
  paused_baseline: "assistant.phase.pausedBaseline",
  "context.compile": "assistant.phase.contextCompile",
  "scene.plan": "assistant.phase.scenePlan",
  "draft.generate": "assistant.phase.draftGenerate",
  "deterministic.check": "assistant.phase.deterministicCheck",
  "semantic.review": "assistant.phase.semanticReview",
  "revision.generate": "assistant.phase.revisionGenerate",
  "chapter.settle": "assistant.phase.chapterSettle",
  "chapter.commit": "assistant.phase.chapterCommit",
};

export function phaseLabel(phaseKey: string): string {
  const key = PHASE_LABEL_KEYS[phaseKey];
  return key ? translate(getLocale(), key) : phaseKey;
}

const TOOL_CALL_LABEL_KEYS: Record<string, MessageKey> = {
  "story.inspect": "assistant.toolCall.storyInspect",
  "review.inspect": "assistant.toolCall.reviewInspect",
  "foundation.start": "assistant.toolCall.foundationStart",
  "chapter.start": "assistant.toolCall.chapterStart",
  "autopilot.start": "assistant.toolCall.autopilotStart",
  "outline.plan.start": "assistant.toolCall.outlinePlanStart",
  "canon.candidate.start": "assistant.toolCall.canonCandidateStart",
  "selection.edit.start": "assistant.toolCall.selectionEditStart",
  "long_goal.start": "assistant.toolCall.longGoalStart",
  "task.control": "assistant.toolCall.taskControl",
};

export function toolCallLabel(toolCall: NonNullable<AssistantActivityDto["toolCall"]>) {
  const key = TOOL_CALL_LABEL_KEYS[toolCall.name];
  return key ? translate(getLocale(), key) : toolCall.name;
}

export function artifactHref(
  projectId: string,
  artifact: AssistantActivityDto["artifacts"][number],
): string {
  if (artifact.kind === "canon_change_set") {
    return `${projectWorkspacePath(projectId, "bible")}?focus=${encodeURIComponent(artifact.id)}`;
  }
  if (
    artifact.kind === "edit_proposal" ||
    artifact.kind === "document_version" ||
    artifact.kind === "revision_proposal"
  ) {
    return `${projectWorkspacePath(projectId, "studio")}?focus=${encodeURIComponent(artifact.id)}`;
  }
  if (artifact.kind === "foundation_candidate_set") {
    return projectWorkspacePath(projectId, "overview");
  }
  return projectWorkspacePath(projectId, "runs");
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function timelineEntries(
  detail: AssistantConversationDetailDto | undefined,
): TimelineEntry[] {
  if (!detail) return [];
  const completedReplies = new Set(
    detail.messages.flatMap((message) =>
      message.role === "assistant" && message.sourceRunId
        ? [message.sourceRunId]
        : [],
    ),
  );
  const entries: TimelineEntry[] = [
    ...detail.messages.map(
      (message): TimelineEntry => ({
        type: "message",
        at: message.createdAt,
        id: message.id,
        message,
      }),
    ),
    ...detail.activities
      .filter(
        (activity) =>
          activity.kind !== "assistant_response" ||
          activity.status !== "completed" ||
          !completedReplies.has(activity.sourceId),
      )
      .map(
        (activity): TimelineEntry => ({
          type: "activity",
          at: activity.createdAt,
          id: activity.id,
          activity,
        }),
      ),
  ];
  return entries
    .sort(
      (left, right) =>
        left.at.localeCompare(right.at) ||
        Number(left.type === "activity") - Number(right.type === "activity") ||
        left.id.localeCompare(right.id),
    )
    .slice(-60);
}

export function hasLiveActivity(detail: AssistantConversationDetailDto | undefined) {
  return Boolean(
    detail?.activities.some((activity) =>
      ["queued", "running"].includes(activity.status),
    ),
  );
}

export function activityActionId(activity: AssistantActivityDto): string | null {
  return activity.kind === "tool" && activity.sourceType === "assistant_tool"
    ? activity.sourceId
    : null;
}

/* 产品决策动作出现在哪，任务现场就在哪：这类 run 卡回写作台处理候选，
   与 taskHref「现场由产品来源推导」同一套取向；没有决策动作的才退回运行中心。 */
const PRODUCT_DECISION_ACTIONS = new Set([
  "accept_plan",
  "accept_manuscript",
  "keep_manuscript",
  "request_revision",
  "discard_manuscript",
]);

export function activityHref(
  projectId: string,
  activity: AssistantActivityDto,
): string | null {
  if (activity.sourceType === "run") {
    if (
      activity.availableActions.some((action) =>
        PRODUCT_DECISION_ACTIONS.has(action),
      )
    ) {
      const params = new URLSearchParams({ run: activity.sourceId });
      const origin = activity.origin;
      if (origin?.documentId) params.set("document", origin.documentId);
      else if (origin?.outlineNodeId)
        params.set("outline", origin.outlineNodeId);
      return `${projectWorkspacePath(projectId, "studio")}?${params.toString()}`;
    }
    return `${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(activity.sourceId)}`;
  }
  if (activity.sourceType === "autopilot") {
    return `${projectWorkspacePath(projectId, "autopilot")}?session=${encodeURIComponent(activity.sourceId)}`;
  }
  return null;
}

export function activityKindLabel(kind: AssistantActivityDto["kind"]): string {
  if (kind === "tool") return translate(getLocale(), "assistant.activity.kind.tool");
  if (kind === "long_goal")
    return translate(getLocale(), "assistant.activity.kind.longGoal");
  if (kind === "assistant_response")
    return translate(getLocale(), "assistant.activity.kind.assistantResponse");
  return translate(getLocale(), "assistant.activity.kind.task");
}

export function contextDetails(context: AssistantContext): string[] {
  const details: string[] = [];
  if (context.canonSpread) details.push(canonSpreadLabel(context.canonSpread));
  if (context.outlineNodeId)
    details.push(translate(getLocale(), "assistant.context.outlineNode"));
  if (context.documentId)
    details.push(translate(getLocale(), "assistant.context.document"));
  if (context.selection && context.selection.end > context.selection.start) {
    details.push(
      translate(getLocale(), "assistant.context.selection", {
        count: context.selection.end - context.selection.start,
      }),
    );
  }
  return details;
}

const SURFACE_LABEL_KEYS: Record<string, MessageKey> = {
  overview: "assistant.surface.overview",
  bible: "assistant.surface.bible",
  studio: "assistant.surface.studio",
  autopilot: "assistant.surface.autopilot",
  runs: "assistant.surface.runs",
  lab: "assistant.surface.lab",
  delivery: "assistant.surface.delivery",
};

export function surfaceLabel(surface: string): string {
  return translate(
    getLocale(),
    SURFACE_LABEL_KEYS[surface] ?? "assistant.surface.global",
  );
}

const CANON_SPREAD_LABEL_KEYS: Record<
  NonNullable<AssistantContext["canonSpread"]>,
  MessageKey
> = {
  intent: "assistant.canonSpread.intent",
  outline: "assistant.canonSpread.outline",
  entities: "assistant.canonSpread.entities",
  facts: "assistant.canonSpread.facts",
  relations: "assistant.canonSpread.relations",
  timeline: "assistant.canonSpread.timeline",
  foreshadows: "assistant.canonSpread.foreshadows",
};

function canonSpreadLabel(spread: NonNullable<AssistantContext["canonSpread"]>) {
  return translate(getLocale(), CANON_SPREAD_LABEL_KEYS[spread]);
}

export function rememberedConversation(projectId: string): string | null {
  try {
    return window.localStorage.getItem(`${CONVERSATION_KEY_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

export function selectConversation(
  projectId: string,
  conversationId: string | null,
  setConversationId: (value: string | null) => void,
): void {
  setConversationId(conversationId);
  try {
    const key = `${CONVERSATION_KEY_PREFIX}${projectId}`;
    if (conversationId) window.localStorage.setItem(key, conversationId);
    else window.localStorage.removeItem(key);
  } catch {
    /* 私密模式下只保持当前会话状态 */
  }
}

export function createRequestId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function invalidateAssistant(
  queryClient: QueryClient,
  projectId: string,
  conversationId: string | null,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ["assistant", projectId, "conversations"],
    }),
    conversationId
      ? queryClient.invalidateQueries({
          queryKey: [
            "assistant",
            projectId,
            "conversation",
            conversationId,
          ],
        })
      : Promise.resolve(),
  ]);
}

export async function invalidateAssistantDetail(
  queryClient: QueryClient,
  projectId: string,
  conversationId: string | null,
): Promise<void> {
  if (!conversationId) return;
  await queryClient.invalidateQueries({
    queryKey: ["assistant", projectId, "conversation", conversationId],
  });
}

export function assistantRunIds(
  detail: AssistantConversationDetailDto | undefined,
): ReadonlySet<string> {
  const runIds = new Set<string>();
  for (const message of detail?.messages ?? []) {
    if (message.sourceRunId) runIds.add(message.sourceRunId);
  }
  for (const activity of detail?.activities ?? []) {
    if (activity.sourceType === "run") runIds.add(activity.sourceId);
    const currentRunId = activity.result?.currentRunId;
    if (typeof currentRunId === "string") runIds.add(currentRunId);
  }
  return runIds;
}
