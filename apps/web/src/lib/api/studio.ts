import type {
  DocumentReviewRunCreatedDto,
  ModelExecutionPolicy,
} from "@lapis/contracts";

import { jsonRequest, requestBlob, requestJson, requestVoid } from "./transport";
import type {
  BackgroundRunCreated,
  DocumentComment,
  DocumentDraft,
  DocumentVersion,
  DryRunResult,
  EditProposal,
  HarnessTemplate,
  ReviewIssueDecisionAction,
  ReviewIssueStatus,
  ReviewRevisionProposal,
  ReviewWorkspace,
  RunOriginInput,
  RunSnapshot,
  StoryDocument,
  StudioDocumentDetail,
  StyleProfile,
  WritingSkill,
  WritingSkillScope,
  WritingSkillValidation,
} from "./types";

export async function getReviewWorkspace(
  projectId: string,
  signal?: AbortSignal,
): Promise<ReviewWorkspace> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/reviews`,
    signal ? { signal } : {},
  );
}

export async function createDocumentReview(
  projectId: string,
  documentId: string,
  input: {
    requestId: string;
    documentVersionId: string;
    origin?: RunOriginInput | null;
    policy?: ModelExecutionPolicy;
  },
): Promise<DocumentReviewRunCreatedDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/reviews`,
    jsonRequest("POST", input),
  );
}

export async function decideReviewIssue(
  projectId: string,
  issueId: string,
  input: {
    action: ReviewIssueDecisionAction;
    note: string | null;
    expectedStatus: ReviewIssueStatus;
  },
): Promise<{
  id: string;
  issueId: string;
  action: ReviewIssueDecisionAction;
  note: string | null;
  priorStatus: ReviewIssueStatus;
  resultingStatus: ReviewIssueStatus;
  createdAt: string;
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/review-issues/${encodeURIComponent(issueId)}/decisions`,
    jsonRequest("POST", {
      ...input,
      requestId: `${issueId}:${input.action}`,
    }),
  );
}

/** 修订提案裁定：apply 把 revisedContent 落成文档新版本，reject 仅记决策。 */
export async function decideRevisionProposal(
  projectId: string,
  proposalId: string,
  action: "apply" | "reject",
): Promise<{ proposal: ReviewRevisionProposal }> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/revision-proposals/${encodeURIComponent(proposalId)}/decisions`,
    jsonRequest("POST", {
      action,
      requestId: `${proposalId}:${action}`,
    }),
  );
}

export interface CanonChangeSetView {
  id: string;
  projectId: string;
  runId: string;
  stepId: string;
  changes: Record<string, unknown>;
  status: "candidate" | "partially_applied" | "applied" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

export async function getCanonChangeSets(
  projectId: string,
  signal?: AbortSignal,
): Promise<CanonChangeSetView[]> {
  const response = (await requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-change-sets`,
    signal ? { signal } : {},
  )) as { changeSets: CanonChangeSetView[] };
  return response.changeSets;
}

/** 故事变化裁定：整组 apply（可显式 force）或整组 reject。 */
export async function decideCanonChangeSet(
  projectId: string,
  changeSetId: string,
  input: {
    action: "apply" | "reject";
    expectedStatus?: "candidate";
    conflictPolicy?: "reject" | "force";
  },
): Promise<{ changeSet: CanonChangeSetView }> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-change-sets/${encodeURIComponent(changeSetId)}/decisions`,
    jsonRequest("POST", {
      ...input,
      requestId: `${changeSetId}:${input.action}:${input.conflictPolicy ?? "reject"}`,
    }),
  );
}

export async function getStudioDocuments(
  projectId: string,
  signal?: AbortSignal,
  includeArchived = false,
): Promise<StoryDocument[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents${includeArchived ? "?includeArchived=true" : ""}`,
    signal ? { signal } : {},
  );
}

export async function setStoryDocumentArchived(
  document: StoryDocument,
  archived: boolean,
): Promise<StoryDocument> {
  return requestJson(
    `/api/projects/${encodeURIComponent(document.projectId)}/studio/documents/${encodeURIComponent(document.id)}/archive`,
    jsonRequest("PUT", {
      archived,
      expectedUpdatedAt: document.updatedAt,
    }),
  );
}

export async function createStoryDocument(
  projectId: string,
  input: {
    requestId: string;
    kind: StoryDocument["kind"];
    title: string;
    outlineNodeId: string | null;
  },
): Promise<StoryDocument> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents`,
    jsonRequest("POST", input),
  );
}

