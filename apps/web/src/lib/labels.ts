import type {
  AssignmentRole,
  AutopilotSessionDetail,
  CanonEntity,
  CanonFact,
  ExportFormat,
  FoundationCandidate,
  Foreshadow,
  ModelConfigDto,
  OutlineNode,
  Project,
  ReviewIssueDecisionAction,
  ReviewWorkspaceIssue,
  ReviewWorkspaceReport,
  AssistantActivityTextDto,
  StoryDocument,
  WireApi,
} from "./api";
import { getLocale, translate, type MessageKey } from "../i18n";

/* ==========================================================================
   Central label table: display names for status / step / role / mode,
   deduplicated from the old views. The text has been extracted to the labels
   module of the i18n dictionary; this file only maps keys to the dictionary.
   ========================================================================== */

/* --- Runs ------------------------------------------------------------ */

/** Short run status for lists (no recipe context). */
export function runStatusShortLabel(status: string): string {
  const keys: Record<string, MessageKey> = {
    pending: "labels.runStatusShort.pending",
    running: "labels.runStatusShort.running",
    paused: "labels.runStatusShort.paused",
    awaiting_user: "labels.runStatusShort.awaitingUser",
    failed_recoverable: "labels.runStatusShort.failedRecoverable",
    failed: "labels.runStatusShort.failed",
    cancelled: "labels.runStatusShort.cancelled",
    completed: "labels.runStatusShort.completed",
  };
  const key: MessageKey | undefined = keys[status];
  return key ? translate(getLocale(), key) : status;
}

/* --- Model supply: Provider / Model / Assignment ------------------------- */

export function wireApiLabel(wireApi: WireApi): string {
  const keys: Record<WireApi, MessageKey> = {
    "openai-chat": "labels.wireApi.openaiChat",
    "openai-responses": "labels.wireApi.openaiResponses",
    "anthropic-messages": "labels.wireApi.anthropicMessages",
  };
  return translate(getLocale(), keys[wireApi]);
}

export function assignmentRoleLabel(role: AssignmentRole): string {
  const keys: Record<AssignmentRole, MessageKey> = {
    writing: "labels.assignmentRole.writing",
    planning: "labels.assignmentRole.planning",
    review: "labels.assignmentRole.review",
    embedding: "labels.assignmentRole.embedding",
    rerank: "labels.assignmentRole.rerank",
  };
  return translate(getLocale(), keys[role]);
}

export function metadataSourceLabel(
  source: ModelConfigDto["metadataSource"],
): string {
  const keys: Record<ModelConfigDto["metadataSource"], MessageKey> = {
    manual: "labels.metadataSource.manual",
    environment: "labels.metadataSource.environment",
    catalog: "labels.metadataSource.catalog",
    migration: "labels.metadataSource.migration",
  };
  return translate(getLocale(), keys[source]);
}

export function probeStageLabel(
  stage:
    | "text"
    | "stream"
    | "tool"
    | "structured-output"
    | "embedding"
    | "decision",
): string {
  const keys: Record<typeof stage, MessageKey> = {
    text: "labels.probeStage.text",
    stream: "labels.probeStage.stream",
    tool: "labels.probeStage.tool",
    "structured-output": "labels.probeStage.structuredOutput",
    embedding: "labels.probeStage.embedding",
    decision: "labels.probeStage.decision",
  };
  return translate(getLocale(), keys[stage]);
}

export function probeStageStatusLabel(
  status: "passed" | "failed" | "unsupported" | "skipped",
): string {
  const keys: Record<typeof status, MessageKey> = {
    passed: "labels.probeStageStatus.passed",
    failed: "labels.probeStageStatus.failed",
    unsupported: "labels.probeStageStatus.unsupported",
    skipped: "labels.probeStageStatus.skipped",
  };
  return translate(getLocale(), keys[status]);
}

/* --- Story bible ------------------------------------------------------- */

export function projectPhaseLabel(phase: Project["phase"]): string {
  const keys: Record<Project["phase"], MessageKey> = {
    idea: "labels.projectPhase.idea",
    foundation: "labels.projectPhase.foundation",
    outlining: "labels.projectPhase.outlining",
    writing: "labels.projectPhase.writing",
    revising: "labels.projectPhase.revising",
    complete: "labels.projectPhase.complete",
  };
  return translate(getLocale(), keys[phase]);
}

