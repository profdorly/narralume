import {
  canonContextSources,
  ContextCompiler,
  type ContextSource,
} from "@lapis/context";
import type { CanonAccess } from "@lapis/domain";
import {
  RETRIEVAL_LIMIT,
  RETRIEVAL_MAX_PER_DOCUMENT,
  retrievalContextSources,
} from "@lapis/narrative";
import {
  SqliteCanonRepository,
  SqliteContextReceiptRepository,
  SqliteManuscriptIndexer,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

export interface StoryContextPreviewInput {
  projectId: string;
  purpose: string;
  task: string;
  query: string;
  entityIds: readonly string[];
  currentOutlineNodeId: string | null;
  access: CanonAccess;
  budget: {
    contextWindow: number;
    outputReserve: number;
    fixedInstructionReserve: number;
    toolReserve: number;
    schemaReserve: number;
    safetyReserve?: number;
  };
}

const PREVIEW_COPY = {
  "pt-BR": {
    task: "Tarefa desta rodada",
    intent: "Intenção da autoria",
    outline: "Outline relacionado",
    promise: "Promessa central",
    themes: "Temas",
    audience: "Público",
    tone: "Tom",
    boundaries: "Limites",
    ending: "Direção do desfecho",
    focus: "Foco atual",
  },
  en: {
    task: "Task for this turn",
    intent: "Author intent",
    outline: "Related outline",
    promise: "Core promise",
    themes: "Themes",
    audience: "Audience",
    tone: "Tone",
    boundaries: "Boundaries",
    ending: "Ending direction",
    focus: "Current focus",
  },
} as const;

/**
 * The context an AI task would receive for a free-form request, compiled
 * without a model call (lexical and entity retrieval only). Labels follow
 * the project's writing language, like the prompts themselves.
 */
export class StoryContextPreviewService {
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly retrieval: SqliteRetrievalRepository;
  private readonly indexer: SqliteManuscriptIndexer;
  private readonly receipts: SqliteContextReceiptRepository;
  private readonly compiler = new ContextCompiler();

  constructor(database: NarrativeDatabase) {
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.retrieval = new SqliteRetrievalRepository(database);
    this.indexer = new SqliteManuscriptIndexer(database);
    this.receipts = new SqliteContextReceiptRepository(database);
  }

  compile(input: StoryContextPreviewInput) {
    const language = this.projects.get(input.projectId)?.language ?? null;
    const copy = PREVIEW_COPY[language === "en" ? "en" : "pt-BR"];
    const sources: ContextSource[] = [
      {
        id: "task:current",
        kind: "task",
        label: copy.task,
        content: input.task,
        authority: "locked",
        priority: 100,
        required: true,
        compressible: false,
        sourceType: "request",
      },
    ];
    const intent = this.story.getAuthorIntent(input.projectId);
    if (intent) {
      const lines = [
        intent.promise && `${copy.promise}: ${intent.promise}`,
        intent.themes.length && `${copy.themes}: ${intent.themes.join(", ")}`,
        intent.audience && `${copy.audience}: ${intent.audience}`,
        intent.tone && `${copy.tone}: ${intent.tone}`,
        intent.boundaries.length &&
          `${copy.boundaries}: ${intent.boundaries.join("; ")}`,
        intent.endingDirection && `${copy.ending}: ${intent.endingDirection}`,
        intent.currentFocus && `${copy.focus}: ${intent.currentFocus}`,
      ].filter((line): line is string => Boolean(line));
      if (lines.length) {
        sources.push({
          id: "author-intent",
          kind: "author-intent",
          label: copy.intent,
          content: lines.join("\n"),
          authority: "locked",
          priority: 95,
          required: true,
          compressible: false,
          sourceType: "author_intent",
          sourceId: input.projectId,
        });
      }
    }

    const outline = this.story.listOutline(input.projectId);
    const activeOutline = input.currentOutlineNodeId
      ? outline.filter(
          (node) =>
            node.id === input.currentOutlineNodeId ||
            input.currentOutlineNodeId?.startsWith(`${node.id}/`) ||
            outline
              .find((candidate) => candidate.id === input.currentOutlineNodeId)
              ?.path.startsWith(`${node.path}/`),
        )
      : outline;
    if (activeOutline.length) {
      const outlineText = activeOutline
        .map(
          (node) =>
            `${"  ".repeat(node.depth)}- [${node.kind}] ${node.title}${node.summary ? `: ${node.summary}` : ""}`,
        )
        .join("\n");
      sources.push({
        id: "outline:active",
        kind: "outline",
        label: copy.outline,
        content: outlineText,
        authority: "confirmed",
        priority: 85,
        sourceType: "outline",
        sourceId: input.currentOutlineNodeId ?? input.projectId,
      });
    }

    sources.push(
      ...canonContextSources(
        this.canon.listEntities(input.projectId),
        this.canon.listEffectiveFacts(input.projectId, {
          ...(input.access.includeCandidates === undefined
            ? {}
            : { includeCandidates: input.access.includeCandidates }),
        }),
        input.access,
      ),
    );

    this.indexer.syncProject(input.projectId, new Date().toISOString());
    sources.push(
      ...retrievalContextSources(
        this.retrieval.search(input.projectId, input.query, {
          entityIds: input.entityIds,
          limit: RETRIEVAL_LIMIT,
          maxPerDocument: RETRIEVAL_MAX_PER_DOCUMENT,
        }),
        {
          idPrefix: "retrieval",
          language,
          priorityBase: 58,
          authority: (hit) =>
            hit.authority === "locked"
              ? "locked"
              : hit.authority === "confirmed"
                ? "confirmed"
                : "reference",
        },
      ),
    );

    const compiled = this.compiler.compile({
      projectId: input.projectId,
      purpose: input.purpose,
      budget: input.budget,
      sources,
    });
    this.receipts.insert(compiled.receipt);
    return compiled;
  }
}
