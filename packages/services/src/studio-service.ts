import type { ModelExecutionPolicy } from "@lapis/contracts";
import { buildSelectionEditRecipe } from "@lapis/harness";
import {
  SqliteCreativeRepository,
  SqliteDocumentRepository,
  type SqliteProjectRepository,
  SqliteManuscriptIndexer,
  SqliteRunRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

import { randomUuid } from "./internal/crypto.js";
import {
  requireWritingAssignment,
  withRuntimeModelPolicy,
} from "./run-policy.js";
import { ServiceError } from "./service-error.js";
import { startManualSettlementRun } from "./manual-settlement.js";

export class StudioServiceError extends ServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "StudioServiceError";
  }
}

/**
 * 选区 AI 改写的版本/草稿一致性检查与 run 创建。有草稿时先固化
 * checkpoint 版本再删草稿；无草稿时校验 baseVersion 仍为当前版本。
 */
export function createSelectionEditRun(
  database: NarrativeDatabase,
  input: {
    projectId: string;
    documentId: string;
    baseVersionId: string;
    draftContentHash: string | null;
    selectionStart: number;
    selectionEnd: number;
    instruction: string;
    requestPolicy?: ModelExecutionPolicy | undefined;
    environment: Readonly<Record<string, string | undefined>>;
  },
) {
  const documents = new SqliteDocumentRepository(database);
  const runs = new SqliteRunRepository(database);
  // 先校验模型可用性：失败请求不能产生正文版本副作用或删除草稿。
  requireWritingAssignment(database, input.environment);
  const document = documents.get(input.projectId, input.documentId);
  if (!document)
    throw new StudioServiceError(
      "document.not_found",
      "Document not found",
      404,
    );
  const draft = documents.getDraft(input.projectId, input.documentId);
  let version = documents.getVersion(
    input.projectId,
    input.documentId,
    input.baseVersionId,
  );
  if (!version)
    throw new StudioServiceError(
      "document.version.not_found",
      "The selection base version does not exist",
      404,
    );
  if (draft) {
    if (input.draftContentHash !== draft.contentHash) {
      throw new StudioServiceError(
        "edit.draft.changed",
        "The draft content has changed; restart the AI edit from the latest draft",
        409,
      );
    }
    if (
      draft.baseVersionId !== document.currentVersionId ||
      input.baseVersionId !== draft.baseVersionId
    ) {
      throw new StudioServiceError(
        "edit.base_version.conflict",
        "The draft base version is stale; refresh the manuscript and reselect",
        409,
      );
    }
    requireSelectionRange(
      draft.content,
      input.selectionStart,
      input.selectionEnd,
    );
    const now = new Date().toISOString();
    version = documents.appendVersion(input.projectId, input.documentId, {
      id: randomUuid(),
      content: draft.content,
      source: "draft-checkpoint:selection-edit",
      expectedCurrentVersionId: document.currentVersionId,
      now,
    });
    documents.deleteDraft(input.projectId, input.documentId, draft.content);
  } else if (
    input.draftContentHash !== null ||
    input.baseVersionId !== document.currentVersionId
  ) {
    throw new StudioServiceError(
      "edit.base_version.conflict",
      "The manuscript version has changed; reselect based on the current version",
      409,
    );
  } else {
    requireSelectionRange(
      version.content,
      input.selectionStart,
      input.selectionEnd,
    );
  }
  const runId = randomUuid();
  const recipe = buildSelectionEditRecipe(runId);
  return runs.create({
    id: runId,
    projectId: input.projectId,
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    targetOutlineNodeId: null,
    policy: withRuntimeModelPolicy(
      {
        documentId: input.documentId,
        baseVersionId: version.id,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        instruction: input.instruction,
        editMaxOutputTokens: 4_000,
        origin: {
          surface: "writing",
          documentId: input.documentId,
          selection: {
            start: input.selectionStart,
            end: input.selectionEnd,
          },
        },
        ...input.requestPolicy,
      },
      input.environment,
    ),
    steps: recipe.steps,
    now: new Date().toISOString(),
  });
}

/**
 * 编辑提案 accept 的完整组装：追加版本、更新检索段、大纲置 committed、
 * 写操作日志、自动开手动结算。reject 分支留在路由（单行仓储调用）。
 */
export function acceptEditProposal(
  database: NarrativeDatabase,
  input: {
    proposal: {
      id: string;
      projectId: string;
      documentId: string;
      runId: string;
      baseVersionId: string;
      proposedContent: string;
    };
    now: string;
    environment: Readonly<Record<string, string | undefined>>;
    coordinatorWake: () => void;
    /** See startManualSettlementRun: a Story Bible completion re-target. */
    interruptRun?: (runId: string, reason: string) => void;
    bibleBackfillWake?: () => void;
  },
) {
  const documents = new SqliteDocumentRepository(database);
  const story = new SqliteStoryRepository(database);
  const creative = new SqliteCreativeRepository(database);
  const { proposal } = input;
  const document = documents.get(proposal.projectId, proposal.documentId);
  if (!document)
    throw new StudioServiceError(
      "document.not_found",
      "Document not found",
      404,
    );
  if (document.currentVersionId !== proposal.baseVersionId) {
    throw new StudioServiceError(
      "edit.base_version.conflict",
      "The manuscript has changed; regenerate candidates based on the new version",
      409,
    );
  }
  const now = input.now;
  const version = documents.appendVersion(
    proposal.projectId,
    proposal.documentId,
    {
      id: randomUuid(),
      content: proposal.proposedContent,
      source: `edit-proposal:${proposal.id}`,
      runId: proposal.runId,
      expectedCurrentVersionId: proposal.baseVersionId,
      now,
    },
  );
  if (document.outlineNodeId) {
    new SqliteManuscriptIndexer(database).indexDocument({
      projectId: proposal.projectId,
      documentId: document.id,
      versionId: version.id,
      provenance: { editProposalId: proposal.id },
      now,
    });
    story.updateOutlineStatus(
      proposal.projectId,
      document.outlineNodeId,
      "committed",
      now,
    );
  }
  database.raw
    .prepare(
      `INSERT INTO operation_log(
        project_id, run_id, turn_id, operation, entity_table, entity_id,
        before_json, after_json, created_at
      ) VALUES (?, ?, NULL, 'edit.accept', 'document_versions', ?, ?, ?, ?)`,
    )
    .run(
      proposal.projectId,
      proposal.runId,
      version.id,
      JSON.stringify({ versionId: proposal.baseVersionId }),
      JSON.stringify({ versionId: version.id, proposalId: proposal.id }),
      now,
    );
  /* 采纳选区提案同样是章节正式内容变化，自动开手动结算。 */
  startManualSettlementRun({
    database,
    environment: input.environment,
    coordinatorWake: input.coordinatorWake,
    ...(input.interruptRun ? { interruptRun: input.interruptRun } : {}),
    ...(input.bibleBackfillWake
      ? { bibleBackfillWake: input.bibleBackfillWake }
      : {}),
    projectId: proposal.projectId,
    document,
    versionId: version.id,
  });
  return creative.decideEditProposal(proposal.id, "accepted", version.id, now);
}

export function requireSelectionRange(
  content: string,
  start: number,
  end: number,
) {
  if (start >= end || end > content.length) {
    throw new StudioServiceError(
      "edit.selection.invalid",
      "The selection is no longer valid; reselect based on the current content",
      422,
    );
  }
}

export function requireProject(
  projects: SqliteProjectRepository,
  projectId: string,
) {
  const project = projects.get(projectId);
  if (!project) {
    throw new StudioServiceError("project.not_found", "Project not found", 404);
  }
  return project;
}