export function entityTypeLabel(type: CanonEntity["type"]): string {
  const keys: Record<CanonEntity["type"], MessageKey> = {
    character: "labels.entityType.character",
    location: "labels.entityType.location",
    organization: "labels.entityType.organization",
    item: "labels.entityType.item",
    rule: "labels.entityType.rule",
    concept: "labels.entityType.concept",
  };
  return translate(getLocale(), keys[type]);
}

export function outlineKindLabel(kind: OutlineNode["kind"]): string {
  const keys: Record<OutlineNode["kind"], MessageKey> = {
    book: "labels.outlineKind.book",
    volume: "labels.outlineKind.volume",
    arc: "labels.outlineKind.arc",
    chapter: "labels.outlineKind.chapter",
    scene: "labels.outlineKind.scene",
    beat: "labels.outlineKind.beat",
  };
  return translate(getLocale(), keys[kind]);
}

export function outlineStatusLabel(status: OutlineNode["status"]): string {
  const keys: Record<OutlineNode["status"], MessageKey> = {
    planned: "labels.outlineStatus.planned",
    drafting: "labels.outlineStatus.drafting",
    review: "labels.outlineStatus.review",
    committed: "labels.outlineStatus.committed",
    abandoned: "labels.outlineStatus.abandoned",
  };
  return translate(getLocale(), keys[status]);
}

export function factAuthorityLabel(authority: CanonFact["authority"]): string {
  const keys: Record<CanonFact["authority"], MessageKey> = {
    candidate: "labels.factAuthority.candidate",
    inferred: "labels.factAuthority.inferred",
    confirmed: "labels.factAuthority.confirmed",
    locked: "labels.factAuthority.locked",
  };
  return translate(getLocale(), keys[authority]);
}

export function foreshadowStatusLabel(status: Foreshadow["status"]): string {
  const keys: Record<Foreshadow["status"], MessageKey> = {
    planned: "labels.foreshadowStatus.planned",
    planted: "labels.foreshadowStatus.planted",
    developing: "labels.foreshadowStatus.developing",
    resolved: "labels.foreshadowStatus.resolved",
    abandoned: "labels.foreshadowStatus.abandoned",
  };
  return translate(getLocale(), keys[status]);
}

/* --- Autopilot / book-setup candidates ------------------------------------ */

export function autopilotLinkRoleLabel(
  role: AutopilotSessionDetail["links"][number]["role"],
): string {
  const keys: Record<typeof role, MessageKey> = {
    "rolling-plan": "labels.autopilotLinkRole.rollingPlan",
    chapter: "labels.autopilotLinkRole.chapter",
    "closing-review": "labels.autopilotLinkRole.closingReview",
  };
  return translate(getLocale(), keys[role]);
}

function steerClassificationLabel(
  value: NonNullable<
    AutopilotSessionDetail["steers"][number]["classification"]
  >,
): string {
  const keys: Record<typeof value, MessageKey> = {
    immediate_current: "labels.steerClassification.immediateCurrent",
    next_scene: "labels.steerClassification.nextScene",
    future_plan: "labels.steerClassification.futurePlan",
    canon_change: "labels.steerClassification.canonChange",
    rewrite_existing: "labels.steerClassification.rewriteExisting",
    temporary_director_note: "labels.steerClassification.temporaryDirectorNote",
  };
  return translate(getLocale(), keys[value]);
}

export function steerStatusLabel(
  steer: AutopilotSessionDetail["steers"][number],
): string {
  const locale = getLocale();
  if (steer.status === "awaiting_confirmation")
    return translate(locale, "labels.steerStatus.awaitingConfirmation", {
      classification: steer.classification
        ? steerClassificationLabel(steer.classification)
        : translate(locale, "labels.steerStatus.fallbackChange"),
    });
  if (steer.status === "applied")
    return translate(locale, "labels.steerStatus.applied", {
      classification: steer.classification
        ? steerClassificationLabel(steer.classification)
        : translate(locale, "labels.steerStatus.fallbackInstruction"),
    });
  if (steer.status === "rejected")
    return translate(locale, "labels.steerStatus.rejected");
  if (steer.classification) return steerClassificationLabel(steer.classification);
  if (steer.status === "classifying")
    return translate(locale, "labels.steerStatus.classifying");
  return translate(locale, "labels.steerStatus.pendingClassification");
}

