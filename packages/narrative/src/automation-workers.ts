import { sha256Hex } from "@lapis/domain";
import {
  StoryCompassSchema,
  StoryLineProposalChangesSchema,
} from "@lapis/contracts";
import {
  StoryLineProposalService,
  storyLineReviewEvidence,
  storyLineProposalIssues,
} from "./story-line-proposals.js";
import { ContextCompiler, type ContextSource } from "@lapis/context";

import {
  createOutlineNode,
  type NarrativeRunStep,
  type OutlineNode,
  type RunBudgetUsage,
  type RunSnapshot,
} from "@lapis/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@lapis/harness";
import { promptDefaultInstructions, promptInvariants } from "@lapis/harness";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteContextReceiptRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import {
  automationValidator,
  FOUNDATION_CONTRACT,
  FoundationGenerationArtifactSchema,
  FoundationProposalSchema,
  PLANNING_REVIEW_CONTRACT,
  PlanningReviewResultSchema,
  ROLLING_OUTLINE_CONTRACT,
  RollingOutlineProposalSchema,
  STEER_CLASSIFICATION_CONTRACT,
  SteerClassificationResultSchema,
} from "./automation-schemas.js";
import {
  outlineFingerprint,
  planningEntityIssues,
  planningRejections,
  requirePlanningEntitiesReady,
  stagePlanningEntities,
} from "./planning-entities.js";
import {
  authoredInstructions,
  instructionsFor,
  promptLanguageOf,
} from "./prompt-language.js";
import { StoryStatePacketBuilder } from "./story-state-packet.js";
import { outlineContextSources } from "./outline-context.js";
import {
  requireActiveProject,
  requireActiveRunCommit,
} from "./project-guard.js";

