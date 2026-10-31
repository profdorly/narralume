import type {
  AutopilotSessionDetailDto,
  AutopilotSessionDto,
  ProjectCoverDto,
  ProjectLanguage,
  RunDetailDto,
  RunOrigin,
  StoryCompassDto,
  StoryDevelopmentReviewDto,
  StoryLongLineDto,
  StorySteerDto,
} from "@lapis/contracts";

export interface RetrievalHit {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  title: string;
  content: string;
  authority: "reference" | "draft" | "candidate" | "confirmed" | "locked";
  metadata: Record<string, unknown>;
  entityIds: string[];
  createdAt: string;
  updatedAt: string;
  lexicalRank: number | null;
  vectorRank: number | null;
  entityScore: number;
  vectorScore: number;
  rerankScore: number | null;
  score: number;
  reasons: ("fts" | "entity" | "vector" | "rerank")[];
}

export interface NarrativeMemory {
  id: string;
  projectId: string;
  layer: "working" | "episodic" | "semantic";
  scopeType: string;
  scopeId: string;
  title: string;
  content: string;
  stateDelta: Record<string, unknown>;
  sourceHash: string;
  status: "active" | "stale" | "retired";
  refreshedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlotPrediction {
  id: string;
  projectId: string;
  title: string;
  horizon: number;
  summary: string;
  impact: string[];
  risks: string[];
  uncertainty: number;
  contextFingerprint: string;
  status: "candidate" | "adopted" | "dismissed";
  stale: boolean;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DryRunResult {
  fingerprint: string;
  safeToProceed: boolean;
  findings: {
    kind: "entity" | "fact" | "timeline" | "foreshadow" | "outline";
    sourceId: string;
    label: string;
    impact: string;
    severity: "info" | "warning";
  }[];
}

export interface WritingSkillValidation {
  valid: boolean;
  applicable: boolean;
  scope: WritingSkillScope;
  checks: { id: string; passed: boolean; message: string }[];
}

export interface HarnessTemplate {
  id: string;
  kind: "prompt" | "recipe";
  key: string;
  name: string;
  description: string;
  systemInvariants: string;
  defaultContent: string;
  overrideContent: string | null;
  effectiveContent: string;
  clonedFromKey: string | null;
  version: number;
  updatedAt: string;
}

export interface Project {
  id: string;
  title: string;
  subtitle: string | null;
  premise: string | null;
  language: ProjectLanguage;
  form?: "short-story" | "novella" | "novel";
  phase:
    | "idea"
    | "foundation"
    | "outlining"
    | "writing"
    | "revising"
    | "complete";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastWritingAt?: string | null;
  wordCount?: number;
  committedChapters?: number;
  totalChapters?: number;
  cover?: ProjectCoverDto | null;
}

export interface RecycledProject extends Project {
  deletedAt: string;
  deletionToken: string;
  deleteAfter: string;
}

export interface AuthorIntent {
  projectId: string;
  promise: string | null;
  themes: string[];
  audience: string | null;
  tone: string | null;
  boundaries: string[];
  endingDirection: string | null;
  currentFocus: string | null;
  lockedFields: string[];
  updatedAt: string;
}

export interface OutlineNode {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: "book" | "volume" | "arc" | "chapter" | "scene" | "beat";
  path: string;
  depth: number;
  ordinal: number;
  title: string;
  summary: string | null;
  goal: string | null;
  conflict: string | null;
  outcome: string | null;
  povEntityId: string | null;
  storyTime: string | null;
  status: "planned" | "drafting" | "review" | "committed" | "abandoned";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CanonEntity {
  id: string;
  projectId: string;
  type: "character" | "location" | "organization" | "item" | "rule" | "concept";
  name: string;
  aliases: string[];
  description: string | null;
  attributes: Record<string, unknown>;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
}

export interface CanonFact {
  id: string;
  projectId: string;
  subjectId: string;
  predicate: string;
  objectEntityId: string | null;
  value: unknown;
  validFromNodeId: string | null;
  validToNodeId: string | null;
  knowledgeScope: "omniscient" | "reader" | "character" | "author_secret";
  knowledgeSubjectId: string | null;
  authority: "candidate" | "inferred" | "confirmed" | "locked";
  confidence: number;
  sourceType: string;
  sourceId: string | null;
  supersedesFactId: string | null;
  createdAt: string;
}

export interface RelationshipEvent {
  id: string;
  projectId: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  intensity: number | null;
  state: Record<string, unknown>;
  outlineNodeId: string | null;
  storyTime: string | null;
  sourceId: string | null;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  outlineNodeId: string | null;
  storyTimeStart: string | null;
  storyTimeEnd: string | null;
  sequence: number;
  participants: string[];
  causes: string[];
  visibility: "omniscient" | "reader" | "author_secret";
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Foreshadow {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: "planned" | "planted" | "developing" | "resolved" | "abandoned";
  importance: 1 | 2 | 3 | 4 | 5;
  dependencies: string[];
  evidenceNodeIds: string[];
  targetFromNodeId: string | null;
  targetToNodeId: string | null;
  resolutionNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoryBible {
  project: Project;
  intent: AuthorIntent | null;
  outline: OutlineNode[];
  entities: CanonEntity[];
  facts: CanonFact[];
  relationships: RelationshipEvent[];
  timeline: TimelineEvent[];
  foreshadows: Foreshadow[];
  occupiedOutlineNodeIds: string[];
  documents: {
    id: string;
    projectId: string;
    kind: string;
    title: string;
    currentVersionId: string | null;
    archivedAt?: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
}

export interface StyleProfile {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  rules: string[];
  examples: string[];
  negativeRules: string[];
  source: string;
  active: boolean;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type WritingSkillScope =
  | "all"
  | "chapter"
  | "cocreate"
  | "edit"
  | "review";

export interface WritingSkill {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  instructions: string;
  scopes: WritingSkillScope[];
  priority: number;
  enabled: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type ImportFormat =
  | "markdown"
  | "text"
  | "docx"
  | "html"
  | "epub"
  | "narrative-bundle";
export type ExportFormat =
  | "markdown"
  | "text"
  | "docx"
  | "epub"
  | "narrative-bundle";

export interface ImportBatch {
  id: string;
  targetProjectId: string | null;
  filename: string;
  format: ImportFormat;
  sourceHash: string;
  sourceCharacters: number;
  status: "previewed" | "analyzing" | "ready" | "applied" | "discarded";
  metadata: Record<string, unknown>;
  analysisRunId: string | null;
  appliedProjectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportBatchDetail {
  batch: ImportBatch;
  candidates: {
    id: string;
    batchId: string;
    kind:
      | "project"
      | "document"
      | "outline"
      | "intent"
      | "entity"
      | "style"
      | "skill"
      | "relationship"
      | "timeline"
      | "foreshadow"
      | "character-arc"
      | "scene-analysis";
    ordinal: number;
    title: string;
    payload: Record<string, unknown>;
    status: "pending" | "selected" | "discarded" | "applied";
    createdAt: string;
    updatedAt: string;
  }[];
}

export type { BundleCounts } from "@lapis/contracts";

export interface ProjectBackup {
  id: string;
  projectId: string;
  label: string;
  bundleHash: string;
  sizeBytes: number;
  createdAt: string;
  restoredProjectId: string | null;
  counts?: Record<string, number> | null;
}

export interface ImportUploadSession {
  id: string;
  batchId: string | null;
  targetProjectId: string | null;
  filename: string;
  format: ImportFormat;
  totalBytes: number;
  chunkSize: number;
  expectedHash: string | null;
  receivedBytes: number;
  receivedChunks: number;
  status: "uploading" | "completed" | "expired" | "discarded";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SystemBackupManifest {
  id: string;
  label: string;
  databaseFile: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  migration: number;
  pageCount: number;
  projectCount: number;
}

export interface SystemBackupPreview {
  manifest: SystemBackupManifest;
  valid: boolean;
  hashMatches: boolean;
  integrityCheck: string;
  foreignKeyViolations: number;
  counts: {
    projects: number;
    documents: number;
    versions: number;
    canonFacts: number;
    runs: number;
  };
}

export interface ProjectQualityReport {
  projectId: string;
  score: number;
  readiness: "blocked" | "needs_attention" | "ready";
  gates: {
    id: string;
    label: string;
    passed: boolean;
    message: string;
    targetType: string | null;
    targetId: string | null;
  }[];
  generatedAt: string;
  metrics: Record<string, number>;
  issues: {
    id: string;
    category: "structure" | "manuscript" | "canon" | "continuity" | "workflow";
    severity: "info" | "warning" | "error";
    message: string;
    targetType: string | null;
    targetId: string | null;
    suggestion: string;
  }[];
}

export interface ContextPreview {
  text: string;
  sections: {
    id: string;
    kind: string;
    label: string;
    content: string;
    authority: string;
    tokenEstimate: number;
    compressed: boolean;
  }[];
  receipt: {
    id: string;
    purpose: string;
    compiledHash: string;
    budget: { available: number; used: number; remaining: number };
    entries: {
      sourceId: string;
      label: string;
      status: "included" | "compressed" | "excluded";
      originalTokens: number;
      finalTokens: number;
      reason: string;
    }[];
  };
}

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "awaiting_user"
  | "failed_recoverable"
  | "failed"
  | "cancelled"
  | "completed";

export type RunStepKind =
  | "context.compile"
  | "scene.plan"
  | "draft.generate"
  | "deterministic.check"
  | "semantic.review"
  | "revision.generate"
  | "chapter.settle"
  | "chapter.commit"
  | "foundation.generate"
  | "foundation.stage"
  | "outline.generate"
  | "outline.entities"
  | "outline.commit"
  | "steer.classify"
  | "arc.review"
  | "volume.review"
  | "cocreate.context"
  | "cocreate.respond"
  | "cocreate.stage"
  | "adoption.prepare"
  | "adoption.settle"
  | "adoption.commit"
  | "edit.transform"
  | "edit.stage"
  | "import.analyze"
  | "import.stage"
  | "assistant.context"
  | "assistant.respond"
  | "assistant.stage"
  | "canon.context"
  | "canon.candidate"
  | "canon.stage";

export interface NarrativeRun {
  id: string;
  projectId: string;
  recipe: string;
  recipeVersion: number;
  mode: "autopilot" | "chapter-gate" | "director" | "co-create" | "manual";
  status: RunStatus;
  targetOutlineNodeId: string | null;
  policy: Record<string, unknown>;
  budgetUsage: RunBudgetUsage;
  revisionCycle: number;
  pauseRequested: boolean;
  cancelRequested: boolean;
  currentStepId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface RunBudgetUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
  wallTimeMs: number;
}

export interface NarrativeRunStep {
  id: string;
  runId: string;
  ordinal: number;
  kind: RunStepKind;
  cycle: number;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled";
  outputArtifact: Record<string, unknown> | null;
  outputHash: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunSnapshot {
  run: NarrativeRun;
  steps: NarrativeRunStep[];
  events: {
    id: number;
    sequence: number;
    stepId: string | null;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }[];
  latestCheckpoint: {
    kind: string;
    stateHash: string;
    createdAt: string;
  } | null;
}

/** B1 运行详情：在快照之外带 effectivePolicy / contextReceipts /
 *  modelSnapshots / llmCalls / reviews / streams，直接复用合约 DTO。 */
export type RunDetail = RunDetailDto;

export type ReviewIssueStatus = "open" | "accepted" | "rejected" | "resolved";
export type ReviewIssueDecisionAction =
  | "accept"
  | "reject"
  | "false_positive"
  | "intentional_keep";

export interface ReviewWorkspaceIssue {
  id: string;
  category: string;
  severity: "info" | "minor" | "major" | "critical";
  message: string;
  evidence: { quote: string; start?: number; end?: number }[];
  suggestedDirection: string | null;
  requiresAuthorDecision: boolean;
  status: ReviewIssueStatus;
  decision: {
    action: ReviewIssueDecisionAction;
    note: string | null;
    decidedAt: string;
  } | null;
}

export interface ReviewWorkspaceReport {
  id: string;
  projectId: string;
  runId: string;
  stepId: string;
  documentVersionId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  verdict: "pass" | "revise" | "block";
  summary: string;
  scores: Record<string, number>;
  reviewedContent: string | null;
  reviewedContentHash: string | null;
  issues: ReviewWorkspaceIssue[];
  createdAt: string;
}

export interface ReviewRevisionProposal {
  id: string;
  runId: string;
  stepId: string;
  documentId: string | null;
  baseDocumentVersionId: string | null;
  baseContent: string | null;
  revisedContent: string;
  diff: Record<string, unknown>;
  addressedIssueIds: string[];
  status: "proposed" | "accepted" | "rejected" | "superseded";
  createdAt: string;
  decidedAt: string | null;
}

export interface ReviewWorkspace {
  reports: ReviewWorkspaceReport[];
  proposals: ReviewRevisionProposal[];
}

export type StoryCompass = StoryCompassDto;
export type StoryLongLine = StoryLongLineDto;
export type StoryDevelopmentReview = StoryDevelopmentReviewDto;

export interface FoundationCandidate {
  id: string;
  setId: string;
  projectId: string;
  kind: "intent" | "compass" | "entity";
  label: string;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  status: "pending" | "adopted" | "discarded";
  adoptedRefType: string | null;
  adoptedRefId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FoundationCandidateSet {
  set: {
    id: string;
    projectId: string;
    sourceRunId: string;
    title: string;
    status: "open" | "partially_adopted" | "adopted" | "discarded";
    createdAt: string;
    updatedAt: string;
  };
  candidates: FoundationCandidate[];
}

/** 自动驾驶会话 / 舵令 / 详情：直接复用合约 DTO，与后端保持同一份形状。
 *  契约里 session 同时携带 mode、approvalMode 与 origin。 */
export type AutopilotSession = AutopilotSessionDto;
export type StorySteer = StorySteerDto;
export type AutopilotSessionDetail = AutopilotSessionDetailDto;

export interface RunOriginInput {
  /** zod 契约里 documentId/selection 有 default，但从 z.infer 推导出的类型上
   *  它们是必填；请求侧允许只给 surface，故此处全部可选。 */
  surface: string;
  documentId?: string | null;
  selection?: { start: number; end: number } | null;
}

/** 后台任务的统一动作枚举（RunAvailableAction）。 */
export type RunAction =
  | "pause"
  | "resume"
  | "cancel"
  | "accept_plan"
  | "switch_to_manual"
  | "accept_manuscript"
  | "request_revision"
  | "discard_manuscript"
  | "use_partial"
  | "regenerate"
  | "retry_chapter";

/** POST /api/runs/:runId/actions 的请求体（RunActionRequest）。 */
export type RunActionRequest =
  | {
      action:
        | "pause"
        | "resume"
        | "cancel"
        | "accept_plan"
        | "switch_to_manual"
        | "accept_manuscript"
        | "discard_manuscript";
    }
  | { action: "request_revision"; requestId: string; instruction?: string }
  | { action: "retry_chapter"; requestId: string };

/** POST /api/autopilot/sessions/:sessionId/actions 的请求体（SessionActionRequest）。 */
export type SessionActionRequest =
  | {
      action: "pause" | "resume" | "cancel";
    }
  | {
      action: "accept_entities" | "accept_plan" | "accept_manuscript" | "keep_manuscript";
      requestId: string;
    }
  | { action: "request_revision"; requestId: string; instruction?: string };

/** 后台任务的产物投影（RunProductResult）。不参与内部 Step 解析。 */
export interface RunProductResult {
  planCandidate: Record<string, unknown> | null;
  manuscriptCandidate: Record<string, unknown> | null;
  reviewSummary: Record<string, unknown> | null;
  settlementCandidate: Record<string, unknown> | null;
  canonChangeSetId: string | null;
  foundationCandidateSetId: string | null;
  canonCandidateSetId: string | null;
  editProposalId: string | null;
  cocreateTurnId: string | null;
  cocreateSwipeId: string | null;
  sceneAdoptionId: string | null;
  documentId: string | null;
  documentVersionId: string | null;
  importBatchId: string | null;
  partialRecovery: {
    stepId: string;
    attempt: number;
    characters: number;
    canAdopt: boolean;
  } | null;
}

/** 202 接收的后台任务：运行快照 + 产物投影 + 当前可执行动作（BackgroundRunCreated）。 */
export interface BackgroundRunCreated extends RunSnapshot {
  origin: RunOrigin | null;
  result: RunProductResult;
  availableActions: RunAction[];
}

export interface ProjectOverviewChapter {
  outlineNodeId: string;
  title: string;
  status: "planned" | "drafting" | "review" | "committed" | "abandoned";
  documentId: string | null;
  documentVersionId: string | null;
}

/** 项目概览的主创作任务（快速创作 / 单章 / AI 建书）。 */
export interface ProjectOverviewActiveTask {
  kind: "quick_creation" | "chapter" | "foundation";
  id: string;
  status: string;
  targetChapter: ProjectOverviewChapter | null;
  origin: Record<string, unknown> | null;
  stopReason: string | null;
  availableActions: string[];
}

export interface ProjectOverview {
  project: Project;
  progress: {
    lastWritingAt: string | null;
    wordCount: number;
    committedChapters: number;
    totalChapters: number;
  };
  currentChapter: ProjectOverviewChapter | null;
  activeTask: ProjectOverviewActiveTask | null;
  pending: {
    foundationCandidates: number;
    reviewIssues: number;
    revisionProposals: number;
    canonChangeSets: number;
    reviewDocumentId: string | null;
  };
  nextAction: {
    kind:
      | "continue_task"
      | "review_foundation"
      | "resolve_story_changes"
      | "review_writing"
      | "write_chapter"
      | "build_outline"
      | "complete";
    targetId: string | null;
  };
}

export interface ProjectFoundationTaskCreated {
  project: Project;
  task: BackgroundRunCreated;
  idempotentReplay: boolean;
}

export interface StoryDocument {
  id: string;
  projectId: string;
  kind:
    | "manuscript"
    | "chapter"
    | "scene"
    | "outline"
    | "synopsis"
    | "note"
    | "style-sample";
  title: string;
  outlineNodeId: string | null;
  currentVersionId: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  parentVersionId: string | null;
  content: string;
  contentHash: string;
  source: string;
  runId: string | null;
  createdAt: string;
}

export interface DocumentComment {
  id: string;
  projectId: string;
  documentId: string;
  versionId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  body: string;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
}

export interface EditProposal {
  id: string;
  projectId: string;
  documentId: string;
  baseVersionId: string;
  runId: string;
  instruction: string;
  selectionStart: number;
  selectionEnd: number;
  originalText: string;
  replacementText: string;
  proposedContent: string;
  diff: Record<string, unknown>;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  acceptedVersionId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface StudioDocumentDetail {
  document: StoryDocument;
  currentVersion: DocumentVersion | null;
  draft: DocumentDraft | null;
  versions: DocumentVersion[];
  comments: DocumentComment[];
  proposals: EditProposal[];
}

export interface DocumentDraft {
  projectId: string;
  documentId: string;
  baseVersionId: string | null;
  content: string;
  contentHash: string;
  updatedAt: string;
}