export function foundationCandidateKindLabel(
  kind: FoundationCandidate["kind"],
): string {
  const keys: Record<FoundationCandidate["kind"], MessageKey> = {
    intent: "labels.foundationCandidateKind.intent",
    compass: "labels.foundationCandidateKind.compass",
    entity: "labels.foundationCandidateKind.entity",
  };
  return translate(getLocale(), keys[kind]);
}

export function foundationCandidateStatusLabel(
  status: FoundationCandidate["status"],
): string {
  const keys: Record<FoundationCandidate["status"], MessageKey> = {
    pending: "labels.foundationCandidateStatus.pending",
    adopted: "labels.foundationCandidateStatus.adopted",
    discarded: "labels.foundationCandidateStatus.discarded",
  };
  return translate(getLocale(), keys[status]);
}

/* --- Review room -------------------------------------------------------- */

export function reviewCategoryLabel(category: string): string {
  const keys: Record<string, MessageKey> = {
    continuity: "labels.reviewCategory.continuity",
    canon: "labels.reviewCategory.canon",
    pov: "labels.reviewCategory.pov",
    character: "labels.reviewCategory.character",
    agency: "labels.reviewCategory.agency",
    causality: "labels.reviewCategory.causality",
    pacing: "labels.reviewCategory.pacing",
    information: "labels.reviewCategory.information",
    prose: "labels.reviewCategory.prose",
    style: "labels.reviewCategory.style",
    foreshadow: "labels.reviewCategory.foreshadow",
    goal: "labels.reviewCategory.goal",
    safety: "labels.reviewCategory.safety",
  };
  const key: MessageKey | undefined = keys[category];
  return key ? translate(getLocale(), key) : category;
}

export function reviewIssueStatusLabel(issue: ReviewWorkspaceIssue): string {
  if (issue.decision) return reviewIssueActionLabel(issue.decision.action);
  return issue.status === "open"
    ? translate(getLocale(), "labels.reviewIssueStatus.open")
    : issue.status;
}

export function reviewIssueActionLabel(
  action: ReviewIssueDecisionAction,
): string {
  const keys: Record<ReviewIssueDecisionAction, MessageKey> = {
    accept: "labels.reviewIssueAction.accept",
    reject: "labels.reviewIssueAction.reject",
    false_positive: "labels.reviewIssueAction.falsePositive",
    intentional_keep: "labels.reviewIssueAction.intentionalKeep",
  };
  return translate(getLocale(), keys[action]);
}

export function reviewVerdictLabel(
  verdict: ReviewWorkspaceReport["verdict"],
): string {
  const keys: Record<ReviewWorkspaceReport["verdict"], MessageKey> = {
    pass: "labels.reviewVerdict.pass",
    revise: "labels.reviewVerdict.revise",
    block: "labels.reviewVerdict.block",
  };
  return translate(getLocale(), keys[verdict]);
}

/* --- Delivery / import / checkup ----------------------------------------- */

export function importCandidateKindLabel(kind: string): string {
  const keys: Record<string, MessageKey> = {
    project: "labels.importCandidateKind.project",
    document: "labels.importCandidateKind.document",
    outline: "labels.importCandidateKind.outline",
    intent: "labels.importCandidateKind.intent",
    entity: "labels.importCandidateKind.entity",
    style: "labels.importCandidateKind.style",
    skill: "labels.importCandidateKind.skill",
    relationship: "labels.importCandidateKind.relationship",
    timeline: "labels.importCandidateKind.timeline",
    foreshadow: "labels.importCandidateKind.foreshadow",
    "character-arc": "labels.importCandidateKind.characterArc",
    "scene-analysis": "labels.importCandidateKind.sceneAnalysis",
  };
  const key: MessageKey | undefined = keys[kind];
  return key ? translate(getLocale(), key) : kind;
}