export class AutomationWorkerSuite {
  private readonly automation: SqliteAutomationRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly templates: SqliteTemplateRepository;
  private readonly storyState: StoryStatePacketBuilder;

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
    this.templates = new SqliteTemplateRepository(database);
    this.storyState = new StoryStatePacketBuilder(
      this.canon,
      this.state,
      this.story,
    );
  }

  /** Replacement-style instruction assembly: the template's effective content
   *  (override ?? official default) replaces the writing layer as a whole;
   *  structural invariants are appended by code and unaffected by the template.
   */
  private authoredInstructions(projectId: string, key: string): string {
    return authoredInstructions({
      language: promptLanguageOf(
        this.projects.get(projectId)?.language ?? null,
      ),
      templateContent: this.templates.getByKey(key)?.effectiveContent ?? null,
      fallback: promptDefaultInstructions(key),
      invariants: promptInvariants(key),
    });
  }

  registry(): WorkerRegistry {
    return {
      "foundation.generate": this.worker(this.generateFoundation.bind(this)),
      "foundation.stage": this.worker(this.stageFoundation.bind(this)),
      "outline.generate": this.worker(this.generateOutline.bind(this)),
      "outline.entities": this.worker(this.stageOutlineEntities.bind(this)),
      "outline.commit": this.worker(this.commitOutline.bind(this)),
      "steer.classify": this.worker(this.classifySteer.bind(this)),
      "arc.review": this.worker(this.reviewArc.bind(this)),
      "volume.review": this.worker(this.reviewVolume.bind(this)),
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

  private async generateFoundation(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const braindump = policyString(snapshot.run.policy, "braindump");
    const preferences = policyRecord(snapshot.run.policy, "preferences");
    const creativePreferences = {
      genre: preferences.genre ?? null,
      audience: preferences.audience ?? null,
      tone: preferences.tone ?? null,
    };
    const planningTarget = {
      chapters: policyNumber(preferences, "targetChapters", 12),
      wordsPerChapter: policyNumber(preferences, "wordsPerChapter", 3_000),
      volumes: policyNumber(preferences, "volumes", 1),
    };
    const baseline = {
      intentUpdatedAt:
        this.story.getAuthorIntent(snapshot.run.projectId)?.updatedAt ?? null,
      compassVersion:
        this.automation.getCompass(snapshot.run.projectId)?.version ?? null,
    };
    const result = await this.model.structured(
      snapshot.run,
      step,
      "book-foundation",
      {
        instructions: this.authoredInstructions(
          project.id,
          "prompt.book-foundation",
        ),
        messages: [
          {
            role: "user",
            content: [
              `Título provisório da obra: ${project.title}`,
              project.premise
                ? `Premissa já existente: ${project.premise}`
                : "",
              `Material do autor:\n${braindump}`,
              `Preferências criativas: ${JSON.stringify(creativePreferences)}`,
              `Escala de planejamento (escrever só em compass.target da bússola): ${JSON.stringify(planningTarget)}`,
              "Entregue um conjunto de candidatos de fundação da obra, coordenados entre si, mas ainda adotáveis ou descartáveis um a um.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "foundationMaxOutputTokens",
          8_000,
        ),
      },
      FOUNDATION_CONTRACT,
      automationValidator(FoundationProposalSchema),
      signal,
    );
    return {
      artifactKind: "foundation-proposal",
      output: {
        ...result.value,
        compass: {
          ...result.value.compass,
          target: planningTarget,
        },
        baseline,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stageFoundation(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const proposal = FoundationGenerationArtifactSchema.parse(
      requiredArtifact(snapshot, "foundation.generate"),
    );
    const setId = `${snapshot.run.id}:foundation-set`;
    const now = this.now().toISOString();
    const candidates = [
      {
        id: `${setId}:intent`,
        kind: "intent" as const,
        label: "Intenção do autor",
        payload: {
          ...proposal.intent,
          baseline: {
            intentUpdatedAt: proposal.baseline.intentUpdatedAt,
          },
        },
      },
      {
        id: `${setId}:compass`,
        kind: "compass" as const,
        label: "Bússola da história",
        payload: {
          ...proposal.compass,
          baseline: {
            compassVersion: proposal.baseline.compassVersion,
          },
        },
      },
      ...proposal.entities.map((entity, index) => ({
        id: `${setId}:entity:${index}`,
        kind: "entity" as const,
        label: entity.name,
        payload: { ...entity },
      })),
    ];
    const detail = this.automation.stageCandidateSet({
      id: setId,
      projectId: snapshot.run.projectId,
      sourceRunId: snapshot.run.id,
      title: proposal.title,
      candidates,
      now,
    });
    return {
      artifactKind: "foundation-candidate-set",
      output: {
        candidateSetId: detail.set.id,
        candidateCount: detail.candidates.length,
        rationale: proposal.rationale,
      },
      usage: zeroUsage(),
    };
  }

  private async generateOutline(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const session = this.automation.requireSession(sessionId);
    const project = this.projects.get(session.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const compass = this.automation.getCompass(session.projectId);
    const intent = this.story.getAuthorIntent(session.projectId);
    const outline = this.story.listOutline(session.projectId);
    const entities = this.canon.listEntities(session.projectId, {
      includeRetired: true,
    });
    const steers = this.automation
      .listSteers(sessionId)
      .filter(
        (steer) =>
          steer.status === "applied" &&
          ["future_plan", "canon_change", "rewrite_existing"].includes(
            steer.classification ?? "",
          ),
      )
      .map((steer) => ({
        content: steer.content,
        classification: steer.classification,
        status: steer.status,
      }));
    const continuationState = this.storyState.build({
      projectId: session.projectId,
      audience: "author",
      maxTimelineEvents: 120,
      maxRelationships: 120,
    });
    const remaining = Math.max(
      1,
      session.targetChapters - session.completedChapters,
    );
    const windowSize = Math.min(session.windowSize, remaining);
    const contextWindow =
      this.model.effectiveContextWindow?.(snapshot.run, "rolling-outline") ??
      64_000;
    const outputReserve = Math.min(
      policyNumber(snapshot.run.policy, "planningMaxOutputTokens", 10_000),
      this.model.effectiveOutputLimit?.(snapshot.run, "rolling-outline") ??
        10_000,
      Math.floor(contextWindow * 0.4),
    );
    const latestChapter = outline
      .filter((node) => node.kind === "chapter" && node.status === "committed")
      .at(-1);
    const sources: ContextSource[] = [
      {
        id: "planning-task",
        kind: "task",
        label: "Tarefa de planejamento desta sessão",
        authority: "locked",
        priority: 100,
        required: true,
        compressible: false,
        sourceType: "autopilot_session",
        sourceId: session.id,
        content: JSON.stringify({
          title: project.title,
          windowChapters: windowSize,
          runRemainingChapters: remaining,
          activeStructure: outline
            .filter(
              (node) =>
                ["arc", "volume"].includes(node.kind) &&
                node.status !== "abandoned",
            )
            .slice(-6)
            .map(compactOutline),
        }),
      },
      {
        id: "planning-intent",
        kind: "author-intent",
        label: "Intenção do autor e direção do livro",
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "author_intent",
        sourceId: project.id,
        content: JSON.stringify({ intent, compass }),
      },
      ...outlineContextSources({
        projectId: project.id,
        outline,
        chapterSummaries: this.state.listLatestSummaries(project.id, "chapter"),
        targetOutlineNodeId: latestChapter?.id ?? null,
      }),
      {
        id: "planning-entities",
        kind: "canon",
        label: "Catálogo de entidades e recusas do autor",
        authority: "confirmed",
        priority: 98,
        required: true,
        compressible: false,
        sourceType: "canon_entities",
        sourceId: project.id,
        content: JSON.stringify({
          entities: entities.map(
            ({ id, type, name, aliases, description, status }) => ({
              id,
              type,
              name,
              aliases,
              description: description?.slice(0, 240) ?? null,
              status,
            }),
          ),
          rejectedProposals: planningRejections(this.database, project.id),
        }),
      },
      ...continuationState.sources,
      ...new StoryLineProposalService(this.database)
        .list(project.id)
        .slice(0, 12)
        .map((set, index): ContextSource => ({
          id: `story-line-decisions:${set.id}`,
          kind: "author-intent",
          label: "Propostas de linha e decisões item a item do autor",
          content: JSON.stringify({
            scopeNodeId: set.scopeNodeId,
            stale: set.stale,
            items: set.items.map((item) => ({
              title: item.before.title,
              proposal: item.after,
              decision: item.decision ?? "pending",
            })),
          }),
          authority: "reference",
          priority: Math.max(50, 97 - index),
          compressible: false,
          sourceType: "canon_change_set",
          sourceId: set.id,
        })),
      ...[
        ...this.state.listLatestSummaries(project.id, "arc"),
        ...this.state.listLatestSummaries(project.id, "volume"),
      ]
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((review, index): ContextSource => ({
          id: `planning-review:${review.id}`,
          kind: "summary",
          label:
            "Sugestões de retrospectiva de estágio (não são fatos ocorridos)",
          content: JSON.stringify({
            scopeId: review.scopeId,
            summary: review.summary,
            suggestions: review.stateDelta,
          }),
          summary: review.summary,
          authority: "reference",
          priority: Math.max(50, 96 - index),
          required: index < 2,
          sourceType: "narrative_summary",
          sourceId: review.id,
        })),
      ...steers.map((steer, index): ContextSource => ({
        id: `planning-steer:${index}`,
        kind: "author-intent",
        label: "Indicações de planejamento futuro já confirmadas pelo autor",
        content: steer.content,
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "story_steer",
        sourceId: session.id,
      })),
    ];
    const compiled = new ContextCompiler(this.now).compile({
      projectId: project.id,
      purpose: "rolling-outline",
      sources,
      budget: {
        contextWindow,
        outputReserve,
        fixedInstructionReserve: 1_500,
        schemaReserve: 1_500,
        toolReserve: 0,
      },
    });
    new SqliteContextReceiptRepository(this.database).insert(compiled.receipt, {
      runId: snapshot.run.id,
      stepId: step.id,
    });
    const result = await this.model.structured(
      snapshot.run,
      step,
      "rolling-outline",
      {
        instructions: instructionsFor(project.language, {
          "pt-BR": [
            "Você é o planejador rolante de um romance. Detalhe só a janela visível agora; nunca congele o livro inteiro de uma vez.",
            "O plano continua os capítulos já registrados, honra a bússola e respeita a intenção travada e os steers do autor.",
            "Em propostas de linha, pending ainda não foi aceito e reject é recusa do autor; nenhum dos dois é rumo. O result de um apply registra o que de fato foi escrito na hora; a bússola atual prevalece. Não repita mudanças recusadas.",
            "Cada longLines.development é registro de estágio do autor: scopeNodeId identifica o volume ou arco, stageGoal o objetivo atual, progress a nota de andamento, openPromises as promessas em aberto, nextDevelopment a direção seguinte. Escolha as linhas desta janela; nem toda linha precisa aparecer em todo capítulo nem se resolver no fim da janela. evidenceChapterIds apontam capítulos já registrados. Confira resumos e fatos; metas planejadas e progresso sem evidência não são eventos ocorridos.",
            "Cada capítulo precisa de objetivo, resistência, virada, resultado e gancho de fecho; o resultado empurra a cadeia causal.",
            "Antes, veja se personagens, relações e espaços já existentes carregam a história. Só proponha personagem, lugar ou organização nova quando esta janela precisar. entityProposals pode ficar vazio: não há cota, e o elenco inicial não precisa carregar todo conflito futuro. Explique narrativeRole e rationale, honre recusas, e não renomeie uma ideia recusada para repetir a função.",
            "pov e entityRefs do capítulo usam {kind: existing, id: ID da entidade} ou {kind: proposed, id: chave da proposta}. POV só referencia personagem. Reuse IDs estáveis do catálogo; nunca infira identidade pelo nome nem duplique nome ou alias existente. Entradas aposentadas não se citam. Toda proposta serve pelo menos um capítulo desta janela. Descrição e papel narrativo não são eventos já ocorridos.",
            "Capítulos restantes da execução descrevem a carga deste encargo, não o fim de um arco, volume ou livro. Encerre a obra só quando a intenção do autor e o andamento já estabelecido pedirem, nunca só para esgotar a janela.",
            "volumeId/arcId recebem o volume/arco existente a continuar, ou null só quando a história entra em fase nova. Um arco pode atravessar várias janelas. Preserve objetivos e resultados já estabelecidos. arcId deve pertencer a volumeId.",
            "Devolva exatamente a quantidade de capítulos pedida nesta janela. nextArc é esqueleto futuro revisável, não fato ocorrido. Avalie sugestões de recap e incorpore as úteis; não são ordem do autor nem cânone.",
          ],
          en: [
            "You are the rolling planner of a long-form novel. Plan only the currently visible window in detail; never freeze an entire long novel at once.",
            "The plan must continue from committed chapters, honor the compass, and respect the author's locked intent and steers.",
            "For story line proposals, pending is unaccepted and reject is an author rejection; neither is author direction. An apply result records the actual write at that time; the current compass takes precedence. Do not repeat rejected changes.",
            "Each longLines.development entry is an author-maintained stage record: scopeNodeId identifies its volume or arc, stageGoal is the current objective, progress is the author's progress note, openPromises lists outstanding promises, and nextDevelopment gives future direction. Select lines relevant to this window; not every line must appear in every chapter or resolve by the window's end. evidenceChapterIds reference committed chapters. Check summaries and facts; planned goals and unsupported progress notes are not established events.",
            "Each chapter needs a goal, resistance, a turn, an outcome, and a closing hook; outcomes must advance the causal chain.",
            "First consider whether existing characters, changing relationships, and settings can serve the story. Propose a new character, location, or organization only when this window needs one. entityProposals may be empty: there is no quota, and the initial cast need not carry every future conflict. Explain each narrativeRole and rationale, honor rejected proposals, and do not rename a rejected idea to repeat it.",
            "Chapter pov and entityRefs must use {kind: existing, id: entity ID} or {kind: proposed, id: proposal key}. POV must reference a character. Reuse stable catalog IDs, never infer identity from a name or duplicate an existing name or alias. Retired entries cannot be referenced. Every proposal must serve at least one chapter in this window. Descriptions and narrative roles are not events that have already occurred.",
            "Remaining run chapters describe this assignment's workload, not the end of an arc, volume, or book. Resolve the book only when author intent and established narrative progress call for it, never just to finish a window.",
            "Set volumeId/arcId to the existing volume/arc to continue, or null to create one only when the story enters a new phase. An arc may span several windows. Preserve existing goals and established outcomes. arcId must belong to volumeId.",
            "Return exactly the requested window chapter count. nextArc is a revisable future outline, not a past event. Evaluate retrospective suggestions and incorporate useful ones; they are neither author commands nor canon.",
          ],
        }),
        messages: [
          {
            role: "user",
            content: compiled.text,
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: outputReserve,
      },
      ROLLING_OUTLINE_CONTRACT,
      automationValidator(RollingOutlineProposalSchema, (plan) =>
        planningEntityIssues(
          { ...plan, chapters: plan.chapters.slice(0, windowSize) },
          entities,
        ),
      ),
      signal,
    );
    const value = {
      ...result.value,
      chapters: result.value.chapters.slice(0, windowSize),
    };
    return {
      artifactKind: "rolling-outline-proposal",
      output: {
        ...value,
        generation: {
          mode: result.mode,
          attempts: result.attempts,
          // Save the outline baseline at generation time; commit compares
          // against it, so background planning cannot overwrite manual edits
          // made meanwhile.
          outlineFingerprint: outlineFingerprint(outline),
          compassVersion: compass?.version ?? null,
          contextReceiptId: compiled.receipt.id,
        },
      },
      usage: result.usage,
    };
  }

  private async stageOutlineEntities(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const output = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      return stagePlanningEntities(
        this.database,
        snapshot,
        step.id,
        this.now().toISOString(),
      );
    });
    return {
      artifactKind: "planning-entity-candidates",
      output,
      usage: zeroUsage(),
    };
  }

  private async commitOutline(
    snapshot: RunSnapshot,
    _step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const artifact = requiredArtifact(snapshot, "outline.generate");
    const plan = RollingOutlineProposalSchema.parse(artifact);
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const session = this.automation.requireSession(sessionId);
    const now = this.now().toISOString();
    const result = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      const bindings = requirePlanningEntitiesReady(this.database, snapshot);
      const outline = this.story.listOutline(session.projectId);
      const root = outline.find((node) => node.kind === "book");
      if (!root)
        throw permanent(
          "outline.root.missing",
          "Project is missing the book root node",
        );
      let volume = plan.volumeId
        ? this.story.getOutlineNode(session.projectId, plan.volumeId)
        : null;
      if (
        plan.volumeId &&
        (!volume || volume.kind !== "volume" || volume.status === "abandoned")
      ) {
        throw permanent(
          "outline.structure.invalid",
          "The selected volume is unavailable",
        );
      }
      if (!volume) {
        volume = this.story.insertOutlineNode(
          createOutlineNode({
            id: `${snapshot.run.id}:volume`,
            projectId: session.projectId,
            parent: root,
            kind: "volume",
            ordinal: nextOrdinal(outline, root.id),
            title: plan.volume.title,
            summary: plan.volume.summary,
            goal: plan.volume.goal,
            metadata: { detail: "active", sourceRunId: snapshot.run.id },
            now,
          }),
        );
      }
      const volumeChildren = this.story.listOutlineChildren(
        session.projectId,
        volume.id,
      );
      let arc = plan.arcId
        ? this.story.getOutlineNode(session.projectId, plan.arcId)
        : null;
      if (
        plan.arcId &&
        (!arc ||
          arc.kind !== "arc" ||
          arc.parentId !== volume.id ||
          arc.status === "abandoned")
      ) {
        throw permanent(
          "outline.structure.invalid",
          "The selected arc must belong to the selected volume",
        );
      }
      if (arc) {
        arc = this.story.updateOutlineDetails(
          session.projectId,
          arc.id,
          {
            title: plan.arc.title,
            summary: plan.arc.summary,
            goal: plan.arc.goal,
            conflict: plan.arc.conflict,
            outcome: plan.arc.outcome,
            metadata: {
              ...arc.metadata,
              detail: "active",
              sourceRunId: snapshot.run.id,
            },
          },
          now,
        );
      } else {
        arc = this.story.insertOutlineNode(
          createOutlineNode({
            id: `${snapshot.run.id}:arc`,
            projectId: session.projectId,
            parent: volume,
            kind: "arc",
            ordinal: nextOrdinal(volumeChildren, volume.id),
            title: plan.arc.title,
            summary: plan.arc.summary,
            goal: plan.arc.goal,
            conflict: plan.arc.conflict,
            outcome: plan.arc.outcome,
            metadata: { detail: "active", sourceRunId: snapshot.run.id },
            now,
          }),
        );
      }
      const resolveEntity = (ref: {
        kind: "existing" | "proposed";
        id: string;
      }) => (ref.kind === "existing" ? ref.id : bindings.get(ref.id)!);
      const existingChapters = this.story.listOutlineChildren(
        session.projectId,
        arc.id,
      );
      const chapterIds: string[] = [];
      plan.chapters.forEach((chapter, index) => {
        const id = `${snapshot.run.id}:chapter:${index}`;
        const existing = this.story.getOutlineNode(session.projectId, id);
        if (existing) {
          chapterIds.push(existing.id);
          return;
        }
        const node = this.story.insertOutlineNode(
          createOutlineNode({
            id,
            projectId: session.projectId,
            parent: arc!,
            kind: "chapter",
            ordinal: nextOrdinal(existingChapters, arc!.id) + index,
            title: chapter.title,
            summary: chapter.summary,
            goal: chapter.goal,
            conflict: chapter.conflict,
            outcome: chapter.outcome,
            povEntityId: chapter.pov ? resolveEntity(chapter.pov) : null,
            storyTime: chapter.storyTime,
            metadata: {
              hook: chapter.hook,
              sourceRunId: snapshot.run.id,
              planningRationale: plan.rationale,
              plannedEntityIds: [
                ...new Set(
                  [
                    ...chapter.entityRefs,
                    ...(chapter.pov ? [chapter.pov] : []),
                  ].map(resolveEntity),
                ),
              ],
            },
            now,
          }),
        );
        chapterIds.push(node.id);
      });
      let nextArcId: string | null = null;
      if (
        plan.nextArc &&
        !volumeChildren.some(
          (node) =>
            node.kind === "arc" &&
            node.metadata.detail === "skeleton" &&
            node.status !== "abandoned",
        )
      ) {
        const nextId = `${snapshot.run.id}:next-arc`;
        const existing = this.story.getOutlineNode(session.projectId, nextId);
        const nextArc =
          existing ??
          this.story.insertOutlineNode(
            createOutlineNode({
              id: nextId,
              projectId: session.projectId,
              parent: volume,
              kind: "arc",
              ordinal: nextOrdinal(
                this.story.listOutlineChildren(session.projectId, volume.id),
                volume.id,
              ),
              title: plan.nextArc.title,
              summary: plan.nextArc.summary,
              goal: plan.nextArc.goal,
              metadata: { detail: "skeleton", sourceRunId: snapshot.run.id },
              now,
            }),
          );
        nextArcId = nextArc.id;
      }
      const project = this.projects.get(session.projectId);
      if (project && ["idea", "foundation"].includes(project.phase)) {
        this.projects.update({
          ...project,
          phase: "outlining",
          updatedAt: now,
        });
      }
      return { volumeId: volume.id, arcId: arc.id, chapterIds, nextArcId };
    });
    return {
      artifactKind: "rolling-outline-commit",
      output: result,
      usage: zeroUsage(),
    };
  }

  private async classifySteer(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const steerId = policyString(snapshot.run.policy, "steerId");
    const steer = this.automation.requireSteer(steerId);
    const session = steer.sessionId
      ? this.automation.requireSession(steer.sessionId)
      : null;
    const result = await this.model.structured(
      snapshot.run,
      step,
      "steer-classification",
      {
        instructions: instructionsFor(
          this.projects.get(snapshot.run.projectId)?.language ?? null,
          {
            "pt-BR": [
              "Você é o árbitro de steer do harness de produção; classifique só o alcance do impacto e nunca escreva prosa.",
              "Impacto imediato só quando o autor pede explicitamente para parar ou mudar o que está sendo gerado; qualquer toque em prosa ou cânone já existentes sobe o risco.",
              "A saída escolhe exatamente uma classificação e o limite seguro mais cedo em que ela vale.",
            ],
            en: [
              "You are the steer arbitrator of the novel production harness; classify impact scope only and never write prose.",
              "Immediate impact applies only when the author explicitly asks to stop or change content being generated; anything touching existing prose or canon raises the risk.",
              "The output must choose exactly one classification and the earliest safe effective boundary.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: `Estado da execução: ${session?.status ?? "sem sessão"}\nSteer do autor: ${steer.content}`,
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: 1_200,
      },
      STEER_CLASSIFICATION_CONTRACT,
      automationValidator(SteerClassificationResultSchema),
      signal,
    );
    const classified = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      return this.automation.classifySteer(steer.id, {
        ...result.value,
        now: this.now().toISOString(),
      });
    });
    return {
      artifactKind: "steer-classification",
      output: {
        steerId: classified.id,
        classification: classified.classification,
        effectiveBoundary: classified.effectiveBoundary,
        rationale: classified.rationale,
        risk: classified.risk,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private reviewArc(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    return this.reviewScope(snapshot, step, signal, "arc");
  }

  private reviewVolume(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    return this.reviewScope(snapshot, step, signal, "volume");
  }

  private async reviewScope(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
    scopeType: "arc" | "volume",
  ): Promise<StepExecutionResult> {
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const nodeId = policyString(
      snapshot.run.policy,
      scopeType === "arc" ? "arcId" : "volumeId",
    );
    const node = this.story.requireOutlineNode(snapshot.run.projectId, nodeId);
    if (node.kind !== scopeType) {
      throw permanent(
        "planning_review.scope.invalid",
        `Planning review target kind ${node.kind} is not ${scopeType}`,
      );
    }
    const baselineCompass = this.automation.getCompass(snapshot.run.projectId);
    const evidenceBaseline = storyLineReviewEvidence(
      this.database,
      snapshot.run.projectId,
      node.id,
    );
    const evidence = evidenceBaseline.evidence;
    const source = JSON.stringify(evidence);
    const contextWindow =
      this.model.effectiveContextWindow?.(
        snapshot.run,
        `${scopeType}-review`,
      ) ?? 64_000;
    const outputReserve = Math.min(
      4_000,
      this.model.effectiveOutputLimit?.(snapshot.run, `${scopeType}-review`) ??
        4_000,
      Math.floor(contextWindow * 0.4),
    );
    const compiled = new ContextCompiler(this.now).compile({
      projectId: snapshot.run.projectId,
      purpose: `${scopeType}-review`,
      budget: {
        contextWindow,
        outputReserve,
        fixedInstructionReserve: 1_000,
        schemaReserve: 1_000,
        toolReserve: 0,
      },
      sources: [
        {
          id: "review-task",
          kind: "task",
          label: "Alcance da retrospectiva e direção do livro",
          authority: "locked",
          priority: 100,
          required: true,
          compressible: false,
          sourceType: "outline_node",
          sourceId: node.id,
          content: JSON.stringify({
            scope: node.title,
            compass: baselineCompass,
          }),
        },
        ...evidence.map((chapter, index): ContextSource => ({
          id: `review-chapter:${chapter.chapterId}`,
          kind: "summary",
          label: chapter.title,
          content: JSON.stringify(chapter),
          authority: "confirmed",
          compressible: false,
          priority: 60 + 30 * ((index + 1) / evidence.length),
          sourceType: "outline_node",
          sourceId: chapter.chapterId,
        })),
      ],
    });
    new SqliteContextReceiptRepository(this.database).insert(compiled.receipt, {
      runId: snapshot.run.id,
      stepId: step.id,
    });
    const result = await this.model.structured(
      snapshot.run,
      step,
      `${scopeType}-review`,
      {
        instructions: instructionsFor(
          this.projects.get(snapshot.run.projectId)?.language ?? null,
          {
            "pt-BR": [
              `Você é o editor de recap de ${scopeType === "arc" ? "arco" : "volume"} de um romance.`,
              "A partir dos resumos de capítulo, avalie cumprimento de promessas, causalidade, arcos de personagem, ritmo e continuidade. As sugestões servem à próxima janela rolante e nunca reescrevem fatos já registrados.",
              "Isto recapita o que já foi escrito, não pressupõe o fim do arco, do volume ou do livro. Distinga promessas cumpridas, em curso e a tratar depois; não peça desfecho nem colha todas as sementes só porque esta execução acabou. Julgue só pelos resumos dados e deixe claro o que falta de evidência.",
              "Compare objetivos de estágio das linhas longas, notas de andamento do autor e promessas em aberto com os resumos. Aponte mudanças com apoio no resumo e sugestões para o estágio seguinte. A nota do autor não é evidência de prosa, e nextDevelopment planejado ainda não aconteceu; devolva ajustes só como compassAdjustments, sem alterar as linhas automaticamente.",
              "lineProposals são sugestões para o autor aceitar ou recusar uma a uma. lineIndex é o índice zero-based de compass.longLines; no máximo uma por linha. evidenceChapterIds só cita chapterId realmente fornecidos. progress resume o andamento com apoio no resumo, openPromises guarda o que ainda não cumpriu, nextDevelopment é só direção futura. Nunca sugira resolved só porque o estágio acabou. Sem evidência válida, devolva array vazio.",
            ],
            en: [
              `You are the retrospective editor of a long-form novel ${scopeType === "arc" ? "story arc" : "volume"}.`,
              "Assess promise fulfillment, causality, character arcs, pacing, and continuity from chapter summaries. Suggestions serve the next rolling window and never rewrite committed facts.",
              "This reviews progress so far, not an assumed arc, volume, or book ending. Distinguish fulfilled promises, ongoing developments, and future work. Do not demand an ending or resolve every setup because this run is over. State evidence limitations when summaries are insufficient.",
              "Compare long-line stage goals, author progress notes, and open promises with the supplied summaries. Identify supported changes and possible next developments. Author notes are not manuscript evidence, and planned nextDevelopment has not happened. Return adjustments as compassAdjustments suggestions without updating story lines.",
              "Return lineProposals for individual author decisions. lineIndex is the zero-based compass.longLines index; at most one proposal per line. evidenceChapterIds may only reference chapterId values actually supplied. progress records supported developments, openPromises retains outstanding promises, and nextDevelopment is future direction. Never suggest resolved merely because this stage ends. Return an empty array without valid evidence.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: compiled.text,
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: outputReserve,
      },
      PLANNING_REVIEW_CONTRACT,
      automationValidator(PlanningReviewResultSchema, (value) =>
        storyLineProposalIssues(
          value.lineProposals,
          baselineCompass?.longLines.length ?? 0,
          new Set(
            compiled.sections
              .filter((section) => section.id.startsWith("review-chapter:"))
              .map((section) => section.sourceId!),
          ),
        ),
      ),
      signal,
    );
    const now = this.now().toISOString();
    const sourceHash = sha256(source);
    this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      if (result.value.lineProposals.length && baselineCompass) {
        if (
          this.automation.getCompass(snapshot.run.projectId)?.version !==
            baselineCompass.version ||
          storyLineReviewEvidence(
            this.database,
            snapshot.run.projectId,
            node.id,
          ).fingerprint !== evidenceBaseline.fingerprint
        ) {
          throw permanent(
            "story_line_proposal.stale",
            "The compass or evidence changed while reviewing",
          );
        }
        new SqliteReviewRepository(this.database).insertCanonChangeSet({
          id: `${step.id}:story-lines`,
          projectId: snapshot.run.projectId,
          runId: snapshot.run.id,
          stepId: step.id,
          changes: StoryLineProposalChangesSchema.parse({
            kind: "story_line_progress",
            scopeNodeId: node.id,
            compass: StoryCompassSchema.parse(baselineCompass),
            evidenceFingerprint: evidenceBaseline.fingerprint,
            evidence: evidence.filter((chapter) =>
              compiled.sections.some(
                (section) => section.sourceId === chapter.chapterId,
              ),
            ),
            items: result.value.lineProposals,
          }),
          status: "candidate",
          createdAt: now,
        });
      }
      this.automation.insertPlanningReview({
        id: step.id,
        projectId: snapshot.run.projectId,
        sessionId,
        runId: snapshot.run.id,
        scopeType,
        outlineNodeId: node.id,
        summary: result.value.summary,
        scores: result.value.scores,
        recommendations: result.value.recommendations,
        sourceHash,
        createdAt: now,
      });
      this.state.upsertSummary({
        id: `${step.id}:summary`,
        projectId: snapshot.run.projectId,
        scopeType,
        scopeId: node.id,
        summary: result.value.summary,
        stateDelta: {
          recommendations: result.value.recommendations,
          compassAdjustments: result.value.compassAdjustments,
        },
        sourceHash,
        createdAt: now,
      });
    });
    return {
      artifactKind: `${scopeType}-review`,
      output: {
        ...result.value,
        outlineNodeId: node.id,
        sourceHash,
        generation: { mode: result.mode, attempts: result.attempts },
        contextReceiptId: compiled.receipt.id,
      },
      usage: result.usage,
    };
  }
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Record<string, unknown> {
  const artifact = snapshot.steps.find(
    (step) => step.kind === kind && step.status === "succeeded",
  )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing ${kind} artifact`);
  return { ...artifact };
}

function compactOutline(node: OutlineNode) {
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    status: node.status,
    metadata: node.metadata,
  };
}

function nextOrdinal(nodes: readonly OutlineNode[], parentId: string): number {
  return (
    Math.max(
      -1,
      ...nodes
        .filter((node) => node.parentId === parentId)
        .map((node) => node.ordinal),
    ) + 1
  );
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

function policyRecord(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = policy[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function policyNumber(
  policy: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
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

function sha256(value: string): string {
  return sha256Hex(value);
}

function permanent(code: string, message: string) {
  return { code, message, retryable: false };
}