export async function getStudioDocument(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<StudioDocumentDetail> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents/${encodeURIComponent(documentId)}`,
    signal ? { signal } : {},
  );
}

export async function appendDocumentVersion(
  projectId: string,
  documentId: string,
  input: {
    content: string;
    source: string;
    expectedCurrentVersionId: string | null;
  },
): Promise<DocumentVersion> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/versions`,
    jsonRequest("POST", input),
  );
}

export async function saveDocumentDraft(
  projectId: string,
  documentId: string,
  input: {
    content: string;
    baseVersionId: string | null;
    expectedDraftUpdatedAt: string | null;
  },
): Promise<DocumentDraft | null> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents/${encodeURIComponent(documentId)}/draft`,
    jsonRequest("PUT", input),
  );
}

export async function restoreDocumentVersion(
  projectId: string,
  documentId: string,
  targetVersionId: string,
  expectedCurrentVersionId: string | null,
): Promise<DocumentVersion> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/restore`,
    jsonRequest("POST", { targetVersionId, expectedCurrentVersionId }),
  );
}

export async function createDocumentComment(
  projectId: string,
  documentId: string,
  input: {
    versionId: string;
    startOffset: number;
    endOffset: number;
    quote: string;
    body: string;
  },
): Promise<DocumentComment> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents/${encodeURIComponent(documentId)}/comments`,
    jsonRequest("POST", input),
  );
}

export async function setDocumentCommentStatus(
  commentId: string,
  status: DocumentComment["status"],
): Promise<DocumentComment> {
  return requestJson(
    `/api/studio/comments/${encodeURIComponent(commentId)}`,
    jsonRequest("PUT", { status }),
  );
}

export async function createSelectionEdit(
  projectId: string,
  documentId: string,
  input: {
    baseVersionId: string;
    draftContentHash: string | null;
    selectionStart: number;
    selectionEnd: number;
    instruction: string;
    /** 稀疏覆盖；模型由服务端 assignment 解析。 */
    policy?: ModelExecutionPolicy;
  },
): Promise<RunSnapshot> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents/${encodeURIComponent(documentId)}/selection-edits`,
    jsonRequest("POST", input),
  );
}

export async function decideEditProposal(
  proposalId: string,
  action: "accept" | "reject",
): Promise<EditProposal> {
  return requestJson(
    `/api/studio/edit-proposals/${encodeURIComponent(proposalId)}/actions`,
    jsonRequest("POST", {
      action,
      requestId: `${proposalId}:${action}`,
    }),
  );
}

/* ==========================================================================
   风格 / 写作 Skill
   ========================================================================== */

export async function getStyleProfiles(
  projectId: string,
  signal?: AbortSignal,
): Promise<StyleProfile[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/styles`,
    signal ? { signal } : {},
  );
}

export async function createStyleProfile(
  projectId: string,
  input: Pick<
    StyleProfile,
    "name" | "description" | "rules" | "examples" | "negativeRules" | "active"
  >,
): Promise<StyleProfile> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/styles`,
    jsonRequest("POST", input),
  );
}

export async function updateStyleProfile(
  profile: StyleProfile,
  patch: Partial<
    Pick<
      StyleProfile,
      | "name"
      | "description"
      | "rules"
      | "examples"
      | "negativeRules"
      | "active"
      | "status"
    >
  >,
): Promise<StyleProfile> {
  const next = { ...profile, ...patch };
  return requestJson(
    `/api/styles/${encodeURIComponent(profile.id)}`,
    jsonRequest("PUT", {
      name: next.name,
      description: next.description,
      rules: next.rules,
      examples: next.examples,
      negativeRules: next.negativeRules,
      active: next.active,
      status: next.status,
      expectedVersion: profile.version,
    }),
  );
}