export function exportFormatLabel(format: ExportFormat): string {
  const keys: Record<ExportFormat, MessageKey> = {
    markdown: "labels.exportFormat.markdown",
    text: "labels.exportFormat.text",
    docx: "labels.exportFormat.docx",
    epub: "labels.exportFormat.epub",
    "narrative-bundle": "labels.exportFormat.narrativeBundle",
  };
  return translate(getLocale(), keys[format]);
}

/* --- Writing desk -------------------------------------------------------- */

export function documentKindLabel(kind: StoryDocument["kind"]): string {
  const keys: Record<StoryDocument["kind"], MessageKey> = {
    manuscript: "labels.documentKind.manuscript",
    chapter: "labels.documentKind.chapter",
    scene: "labels.documentKind.scene",
    outline: "labels.documentKind.outline",
    synopsis: "labels.documentKind.synopsis",
    note: "labels.documentKind.note",
    "style-sample": "labels.documentKind.styleSample",
  };
  return translate(getLocale(), keys[kind]);
}

/* --- Task protocol (origin / stopReason / availableActions / nextAction)
   --------- */

/**
 * Display names of actions available on background tasks (RunAvailableAction +
 * voyage failure handling).
 */
export function taskActionLabel(action: string): string {
  const keys: Record<string, MessageKey> = {
    pause: "labels.taskAction.pause",
    resume: "labels.taskAction.resume",
    cancel: "labels.taskAction.cancel",
    accept_plan: "labels.taskAction.acceptPlan",
    accept_entities: "labels.taskAction.acceptEntities",
    switch_to_manual: "labels.taskAction.switchToManual",
    accept_manuscript: "labels.taskAction.acceptManuscript",
    keep_manuscript: "labels.taskAction.keepManuscript",
    request_revision: "labels.taskAction.requestRevision",
    discard_manuscript: "labels.taskAction.discardManuscript",
    use_partial: "labels.taskAction.usePartial",
    regenerate: "labels.taskAction.regenerate",
    retry_chapter: "labels.taskAction.retryChapter",
    "retry-current": "labels.taskAction.retryCurrent",
    "skip-chapter": "labels.taskAction.skipChapter",
    replan: "labels.taskAction.replan",
    stop: "labels.taskAction.stop",
  };
  const key: MessageKey | undefined = keys[action];
  return key ? translate(getLocale(), key) : action;
}

export function taskStatusLabel(status: string): string {
  const keys: Record<string, MessageKey> = {
    pending: "labels.taskStatus.pending",
    planning: "labels.taskStatus.planning",
    running: "labels.taskStatus.running",
    paused: "labels.taskStatus.paused",
    awaiting_user: "labels.taskStatus.awaitingUser",
    failed_recoverable: "labels.taskStatus.failedRecoverable",
    failed: "labels.taskStatus.failed",
    cancelled: "labels.taskStatus.cancelled",
    completed: "labels.taskStatus.completed",
  };
  const key: MessageKey | undefined = keys[status];
  return key ? translate(getLocale(), key) : status;
}

/** Kind names of active tasks (ProjectOverview.activeTask.kind). */
export function taskKindLabel(kind: string): string {
  const keys: Record<string, MessageKey> = {
    quick_creation: "labels.taskKind.quickCreation",
    chapter: "labels.taskKind.chapter",
    foundation: "labels.taskKind.foundation",
  };
  const key: MessageKey | undefined = keys[kind];
  return key ? translate(getLocale(), key) : kind;
}

/** The single site-wide table of waiting/stop reason texts: server projections
 *  send only machine codes, and the sidebar, overview and quick create all
 *  render from here. */
export function stopReasonLabel(reason: string): string {
  const keys: Record<string, MessageKey> = {
    chapter_commit_approval_required:
      "labels.stopReason.chapterCommitApprovalRequired",
    critical_review_unresolved: "labels.stopReason.criticalReviewUnresolved",
    quality_gate_blocked: "labels.stopReason.qualityGateBlocked",
    semantic_review_blocked: "labels.stopReason.semanticReviewBlocked",
    revision_limit_reached: "labels.stopReason.revisionLimitReached",
    scene_plan_approval_required:
      "labels.stopReason.scenePlanApprovalRequired",
    planning_entities_require_decision: "labels.stopReason.planningEntitiesRequireDecision",
    settlement_conflict_requires_resolution:
      "labels.stopReason.settlementConflictRequiresResolution",
    request_start_timeout: "labels.stopReason.requestStartTimeout",
    session_cancelled: "labels.stopReason.sessionCancelled",
    "child.fatal": "labels.stopReason.childFatal",
    awaiting_user: "labels.stopReason.awaitingUser",
    "long_goal.paused_baseline": "labels.stopReason.longGoalBaselineChanged",
  };
  const key: MessageKey | undefined = keys[reason];
  return key
    ? translate(getLocale(), key)
    : translate(getLocale(), "labels.stopReason.unknown");
}

