import { sha256Hex, validateTextRange } from "@lapis/domain";
import type {
  NarrativeRunStep,
  RunBudgetUsage,
  RunSnapshot,
} from "@lapis/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@lapis/harness";
import { promptDefaultInstructions, promptInvariants } from "@lapis/harness";
import {
  SqliteCreativeRepository,
  SqliteDeliveryRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import {
  authoredInstructions,
  promptLanguageOf,
  workCraftLayer,
} from "./prompt-language.js";
import {
  collaborationValidator,
  SELECTION_EDIT_CONTRACT,
  SelectionEditResultSchema,
} from "./collaboration-schemas.js";
import { requireActiveProject } from "./project-guard.js";

/** Workers for the selection edit on a studio document. */
export class CollaborationWorkerSuite {
  private readonly creative: SqliteCreativeRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly delivery: SqliteDeliveryRepository;
  private readonly templates: SqliteTemplateRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.creative = new SqliteCreativeRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.delivery = new SqliteDeliveryRepository(database);
    this.templates = new SqliteTemplateRepository(database);
  }

  /** Replacement-style instruction assembly: the template's effective content
   *  (override ?? official default) replaces the writing layer as a whole;
   *  structural invariants are appended by code and unaffected by the template;
   *  craft=true appends the project's writing method. */
  private authoredInstructions(
    projectId: string,
    key: string,
    options?: { craft?: boolean },
  ): string {
    return authoredInstructions({
      language: promptLanguageOf(
        this.projects.get(projectId)?.language ?? null,
      ),
      templateContent: this.templates.getByKey(key)?.effectiveContent ?? null,
      fallback: promptDefaultInstructions(key),
      invariants: promptInvariants(key),
      craft: options?.craft ? this.workCraft(projectId) : null,
    });
  }

  /**
   * The project's writing method: the effective writing layer of chapter-draft,
   * shared by steps that rewrite prose.
   */
  private workCraft(projectId: string): string {
    return workCraftLayer({
      language: promptLanguageOf(
        this.projects.get(projectId)?.language ?? null,
      ),
      templateContent:
        this.templates.getByKey("prompt.chapter-draft")?.effectiveContent ??
        null,
      fallback: promptDefaultInstructions("prompt.chapter-draft"),
    });
  }

  registry(): WorkerRegistry {
    return {
      "edit.transform": this.worker(this.transformSelection.bind(this)),
      "edit.stage": this.worker(this.stageSelectionEdit.bind(this)),
    };
  }

  private worker(
    execute: (
      snapshot: RunSnapshot,
      step: NarrativeRunStep,
      signal: AbortSignal,
    ) => Promise<StepExecutionResult>,
  ): StepWorker {
    return {
      execute: (snapshot, step, signal) => {
        requireActiveProject(this.database, snapshot.run.projectId);
        return execute(snapshot, step, signal);
      },
    };
  }

  private async transformSelection(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const documentId = policyString(snapshot.run.policy, "documentId");
    const baseVersionId = policyString(snapshot.run.policy, "baseVersionId");
    const version = this.documents.getVersion(
      snapshot.run.projectId,
      documentId,
      baseVersionId,
    );
    if (!version)
      throw permanent("document.version.not_found", "Base version not found");
    const start = policyNumber(snapshot.run.policy, "selectionStart", -1);
    const end = policyNumber(snapshot.run.policy, "selectionEnd", -1);
    validateTextRange(version.content, start, end);
    const selected = version.content.slice(start, end);
    const instruction = policyString(snapshot.run.policy, "instruction");
    const left = version.content.slice(Math.max(0, start - 2_000), start);
    const right = version.content.slice(
      end,
      Math.min(version.content.length, end + 2_000),
    );
    const intent = this.story.getAuthorIntent(snapshot.run.projectId);
    const editGuidance = {
      style: this.delivery.getActiveStyleProfile(snapshot.run.projectId),
      skills: this.delivery.listApplicableSkills(
        snapshot.run.projectId,
        "edit",
      ),
    };
    const result = await this.model.structured(
      snapshot.run,
      step,
      "selection-edit",
      {
        instructions: this.authoredInstructions(
          snapshot.run.projectId,
          "prompt.line-edit",
          { craft: true },
        ),
        messages: [
          {
            role: "user",
            content: [
              `Intenção do autor: ${JSON.stringify(intent)}`,
              `Estilo e Skills ativos: ${JSON.stringify(editGuidance)}`,
              `Instrução: ${instruction}`,
              `Antes: ${left}`,
              `【seleção exata】${selected}【fim da seleção】`,
              `Depois: ${right}`,
            ].join("\n\n"),
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "editMaxOutputTokens",
          4_000,
        ),
      },
      SELECTION_EDIT_CONTRACT,
      collaborationValidator(SelectionEditResultSchema),
      signal,
    );
    return {
      artifactKind: "selection-edit-result",
      output: {
        ...result.value,
        documentId,
        baseVersionId,
        selectionStart: start,
        selectionEnd: end,
        originalText: selected,
        instruction,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stageSelectionEdit(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const result = SelectionEditResultSchema.parse(
      requiredArtifact(snapshot, "edit.transform"),
    );
    const transform = requiredArtifact(snapshot, "edit.transform");
    const documentId = stringField(transform, "documentId");
    const baseVersionId = stringField(transform, "baseVersionId");
    const version = this.documents.getVersion(
      snapshot.run.projectId,
      documentId,
      baseVersionId,
    );
    if (!version)
      throw permanent("document.version.not_found", "Base version not found");
    const start = numberField(transform, "selectionStart");
    const end = numberField(transform, "selectionEnd");
    validateTextRange(version.content, start, end);
    const originalText = version.content.slice(start, end);
    if (originalText !== stringField(transform, "originalText")) {
      throw permanent(
        "edit.selection.changed",
        "The selection does not match the base version",
      );
    }
    const proposedContent =
      version.content.slice(0, start) +
      result.replacementText +
      version.content.slice(end);
    const proposal = this.creative.insertEditProposal({
      id: `${snapshot.run.id}:proposal`,
      projectId: snapshot.run.projectId,
      documentId,
      baseVersionId,
      runId: snapshot.run.id,
      instruction: stringField(transform, "instruction"),
      selectionStart: start,
      selectionEnd: end,
      originalText,
      replacementText: result.replacementText,
      proposedContent,
      diff: selectionDiff(originalText, result.replacementText, start, end),
      status: "proposed",
      acceptedVersionId: null,
      createdAt: this.now().toISOString(),
      decidedAt: null,
    });
    return {
      artifactKind: "edit-proposal",
      output: {
        proposalId: proposal.id,
        documentId,
        baseVersionId,
        risk: result.risk,
      },
      usage: zeroUsage(),
    };
  }
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Record<string, unknown> {
  const artifact = [...snapshot.steps]
    .reverse()
    .find(
      (step) => step.kind === kind && step.status === "succeeded",
    )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing artifact for step ${kind}`);
  return { ...artifact };
}

function selectionDiff(
  before: string,
  after: string,
  start: number,
  end: number,
): Record<string, unknown> {
  const beforeParagraphs = before.split(/\n{2,}/u);
  const afterParagraphs = after.split(/\n{2,}/u);
  return {
    range: { start, end },
    before,
    after,
    beforeCharacters: [...before].length,
    afterCharacters: [...after].length,
    paragraphHunks: Array.from(
      { length: Math.max(beforeParagraphs.length, afterParagraphs.length) },
      (_, index) => ({
        index,
        before: beforeParagraphs[index] ?? null,
        after: afterParagraphs[index] ?? null,
        changed: beforeParagraphs[index] !== afterParagraphs[index],
      }),
    ),
    hash: sha256Hex(`${before}\0${after}`),
  };
}

function policyString(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = policy[key];
  if (typeof value !== "string" || !value.trim()) {
    throw permanent("run.policy.invalid", `Run policy is missing ${key}`);
  }
  return value;
}

function policyNumber(
  policy: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw permanent("artifact.invalid", `Artifact field ${key} is invalid`);
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw permanent("artifact.invalid", `Artifact field ${key} is invalid`);
  }
  return field;
}

function zeroUsage(): RunBudgetUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
}

function permanent(code: string, message: string) {
  return {
    code,
    message,
    retryable: false,
  };
}