/** 贴样文提炼风格档案：202 返回后台 run，完成后新增一条
 *  source=extract:{runId} 的未启用草稿，轮询 run 状态后刷新 styles 列表。 */
export async function extractStyleProfile(
  projectId: string,
  input: { requestId: string; text: string },
): Promise<BackgroundRunCreated> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/styles/extract`,
    jsonRequest("POST", input),
  );
}

export async function getWritingSkills(
  projectId: string,
  signal?: AbortSignal,
): Promise<WritingSkill[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/writing-skills`,
    signal ? { signal } : {},
  );
}

export async function createWritingSkill(
  projectId: string,
  input: Pick<
    WritingSkill,
    "name" | "description" | "instructions" | "scopes" | "priority" | "enabled"
  >,
): Promise<WritingSkill> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/writing-skills`,
    jsonRequest("POST", input),
  );
}

export async function updateWritingSkill(
  skill: WritingSkill,
  patch: Partial<
    Pick<
      WritingSkill,
      | "name"
      | "description"
      | "instructions"
      | "scopes"
      | "priority"
      | "enabled"
    >
  >,
): Promise<WritingSkill> {
  const next = { ...skill, ...patch };
  return requestJson(
    `/api/writing-skills/${encodeURIComponent(skill.id)}`,
    jsonRequest("PUT", {
      name: next.name,
      description: next.description,
      instructions: next.instructions,
      scopes: next.scopes,
      priority: next.priority,
      enabled: next.enabled,
      expectedVersion: skill.version,
    }),
  );
}

export async function deleteWritingSkill(skillId: string): Promise<void> {
  return requestVoid(
    `/api/writing-skills/${encodeURIComponent(skillId)}`,
    jsonRequest("DELETE", {}),
  );
}

export async function importWritingSkillPackage(
  projectId: string,
  input: { filename: string; contentBase64: string },
): Promise<{
  skill: WritingSkill;
  references: {
    id: string;
    skillId: string;
    path: string;
    content: string;
    contentHash: string;
    createdAt: string;
  }[];
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/writing-skills/import`,
    jsonRequest("POST", input),
  );
}

export async function validateWritingSkill(
  skillId: string,
  scope: WritingSkillScope,
): Promise<WritingSkillValidation> {
  return requestJson(
    `/api/writing-skills/${encodeURIComponent(skillId)}/validate`,
    jsonRequest("POST", { scope }),
  );
}

export async function getWritingSkillPackage(
  skillId: string,
): Promise<{ blob: Blob; filename: string }> {
  const { blob, filename } = await requestBlob(
    `/api/writing-skills/${encodeURIComponent(skillId)}/package`,
  );
  return { blob, filename: filename ?? "writing-skill.skill.zip" };
}

export async function previewDryRun(
  projectId: string,
  change: string,
): Promise<DryRunResult> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/dry-run`,
    jsonRequest("POST", { change }),
  );
}

/* ==========================================================================
   Prompt / Recipe 工坊
   ========================================================================== */

export async function getHarnessTemplates(
  signal?: AbortSignal,
): Promise<HarnessTemplate[]> {
  return requestJson("/api/harness/templates", signal ? { signal } : {});
}

export async function updateHarnessTemplate(
  template: HarnessTemplate,
  content: string,
): Promise<HarnessTemplate> {
  return requestJson(
    `/api/harness/templates/${encodeURIComponent(template.key)}`,
    jsonRequest("PUT", { content, expectedVersion: template.version }),
  );
}

export async function restoreHarnessTemplate(
  template: HarnessTemplate,
): Promise<HarnessTemplate> {
  return requestJson(
    `/api/harness/templates/${encodeURIComponent(template.key)}/restore`,
    jsonRequest("POST", { expectedVersion: template.version }),
  );
}

