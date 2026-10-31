import type {
  NarrativeRunStep,
  RunBudgetUsage,
  RunSnapshot,
} from "@lapis/domain";
import { assistantToolAccess, type AssistantToolName } from "@lapis/contracts";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@lapis/harness";
import {
  SqliteAssistantRepository,
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

import { instructionsFor, promptLanguageOf } from "./prompt-language.js";
import type { NarrativeModelClient } from "./model-client.js";
import {
  ASSISTANT_REPLY_CONTRACT,
  AssistantReplyArtifactSchema,
  assistantReplyValidator,
  type AssistantReply,
  type AssistantToolCall,
} from "./assistant-schemas.js";
import { requireActiveProject } from "./project-guard.js";

interface AssistantContextArtifact extends Readonly<Record<string, unknown>> {
  conversationId: string;
  userMessageId: string;
  context: string;
  allowedTools: readonly AssistantToolDescriptor[];
  chapterIds: readonly string[];
  documentIds: readonly string[];
  controllableSources: readonly string[];
}

interface AssistantToolDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly access: "read" | "auto" | "confirm";
}

export class AssistantWorkerSuite {
  private readonly assistants: SqliteAssistantRepository;
  private readonly automation: SqliteAutomationRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly narrativeState: SqliteNarrativeStateRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly runs: SqliteRunRepository;
  private readonly story: SqliteStoryRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.assistants = new SqliteAssistantRepository(database);
    this.automation = new SqliteAutomationRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.narrativeState = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
  }

  registry(): WorkerRegistry {
    return {
      "assistant.context": this.worker(this.compileContext.bind(this)),
      "assistant.respond": this.worker(this.respond.bind(this)),
      "assistant.stage": this.worker(this.stage.bind(this)),
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

  private async compileContext(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const conversationId = policyString(
      snapshot.run.policy,
      "assistantConversationId",
    );
    const userMessageId = policyString(
      snapshot.run.policy,
      "assistantUserMessageId",
    );
    const conversation = this.assistants.requireConversation(conversationId);
    const userMessage = this.assistants.requireMessage(userMessageId);
    if (
      conversation.projectId !== snapshot.run.projectId ||
      userMessage.conversationId !== conversation.id ||
      userMessage.role !== "user"
    ) {
      throw permanent(
        "assistant.context.mismatch",
        "Assistant conversation, message, and current project do not match",
      );
    }

    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const outline = this.story.listOutline(project.id);
    const entities = this.canon.listEntities(project.id);
    const entityNames = new Map(
      entities.map((entity) => [entity.id, entity.name]),
    );
    const facts = this.canon.listEffectiveFacts(project.id);
    const relationships = this.narrativeState.listCurrentRelationships(
      project.id,
    );
    const timeline = this.narrativeState.listTimeline(project.id);
    const foreshadows = this.narrativeState.listForeshadows(project.id);
    const documents = this.documents.list(project.id);
    const activeRuns = this.runs
      .listActiveRuns(project.id)
      .filter((run) => run.recipe !== "assistant-turn");
    const activeSessions = this.automation
      .listSessions(project.id)
      .filter((session) => !isTerminalSessionStatus(session.status));
    const allowedTools = policyToolDescriptors(snapshot.run.policy);
    const selectedDocument = userMessage.context?.documentId
      ? this.documents.get(project.id, userMessage.context.documentId)
      : null;
    const selectedVersion = selectedDocument?.currentVersionId
      ? this.documents.getVersion(
          project.id,
          selectedDocument.id,
          selectedDocument.currentVersionId,
        )
      : null;
    const messages = this.assistants.listMessages(conversation.id);
    const triggerIndex = messages.findIndex(
      (message) => message.id === userMessage.id,
    );
    const recentMessages = messages
      .slice(Math.max(0, triggerIndex - 15), triggerIndex + 1)
      .map((message) => ({
        role: message.role,
        content: clipText(message.content, 8_000),
        context: message.context,
      }));
    const chapterNumbers = new Map(
      outline
        .filter((node) => node.kind === "chapter")
        .map((node, index) => [node.id, index + 1]),
    );

    const packet = {
      project: {
        id: project.id,
        title: project.title,
        subtitle: project.subtitle,
        premise: project.premise,
        language: project.language,
        phase: project.phase,
      },
      currentContext: userMessage.context,
      authorIntent: this.story.getAuthorIntent(project.id),
      outline: outline.slice(0, 160).map((node) => {
        const chapterNumber = chapterNumbers.get(node.id);
        return {
          id: node.id,
          parentId: node.parentId,
          kind: node.kind,
          ...(chapterNumber
            ? {
                chapterNumber,
                displayLabel:
                  promptLanguageOf(project.language) === "en"
                    ? `Chapter ${chapterNumber}`
                    : `Capítulo ${chapterNumber}`,
              }
            : {}),
          title: node.title,
          summary: node.summary,
          goal: node.goal,
          conflict: node.conflict,
          outcome: node.outcome,
          status: node.status,
        };
      }),
      canon: {
        entities: entities.slice(0, 160).map((entity) => ({
          id: entity.id,
          type: entity.type,
          name: entity.name,
          aliases: entity.aliases,
          description: entity.description,
          attributes: entity.attributes,
        })),
        facts: facts.slice(0, 240).map((fact) => ({
          id: fact.id,
          subject: entityNames.get(fact.subjectId) ?? fact.subjectId,
          predicate: fact.predicate,
          object: fact.objectEntityId
            ? (entityNames.get(fact.objectEntityId) ?? fact.objectEntityId)
            : fact.value,
          authority: fact.authority,
          validFromNodeId: fact.validFromNodeId,
          validToNodeId: fact.validToNodeId,
        })),
        relationships: relationships.slice(0, 160).map((relationship) => ({
          from:
            entityNames.get(relationship.fromEntityId) ??
            relationship.fromEntityId,
          to:
            entityNames.get(relationship.toEntityId) ?? relationship.toEntityId,
          relation: relationship.relation,
          intensity: relationship.intensity,
          state: relationship.state,
        })),
        timeline: timeline.slice(0, 160).map((event) => ({
          id: event.id,
          title: event.title,
          description: event.description,
          outlineNodeId: event.outlineNodeId,
          storyTimeStart: event.storyTimeStart,
          storyTimeEnd: event.storyTimeEnd,
          participants: event.participants.map(
            (id) => entityNames.get(id) ?? id,
          ),
        })),
        foreshadows: foreshadows.slice(0, 160).map((foreshadow) => ({
          id: foreshadow.id,
          title: foreshadow.title,
          description: foreshadow.description,
          status: foreshadow.status,
          importance: foreshadow.importance,
          targetFromNodeId: foreshadow.targetFromNodeId,
          targetToNodeId: foreshadow.targetToNodeId,
          resolutionNodeId: foreshadow.resolutionNodeId,
        })),
        totals: {
          entities: entities.length,
          facts: facts.length,
          relationships: relationships.length,
          timeline: timeline.length,
          foreshadows: foreshadows.length,
        },
      },
      documents: documents.slice(0, 120).map((document) => ({
        id: document.id,
        kind: document.kind,
        title: document.title,
        outlineNodeId: document.outlineNodeId,
        currentVersionId: document.currentVersionId,
      })),
      selectedDocument: selectedDocument
        ? {
            id: selectedDocument.id,
            title: selectedDocument.title,
            kind: selectedDocument.kind,
            outlineNodeId: selectedDocument.outlineNodeId,
            content: selectedVersion
              ? clipText(selectedVersion.content, 24_000)
              : null,
          }
        : null,
      conversation: recentMessages,
      activeTasks: {
        runs: activeRuns.map((run) => ({
          id: run.id,
          recipe: run.recipe,
          status: run.status,
          targetOutlineNodeId: run.targetOutlineNodeId,
          availableActions: runControlActions(run.status),
        })),
        autopilot: activeSessions.map((session) => ({
          id: session.id,
          status: session.status,
          mode: session.mode,
          completedChapters: session.completedChapters,
          targetChapters: session.targetChapters,
          availableActions: sessionControlActions(session.status),
        })),
      },
      allowedTools: allowedTools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        access: tool.access,
      })),
    };
    const controllableSources = [
      ...activeRuns.flatMap((run) =>
        runControlActions(run.status).map(
          (action) => `run:${run.id}:${action}`,
        ),
      ),
      ...activeSessions.flatMap((session) =>
        sessionControlActions(session.status).map(
          (action) => `autopilot:${session.id}:${action}`,
        ),
      ),
    ];
    return {
      artifactKind: "assistant-context",
      output: {
        conversationId,
        userMessageId,
        context: JSON.stringify(packet),
        allowedTools,
        chapterIds: outline
          .filter((node) => node.kind === "chapter")
          .map((node) => node.id),
        documentIds: documents.map((document) => document.id),
        controllableSources,
      } satisfies AssistantContextArtifact,
      usage: zeroUsage(),
    };
  }

  private async respond(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const context = assistantContextArtifact(
      requiredArtifact(snapshot, "assistant.context"),
    );
    /* The reasoning tier comes from the conversation settings (optional policy
       field): off = send no parameter and let the model decide; when unset,
       keep the old default of low. Reasoning tokens consume the output budget,
       so a higher tier raises the output limit accordingly. */
    const effort = snapshot.run.policy.assistantReasoningEffort;
    const effortCeiling: Record<"off" | "low" | "medium" | "high", number> = {
      off: 8_000,
      low: 8_000,
      medium: 16_000,
      high: 24_000,
    };
    const effectiveEffort =
      effort === "off" ||
      effort === "low" ||
      effort === "medium" ||
      effort === "high"
        ? effort
        : "low";
    const result = await this.model.structured(
      snapshot.run,
      step,
      "project-assistant",
      {
        instructions: instructionsFor(
          this.projects.get(snapshot.run.projectId)?.language ?? null,
          {
            "pt-BR": [
              "Você é o assistente colaborativo de um projeto de romance de longo fôlego. Responda ao autor em português brasileiro claro e natural, tratando os dados da obra como única fonte de fatos.",
              "Separe com clareza os fatos já existentes, as suas sugestões e as operações ainda não executadas; nunca afirme que uma tarefa aconteceu se não aconteceu.",
              "Proponha no máximo uma chamada de ferramenta por resposta, escolhida apenas em allowedTools; nomes e argumentos das ferramentas devem coincidir exatamente — nunca invente ferramentas, argumentos, IDs de capítulo, IDs de documento ou IDs de tarefa.",
              "A numeração dos capítulos segue sempre chapterNumber e displayLabel no outline, a partir de 1; id e parentId são identificadores internos opacos — nunca infira o número do capítulo a partir deles.",
              "As ferramentas se organizam por access: read responde direto com o material já no contexto (toolCall fica null); auto cobre geração de candidatos ou controle de tarefa e executa na hora quando o pedido é explícito, sem confirmação extra; confirm abre primeiro um cartão pendente para o autor decidir. Adoção de prosa, adoção de cânone e exclusão permanente ficam fora da superfície de ferramentas — o autor sempre confirma isso nas telas dedicadas.",
              "Identifique o objetivo final do autor, em vez de tratar só as pré-condições que faltam. Quando pedem escrita ou prosa e ainda não há outline de capítulos, use long_goal.start para encadear o outline e a prosa; passe braindump como null quando a direção da história já existir. Use outline.plan.start somente quando pedirem outline ou planejamento, sem prosa. Nunca inicie uma tarefa só de planejamento e depois afirme que a escrita continuará sozinha.",
              "O material de story.inspect / review.inspect já está no contexto; deixe toolCall em null quando puder responder direto. Proponha chamada de ferramenta só quando pedirem uma ação explícita — não em discussão, pergunta ou pedido de opinião.",
              "Nas respostas, não emita JSON, cercas de código nem detalhes internos de implementação.",
            ],
            en: [
              "You are the collaborative assistant of a long-form novel project. Answer the author concisely and naturally in English, treating the provided work data as the single source of truth.",
              "Clearly separate facts that already exist, your suggestions, and operations not yet performed; never claim a task happened when it did not.",
              "Propose at most one tool call per reply, chosen only from allowedTools; tool names and arguments must match exactly - never invent tools, arguments, chapter IDs, document IDs, or task IDs.",
              "Chapter numbers always follow chapterNumber and displayLabel in the outline, starting from 1; id and parentId are opaque internal identifiers - never infer chapter numbers from them.",
              "Tools are tiered by access: read answers directly from material already in context (set toolCall to null); auto covers candidate generation or task control and runs immediately when the user clearly requests it without an extra confirmation; confirm first shows a pending card for the author to decide. Prose adoption, canon adoption, and permanent deletion are outside the tool surface - the author always confirms them in their dedicated views.",
              "Identify the author's final goal instead of only handling missing preconditions. When the author asks for writing or prose but no chapter outline exists yet, use long_goal.start to chain outlining and prose writing; pass braindump as null once a story direction exists. Use outline.plan.start only when the author explicitly wants outline or planning only, with no prose. Never start a planning-only task and then claim writing will continue automatically.",
              "Material for story.inspect / review.inspect is already included in the context; set toolCall to null when you can answer directly. Propose tool calls only when the user explicitly requests an action - not for discussion, questions, or advice.",
              "Do not output JSON, code fences, or internal implementation details in replies.",
            ],
          },
        ),
        messages: [{ role: "user", content: context.context }],
        ...(effectiveEffort === "off"
          ? {}
          : { reasoningEffort: effectiveEffort }),
        maxOutputTokens: Math.max(
          policyNumber(snapshot.run.policy, "assistantMaxOutputTokens", 3_000),
          effortCeiling[effectiveEffort],
        ),
      },
      ASSISTANT_REPLY_CONTRACT,
      assistantReplyValidator((reply) => validateToolCall(reply, context)),
      signal,
    );
    return {
      artifactKind: "assistant-reply",
      output: {
        ...result.value,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stage(snapshot: RunSnapshot): Promise<StepExecutionResult> {
    const context = assistantContextArtifact(
      requiredArtifact(snapshot, "assistant.context"),
    );
    const reply = AssistantReplyArtifactSchema.parse(
      requiredArtifact(snapshot, "assistant.respond"),
    );
    const userMessage = this.assistants.requireMessage(context.userMessageId);
    const now = this.now().toISOString();
    const assistantMessageId = `${snapshot.run.id}:assistant`;
    const activityId = reply.toolCall ? `${snapshot.run.id}:tool` : null;
    const toolCall = reply.toolCall;
    const access = toolCall ? assistantToolAccess(toolCall.name) : null;
    const stagedActivityId = access === "read" ? null : activityId;
    const executionMode = access === "read" ? null : access;
    this.database.transaction(() => {
      this.assistants.insertMessage({
        id: assistantMessageId,
        conversationId: context.conversationId,
        role: "assistant",
        content: reply.reply,
        context: userMessage.context,
        sourceRunId: snapshot.run.id,
        replyToMessageId: userMessage.id,
        createdAt: now,
      });
      if (toolCall && stagedActivityId) {
        // auto: candidate generation or task control is dispatched directly,
        // with no extra confirmation card;
        // confirm: keep the pending-confirmation card for the author to execute
        // explicitly.
        const status = access === "auto" ? "running" : "proposed";
        this.assistants.insertActivity({
          id: stagedActivityId,
          conversationId: context.conversationId,
          messageId: assistantMessageId,
          kind: "tool_proposal",
          toolName: toolCall.name,
          status,
          goal: toolGoal(toolCall),
          input: toolCall.arguments,
          result: null,
          error: null,
          sourceType: null,
          sourceId: null,
          origin: userMessage.context,
          executionMode,
          skillId: null,
          phaseKey: null,
          artifacts: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    return {
      artifactKind: "assistant-staged",
      output: {
        conversationId: context.conversationId,
        messageId: assistantMessageId,
        activityId: stagedActivityId,
        executionMode,
      },
      usage: zeroUsage(),
    };
  }
}

function validateToolCall(
  reply: AssistantReply,
  context: AssistantContextArtifact,
): string[] {
  const call = reply.toolCall;
  if (!call) return [];
  const issues: string[] = [];
  if (!context.allowedTools.some((tool) => tool.name === call.name)) {
    issues.push(
      `toolCall.name: ${call.name} não está na lista permitida pelo servidor`,
    );
  }
  if (
    call.name === "chapter.start" &&
    !context.chapterIds.includes(call.arguments.targetOutlineNodeId)
  ) {
    issues.push(
      "toolCall.arguments.targetOutlineNodeId: não é um capítulo desta obra",
    );
  }
  if (
    call.name === "selection.edit.start" &&
    (!context.documentIds.includes(call.arguments.documentId) ||
      call.arguments.selectionEnd <= call.arguments.selectionStart)
  ) {
    issues.push(
      "toolCall.arguments.documentId/selection: não é uma seleção válida desta obra",
    );
  }
  if (
    call.name === "task.control" &&
    !context.controllableSources.includes(
      `${call.arguments.sourceType}:${call.arguments.sourceId}:${call.arguments.action}`,
    )
  ) {
    issues.push(
      "toolCall.arguments.sourceId: não é uma tarefa controlável desta obra",
    );
  }
  return issues;
}

function assistantContextArtifact(
  value: Readonly<Record<string, unknown>>,
): AssistantContextArtifact {
  const conversationId = stringField(value, "conversationId");
  const userMessageId = stringField(value, "userMessageId");
  const context = stringField(value, "context");
  return {
    conversationId,
    userMessageId,
    context,
    allowedTools: toolDescriptorArray(value.allowedTools),
    chapterIds: stringArray(value.chapterIds),
    documentIds: stringArray(value.documentIds),
    controllableSources: stringArray(value.controllableSources),
  };
}

function toolDescriptorArray(value: unknown): AssistantToolDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      // In old artifacts allowedTools is just an array of tool names; rebuild
      // the descriptions from the default policy.
      const access = assistantToolAccess(entry as AssistantToolName);
      return [{ name: entry, label: entry, description: "", access }];
    }
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Readonly<Record<string, unknown>>;
    const name = record.name;
    if (typeof name !== "string" || !name.trim()) return [];
    const access = assistantToolAccess(name as AssistantToolName);
    return [
      {
        name,
        label: typeof record.label === "string" ? record.label : name,
        description:
          typeof record.description === "string" ? record.description : "",
        access,
      },
    ];
  });
}

/** Machine code for the goal of a tool activity card: stored in the database;
 *  the display text is rendered by the frontend label table. Numeric parameters
 *  (targetChapters) are extracted from input by the projection layer for
 *  interpolation. */
function toolGoal(call: AssistantToolCall): string {
  if (call.name === "foundation.start") return "tool.goal.foundation.start";
  if (call.name === "chapter.start") return "tool.goal.chapter.start";
  if (call.name === "autopilot.start") return "tool.goal.autopilot.start";
  if (call.name === "outline.plan.start") return "tool.goal.outline.plan.start";
  if (call.name === "canon.candidate.start") {
    return `tool.goal.canon.candidate.start.${call.arguments.spread}`;
  }
  if (call.name === "selection.edit.start")
    return "tool.goal.selection.edit.start";
  if (call.name === "long_goal.start") return "tool.goal.long_goal.start";
  if (call.name === "task.control") {
    return `tool.goal.task.control.${call.arguments.action}`;
  }
  return "tool.goal.info";
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Readonly<Record<string, unknown>> {
  const artifact = [...snapshot.steps]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === kind && candidate.status === "succeeded",
    )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing artifact for step ${kind}`);
  return artifact;
}

function policyString(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = policy[key];
  if (typeof value !== "string" || !value.trim()) {
    throw permanent("policy.value.invalid", `Run policy is missing ${key}`);
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

function policyToolDescriptors(
  policy: Readonly<Record<string, unknown>>,
): readonly AssistantToolDescriptor[] {
  return toolDescriptorArray(policy.assistantTools);
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = value[key];
  if (typeof entry !== "string" || !entry.trim()) {
    throw permanent("artifact.value.invalid", `Artifact is missing ${key}`);
  }
  return entry;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n\n[trecho intermediário omitido]\n\n";
  const available = Math.max(0, limit - marker.length);
  const head = Math.floor(available * 0.68);
  const tail = available - head;
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function isTerminalSessionStatus(status: string): boolean {
  return ["completed", "cancelled"].includes(status);
}

function runControlActions(
  status: string,
): Array<"pause" | "resume" | "cancel"> {
  if (status === "pending" || status === "running") return ["pause", "cancel"];
  if (status === "paused") return ["resume", "cancel"];
  if (status === "awaiting_user" || status === "failed_recoverable") {
    return ["cancel"];
  }
  return [];
}

function sessionControlActions(
  status: string,
): Array<
  | "pause"
  | "resume"
  | "cancel"
  | "retry-current"
  | "skip-chapter"
  | "replan"
  | "stop"
> {
  if (status === "pending" || status === "planning" || status === "running") {
    return ["pause", "cancel"];
  }
  if (status === "paused") return ["resume", "cancel"];
  if (status === "failed") {
    return ["retry-current", "skip-chapter", "replan", "stop"];
  }
  return [];
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

function permanent(code: string, message: string): Error {
  const error = new Error(message) as Error & {
    code: string;
    retryable: boolean;
  };
  error.code = code;
  error.retryable = false;
  return error;
}