/**
 * Suggested next step of the project overview
 * (ProjectOverview.nextAction.kind).
 */
export function nextActionKindLabel(kind: string): string {
  const keys: Record<string, MessageKey> = {
    continue_task: "labels.nextActionKind.continueTask",
    review_foundation: "labels.nextActionKind.reviewFoundation",
    resolve_story_changes: "labels.nextActionKind.resolveStoryChanges",
    review_writing: "labels.nextActionKind.reviewWriting",
    write_chapter: "labels.nextActionKind.writeChapter",
    build_outline: "labels.nextActionKind.buildOutline",
    complete: "labels.nextActionKind.complete",
  };
  const key: MessageKey | undefined = keys[kind];
  return key ? translate(getLocale(), key) : kind;
}

/* --- Assistant activity cards (AssistantActivityDto)
   ------------------------------- */

/* The server sends only machine-code descriptors; dictionary paths mirror the
   codes directly (the nested structure of labels.<key>), so no per-key mapping
   table is needed here. Unknown codes are echoed back as is, which makes
   missing entries easy to spot. */
function renderActivityMessage(message: AssistantActivityTextDto): string {
  const key = `labels.${message.key}` as MessageKey;
  const rendered = translate(getLocale(), key, message.params);
  return rendered === key ? message.key : rendered;
}

/**
 * Activity card title: machine-code descriptors are rendered from the
 * dictionary; raw strings (user-written titles) are returned as is.
 */
export function activityGoalLabel(
  goal: string | AssistantActivityTextDto,
): string {
  if (typeof goal === "string") return goal;
  return renderActivityMessage(goal);
}

/**
 * Activity card stage line: in-progress text for the run status or current
 * step.
 */
export function activityStageLabel(stage: AssistantActivityTextDto): string {
  return renderActivityMessage(stage);
}

/** Activity card summary line. */
export function activitySummaryLabel(
  summary: AssistantActivityTextDto | null,
): string | null {
  return summary ? renderActivityMessage(summary) : null;
}

/**
 * Activity card artifact name: known kinds use the dictionary; unknown ones
 * fall back to the server label.
 */
export function artifactKindLabel(kind: string, fallback: string): string {
  const keys: Record<string, MessageKey> = {
    foundation_candidate_set: "labels.artifactKind.foundationCandidateSet",
    canon_change_set: "labels.artifactKind.canonChangeSet",
    edit_proposal: "labels.artifactKind.editProposal",
    document_version: "labels.artifactKind.documentVersion",
    revision_proposal: "labels.artifactKind.revisionProposal",
    cocreate_turn: "labels.artifactKind.cocreateTurn",
    import_batch: "labels.artifactKind.importBatch",
    outline_node: "labels.artifactKind.outlineNode",
  };
  const key: MessageKey | undefined = keys[kind];
  return key ? translate(getLocale(), key) : fallback;
}

/**
 * Built-in skill name: looked up in the dictionary by skillId (the server no
 * longer sends skill display text).
 */
export function assistantSkillLabel(skillId: string): string {
  const keys: Record<string, MessageKey> = {
    "story.query": "labels.assistantSkill.storyQuery",
    "book.foundation": "labels.assistantSkill.bookFoundation",
    "chapter.write": "labels.assistantSkill.chapterWrite",
    "serial.write": "labels.assistantSkill.serialWrite",
    "compose.serial": "labels.assistantSkill.composeSerial",
    "review.run": "labels.assistantSkill.reviewRun",
    "canon.edit": "labels.assistantSkill.canonEdit",
    "selection.polish": "labels.assistantSkill.selectionPolish",
  };
  const key: MessageKey | undefined = keys[skillId];
  return key ? translate(getLocale(), key) : skillId;
}
