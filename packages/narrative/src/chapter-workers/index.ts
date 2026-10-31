import { requireCurrentChapterOutline } from "../outline-baseline.js";

import { ContextCompiler } from "@lapis/context";
import {
  createDocument,
  type NarrativeRunStep,
  type RunSnapshot,
} from "@lapis/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@lapis/harness";
import {
  SqliteCanonRepository,
  SqliteAutomationRepository,
  SqliteContextReceiptRepository,
  SqliteDocumentRepository,
  SqliteDeliveryRepository,
  SqliteManuscriptIndexer,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

import type { NarrativeModelClient } from "../model-client.js";
import {
  embedPlannedPassages,
  indexDocumentWithEmbeddings,
} from "../retrieval-index.js";
import {
  SETTLED_OUTLINE_NODE_KEY,
  SettlementApplicationService,
  SettlementConflictError,
} from "../settlement-application-service.js";
import { StoryStatePacketBuilder } from "../story-state-packet.js";
import {
  GroundedSettlementSchema,
  type GroundedSettlement,
} from "../schemas.js";
import {
  requireActiveProject,
  requireActiveRunCommit,
} from "../project-guard.js";

import { compileContext } from "./context-compile.js";
import { planScenes } from "./scene-plan.js";
import { generateDraft } from "./draft-generate.js";
import { deterministicCheck } from "./deterministic-check.js";
import { semanticReview } from "./semantic-review.js";
import { generateRevision } from "./revision.js";
import { settleChapter } from "./settle.js";
import {
  type ChapterWorkerDeps,
  bindSettlementEvidence,
  finalContent,
  manualSettlementTarget,
  requiredArtifact,
  settlementEntityIds,
  sha256,
  stringField,
  stringOrNull,
  zeroUsage,
} from "./helpers.js";

export { isRevisionNoop } from "./helpers.js";

export class ChapterWorkerSuite {
  private readonly automation: SqliteAutomationRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly retrieval: SqliteRetrievalRepository;
  private readonly indexer: SqliteManuscriptIndexer;
  private readonly receipts: SqliteContextReceiptRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly runs: SqliteRunRepository;
  private readonly delivery: SqliteDeliveryRepository;
  private readonly compiler: ContextCompiler;
  private readonly templates: SqliteTemplateRepository;
  private readonly storyState: StoryStatePacketBuilder;
  private readonly settlementApplication: SettlementApplicationService;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.automation = new SqliteAutomationRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
    this.documents = new SqliteDocumentRepository(database);
    this.retrieval = new SqliteRetrievalRepository(database);
    this.indexer = new SqliteManuscriptIndexer(database);
    this.receipts = new SqliteContextReceiptRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.delivery = new SqliteDeliveryRepository(database);
    this.compiler = new ContextCompiler(now);
    this.templates = new SqliteTemplateRepository(database);
    this.storyState = new StoryStatePacketBuilder(
      this.canon,
      this.state,
      this.story,
    );
    this.settlementApplication = new SettlementApplicationService(database);
  }

  registry(): WorkerRegistry {
    return {
      "context.compile": this.worker(this.compileContext.bind(this)),
      "scene.plan": this.worker(this.planScenes.bind(this)),
      "draft.generate": this.worker(this.generateDraft.bind(this)),
      "deterministic.check": this.worker(this.deterministicCheck.bind(this)),
      "semantic.review": this.worker(this.semanticReview.bind(this)),
      "revision.generate": this.worker(this.generateRevision.bind(this)),
      "chapter.settle": this.worker(this.settleChapter.bind(this)),
      "chapter.commit": this.worker(this.commitChapter.bind(this)),
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
        requireCurrentChapterOutline(this.database, snapshot);
        return execute(snapshot, step, signal);
      },
    };
  }

  private asDeps(): ChapterWorkerDeps {
    return {
      database: this.database,
      model: this.model,
      now: this.now,
      automation: this.automation,
      projects: this.projects,
      story: this.story,
      canon: this.canon,
      state: this.state,
      documents: this.documents,
      retrieval: this.retrieval,
      receipts: this.receipts,
      reviews: this.reviews,
      runs: this.runs,
      delivery: this.delivery,
      compiler: this.compiler,
      templates: this.templates,
      storyState: this.storyState,
      settlementApplication: this.settlementApplication,
    };
  }

  private async compileContext(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ) {
    return compileContext(this.asDeps(), snapshot, step, signal);
  }

  private async planScenes(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ) {
    return planScenes(this.asDeps(), snapshot, step, signal);
  }

  private async generateDraft(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ) {
    return generateDraft(this.asDeps(), snapshot, step, signal);
  }

  private async deterministicCheck(snapshot: RunSnapshot) {
    return deterministicCheck(this.asDeps(), snapshot);
  }

  private async semanticReview(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ) {
    return semanticReview(this.asDeps(), snapshot, step, signal);
  }

  private async generateRevision(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ) {
    return generateRevision(this.asDeps(), snapshot, step, signal);
  }

  private async settleChapter(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ) {
    return settleChapter(this.asDeps(), snapshot, step, signal);
  }

  private async commitChapter(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const run = snapshot.run;
    const settlement = GroundedSettlementSchema.parse(
      requiredArtifact(snapshot, "chapter.settle"),
    );
    const manual = manualSettlementTarget(this.asDeps(), snapshot);
    if (manual) {
      return this.commitManualSettlement(
        snapshot,
        step,
        manual,
        settlement,
        signal,
      );
    }
    const context = requiredArtifact(snapshot, "context.compile");
    const content = finalContent(snapshot);
    const targetId = stringField(context, "targetOutlineNodeId");
    const target = this.story.requireOutlineNode(run.projectId, targetId);
    const now = this.now().toISOString();
    const replayDocumentId =
      stringOrNull(context.baseDocumentId) ?? `${run.id}:chapter-document`;
    const replayVersion = this.documents.getVersion(
      run.projectId,
      replayDocumentId,
      step.id,
    );
    if (replayVersion) {
      this.reviews.bindRunReportsToDocumentVersion(
        run.id,
        replayVersion.id,
        replayVersion.contentHash,
      );
      this.reviews.acceptRunRevisionProposals(run.id, now);
      return {
        artifactKind: "chapter-commit",
        output: {
          documentId: replayDocumentId,
          versionId: replayVersion.id,
          contentHash: replayVersion.contentHash,
          idempotentReplay: true,
          changeSetId: `${run.id}:canon-change-set`,
        },
        usage: zeroUsage(),
      };
    }
    const plannedDocument =
      (stringOrNull(context.baseDocumentId)
        ? this.documents.get(
            run.projectId,
            stringField(context, "baseDocumentId"),
          )
        : null) ??
      this.documents.get(run.projectId, `${run.id}:chapter-document`);
    const contentEmbedding = await embedPlannedPassages({
      database: this.database,
      client: this.model,
      run,
      step,
      purpose: "chapter-index",
      passages: this.indexer.planPassages(
        plannedDocument?.id ?? `${run.id}:chapter-document`,
        plannedDocument?.title ?? target.title,
        content,
      ),
      signal,
    });
    const output = this.database.transaction(() => {
      requireActiveRunCommit(this.database, run.id, run.projectId, signal);
      requireCurrentChapterOutline(this.database, snapshot);
      let document = stringOrNull(context.baseDocumentId)
        ? this.documents.get(
            run.projectId,
            stringField(context, "baseDocumentId"),
          )
        : null;
      if (!document) {
        const documentId = `${run.id}:chapter-document`;
        document = this.documents.get(run.projectId, documentId);
        if (!document) {
          document = this.documents.insert(
            createDocument({
              id: documentId,
              projectId: run.projectId,
              kind: "chapter",
              title: target.title,
              outlineNodeId: target.id,
              now,
            }),
          );
        }
      }
      const existing = this.documents.getVersion(
        run.projectId,
        document.id,
        step.id,
      );
      if (existing) {
        this.reviews.acceptRunRevisionProposals(run.id, now);
        return {
          documentId: document.id,
          versionId: existing.id,
          contentHash: existing.contentHash,
          idempotentReplay: true,
          changeSetId: `${run.id}:canon-change-set`,
        };
      }
      const currentVersion = document.currentVersionId
        ? this.documents.getVersion(
            run.projectId,
            document.id,
            document.currentVersionId,
          )
        : null;
      const replayChangeSet = this.reviews.getCanonChangeSet(
        run.projectId,
        `${run.id}:canon-change-set`,
      );
      if (replayChangeSet && currentVersion?.contentHash === sha256(content)) {
        this.reviews.bindRunReportsToDocumentVersion(
          run.id,
          currentVersion.id,
          currentVersion.contentHash,
        );
        this.reviews.acceptRunRevisionProposals(run.id, now);
        return {
          documentId: document.id,
          versionId: currentVersion.id,
          contentHash: currentVersion.contentHash,
          idempotentReplay: true,
          versionCreated: false,
          changeSetId: replayChangeSet.id,
        };
      }
      const versionCreated = currentVersion?.contentHash !== sha256(content);
      const version = versionCreated
        ? this.documents.appendVersion(run.projectId, document.id, {
            id: step.id,
            content,
            source: `run:${run.id}`,
            runId: run.id,
            expectedCurrentVersionId: stringOrNull(context.baseVersionId),
            now,
          })
        : currentVersion!;
      const boundSettlement = bindSettlementEvidence(settlement, version.id);
      this.reviews.bindRunReportsToDocumentVersion(
        run.id,
        version.id,
        version.contentHash,
      );
      this.reviews.acceptRunRevisionProposals(run.id, now);
      const entityIds = settlementEntityIds(boundSettlement).filter((id) =>
        Boolean(this.canon.getEntity(run.projectId, id)),
      );
      const index = indexDocumentWithEmbeddings(
        this.database,
        {
          projectId: run.projectId,
          documentId: document.id,
          versionId: version.id,
          settlementEntityIds: entityIds,
          provenance: { runId: run.id },
          now,
        },
        contentEmbedding,
      );
      this.state.upsertSummary({
        id: `${run.id}:summary`,
        projectId: run.projectId,
        scopeType: "chapter",
        scopeId: target.id,
        summary: boundSettlement.summary,
        stateDelta: { changes: boundSettlement.stateDelta },
        sourceHash: version.contentHash,
        createdAt: now,
      });
      const changeSetId = `${run.id}:canon-change-set`;
      this.reviews.insertCanonChangeSet({
        id: changeSetId,
        projectId: run.projectId,
        runId: run.id,
        stepId: step.id,
        changes: boundSettlement,
        status: "candidate",
        createdAt: now,
      });
      let settlementApplication = null;
      let settlementConflict = null;
      if (run.mode === "autopilot" || run.policy.autoApplySettlement === true) {
        try {
          settlementApplication = this.settlementApplication.apply({
            projectId: run.projectId,
            changeSetId,
            conflictPolicy: "reject",
            now,
          });
        } catch (error) {
          if (!(error instanceof SettlementConflictError)) throw error;
          settlementConflict = {
            code: error.code,
            changeSetId,
            conflicts: error.conflicts,
          };
        }
      }
      this.story.updateOutlineStatus(
        run.projectId,
        target.id,
        settlementConflict ? "review" : "committed",
        now,
      );
      return {
        documentId: document.id,
        versionId: version.id,
        contentHash: version.contentHash,
        idempotentReplay: false,
        versionCreated,
        changeSetId,
        settlementApplication,
        settlementConflict,
        retrievalEmbedding: {
          model: contentEmbedding.model,
          modelId: contentEmbedding.modelId,
          warning: contentEmbedding.warning,
          passages: index.passages,
          embeddedPassages: index.embedded,
        },
      };
    });
    return {
      artifactKind: "chapter-commit",
      output,
      usage: contentEmbedding.usage,
    };
  }

  private async commitManualSettlement(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    manual: NonNullable<NonNullable<ReturnType<typeof manualSettlementTarget>>>,
    settlement: GroundedSettlement,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const run = snapshot.run;
    const changeSetId = `${run.id}:canon-change-set`;
    const replayChangeSet = this.reviews.getCanonChangeSet(
      run.projectId,
      changeSetId,
    );
    if (replayChangeSet) {
      return {
        artifactKind: "chapter-commit",
        output: {
          documentId: manual.document.id,
          versionId: manual.version.id,
          contentHash: manual.version.contentHash,
          idempotentReplay: true,
          versionCreated: false,
          changeSetId,
          manualSettlement: true,
        },
        usage: zeroUsage(),
      };
    }
    const contentEmbedding = await embedPlannedPassages({
      database: this.database,
      client: this.model,
      run,
      step,
      purpose: "chapter-index",
      passages: this.indexer.planPassages(
        manual.document.id,
        manual.document.title,
        manual.content,
      ),
      signal,
    });
    const now = this.now().toISOString();
    const output = this.database.transaction(() => {
      requireActiveRunCommit(this.database, run.id, run.projectId, signal);
      const boundSettlement = bindSettlementEvidence(
        settlement,
        manual.version.id,
      );
      const entityIds = settlementEntityIds(boundSettlement).filter((id) =>
        Boolean(this.canon.getEntity(run.projectId, id)),
      );
      // A newer version may have been committed while this one settled; it
      // is indexed on its own, so only the still-current version is written.
      const index =
        this.documents.get(run.projectId, manual.document.id)
          ?.currentVersionId === manual.version.id
          ? indexDocumentWithEmbeddings(
              this.database,
              {
                projectId: run.projectId,
                documentId: manual.document.id,
                versionId: manual.version.id,
                settlementEntityIds: entityIds,
                provenance: { runId: run.id },
                now,
              },
              contentEmbedding,
            )
          : { passages: 0, embedded: 0 };
      this.state.upsertSummary({
        id: `${run.id}:summary`,
        projectId: run.projectId,
        scopeType: "chapter",
        scopeId: manual.outlineNode.id,
        summary: boundSettlement.summary,
        stateDelta: { changes: boundSettlement.stateDelta },
        sourceHash: manual.version.contentHash,
        createdAt: now,
      });
      /* 没有任何候选的手动结算（例如只修错字）不建空变更集，避免裁定面板出现噪音。 */
      const hasCandidates =
        boundSettlement.stateDelta.length > 0 ||
        boundSettlement.factCandidates.length > 0 ||
        boundSettlement.timelineCandidates.length > 0 ||
        boundSettlement.relationshipCandidates.length > 0 ||
        boundSettlement.foreshadowCandidates.length > 0;
      if (hasCandidates) {
        this.reviews.insertCanonChangeSet({
          id: changeSetId,
          projectId: run.projectId,
          runId: run.id,
          stepId: step.id,
          /* 锚点章节在结算时就确定：之后文档改绑或删除都不会移动或阻断它
             （见 SettlementApplicationService.settlementAnchor）。 */
          changes: {
            ...boundSettlement,
            [SETTLED_OUTLINE_NODE_KEY]: manual.outlineNode.id,
          },
          status: "candidate",
          createdAt: now,
        });
      }
      return {
        documentId: manual.document.id,
        versionId: manual.version.id,
        contentHash: manual.version.contentHash,
        idempotentReplay: false,
        versionCreated: false,
        changeSetId: hasCandidates ? changeSetId : null,
        settlementApplication: null,
        settlementConflict: null,
        manualSettlement: true,
        retrievalEmbedding: {
          model: contentEmbedding.model,
          modelId: contentEmbedding.modelId,
          warning: contentEmbedding.warning,
          passages: index.passages,
          embeddedPassages: index.embedded,
        },
      };
    });
    return {
      artifactKind: "chapter-commit",
      output,
      usage: contentEmbedding.usage,
    };
  }
}
