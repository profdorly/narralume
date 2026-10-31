import type { ProjectLanguage } from "@lapis/contracts";
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
import {
  SqliteDeliveryRepository,
  SqliteProjectRepository,
  type NarrativeDatabase,
} from "@lapis/persistence";

import {
  detectManuscriptLanguage,
  manuscriptLanguageHint,
  type DetectedManuscriptLanguage,
} from "./manuscript-language.js";
import type { NarrativeModelClient } from "./model-client.js";
import { documentCandidateAt, importSourceText } from "./import-evidence.js";
import { instructionsFor, promptLanguageOf } from "./prompt-language.js";
import { ParagraphLocator } from "./paragraph-locator.js";
import {
  requireActiveProject,
  requireActiveRunCommit,
} from "./project-guard.js";
import {
  deliveryValidator,
  IMPORT_ANALYSIS_CONTRACT,
  ImportAnalysisSchema,
  STYLE_PROFILE_CONTRACT,
  StyleSchema,
  type ImportAnalysis,
} from "./delivery-schemas.js";

export class DeliveryWorkerSuite {
  private readonly delivery: SqliteDeliveryRepository;
  private readonly projects: SqliteProjectRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.delivery = new SqliteDeliveryRepository(database);
    this.projects = new SqliteProjectRepository(database);
  }

  registry(): WorkerRegistry {
    return {
      "import.analyze": this.worker(this.analyzeImport.bind(this)),
      "import.stage": this.worker(this.stageAnalysis.bind(this)),
      "style.extract": this.worker(this.extractStyle.bind(this)),
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

  private async analyzeImport(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const batchId = policyString(snapshot.run.policy, "batchId");
    const batch = this.delivery.requireImportBatch(batchId);
    requireAnalysisOwnership(batch, snapshot.run.id);
    if (batch.targetProjectId !== snapshot.run.projectId) {
      throw permanent(
        "import.project.mismatch",
        "The import batch does not belong to the current project",
      );
    }
    if (batch.format === "narrative-bundle") {
      throw permanent(
        "import.bundle.analysis_not_needed",
        "A full project bundle already contains structured data and does not need analysis again",
      );
    }
    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const documents = this.importedText(batchId);
    if (!documents.trim()) {
      throw permanent(
        "import.content.empty",
        "There is no manuscript content for AI analysis",
      );
    }
    const chunkCharacters = Math.max(
      10_000,
      Math.min(
        policyNumber(snapshot.run.policy, "importChunkCharacters", 60_000),
        120_000,
      ),
    );
    const locator = new ParagraphLocator(documents);
    const chunks = splitImportParagraphs(locator, chunkCharacters);
    // Detect once for the whole manuscript; every segment uses the same
    // language reference.
    const manuscriptLanguage = detectManuscriptLanguage(documents);
    // Cached segment and merge results are reused only for the same prompt
    // version and prompt language: if the prompt was upgraded or the project
    // language changed before a retry, old outputs must be regenerated.
    const promptKey = `${IMPORT_ANALYSIS_PROMPT_VERSION}\0${promptLanguageOf(project.language)}`;
    const chunkResults = await concurrentMap(
      chunks,
      Math.max(
        1,
        Math.min(
          3,
          Math.trunc(policyNumber(snapshot.run.policy, "importConcurrency", 2)),
        ),
      ),
      signal,
      async (chunk, index, chunkSignal): Promise<ImportChunkResult> => {
        const inputDigest = sha256(
          `${batch.sourceHash}\0chunk\0${index}\0${promptKey}\0${chunk.text}`,
        );
        const cached = this.delivery.getImportAnalysisArtifact(
          batchId,
          "chunk",
          index,
        );
        const cachedAnalysis =
          cached?.inputDigest === inputDigest
            ? ImportAnalysisSchema.safeParse(cached.output)
            : null;
        if (cachedAnalysis?.success) {
          return {
            analysis: cachedAnalysis.data,
            digest: cached!.outputDigest,
            usage:
              cached!.runId === snapshot.run.id ? cached!.usage : zeroUsage(),
            reused: true,
          };
        }
        const result = await this.model.structured(
          snapshot.run,
          step,
          `import-analysis-chunk-${index + 1}`,
          importAnalysisRequest({
            projectTitle: project.title,
            premise: project.premise,
            language: project.language,
            filename: batch.filename,
            text: chunk.promptText,
            segment: index + 1,
            segments: chunks.length,
            manuscriptLanguage,
            maxOutputTokens: policyNumber(
              snapshot.run.policy,
              "analysisMaxOutputTokens",
              16_000,
            ),
          }),
          IMPORT_ANALYSIS_CONTRACT,
          deliveryValidator(ImportAnalysisSchema, (value) =>
            importEvidenceIssues(
              value,
              locator,
              new Set(chunk.paragraphOrdinals),
            ),
          ),
          chunkSignal,
        );
        const outputDigest = sha256(stableJson(result.value));
        const now = this.now().toISOString();
        this.delivery.upsertImportAnalysisArtifact({
          id: `${batchId}:chunk:${index}:${inputDigest.slice(0, 16)}`,
          batchId,
          runId: snapshot.run.id,
          stage: "chunk",
          ordinal: index,
          inputDigest,
          output: result.value,
          outputDigest,
          usage: result.usage,
          createdAt: cached?.createdAt ?? now,
          updatedAt: now,
        });
        return {
          analysis: result.value,
          digest: outputDigest,
          usage: result.usage,
          reused: false,
        };
      },
    );
    const analyses = chunkResults.map((result) => result.analysis);
    const digests = chunkResults.map((result) => result.digest);
    let usage = chunkResults.reduce(
      (total, result) => addUsage(total, result.usage),
      zeroUsage(),
    );
    let reusedArtifacts = chunkResults.filter((result) => result.reused).length;

    let aggregate = analyses[0]!;
    let aggregateDigest = digests[0]!;
    for (let index = 1; index < analyses.length; index += 1) {
      const inputDigest = sha256(
        `${aggregateDigest}\0${digests[index]}\0synthesis\0${index}\0${promptKey}`,
      );
      const cached = this.delivery.getImportAnalysisArtifact(
        batchId,
        "synthesis",
        index - 1,
      );
      const cachedAnalysis =
        cached?.inputDigest === inputDigest
          ? ImportAnalysisSchema.safeParse(cached.output)
          : null;
      if (cachedAnalysis?.success) {
        aggregate = cachedAnalysis.data;
        aggregateDigest = cached!.outputDigest;
        if (cached!.runId === snapshot.run.id)
          usage = addUsage(usage, cached!.usage);
        reusedArtifacts += 1;
        continue;
      }
      const result = await this.model.structured(
        snapshot.run,
        step,
        `import-analysis-synthesis-${index}`,
        importSynthesisRequest(
          aggregate,
          analyses[index]!,
          project.language,
          policyNumber(snapshot.run.policy, "analysisMaxOutputTokens", 16_000),
        ),
        IMPORT_ANALYSIS_CONTRACT,
        deliveryValidator(ImportAnalysisSchema, (value) =>
          importEvidenceIssues(value, locator),
        ),
        signal,
      );
      usage = addUsage(usage, result.usage);
      aggregate = result.value;
      aggregateDigest = sha256(stableJson(aggregate));
      const now = this.now().toISOString();
      this.delivery.upsertImportAnalysisArtifact({
        id: `${batchId}:synthesis:${index - 1}:${inputDigest.slice(0, 16)}`,
        batchId,
        runId: snapshot.run.id,
        stage: "synthesis",
        ordinal: index - 1,
        inputDigest,
        output: aggregate,
        outputDigest: aggregateDigest,
        usage: result.usage,
        createdAt: cached?.createdAt ?? now,
        updatedAt: now,
      });
    }
    return {
      artifactKind: "import-analysis",
      output: {
        ...aggregate,
        importPipeline: {
          sourceCharacters: documents.length,
          chunkCharacters,
          chunks: chunks.length,
          synthesisStages: Math.max(0, chunks.length - 1),
          reusedArtifacts,
          finalInputDigest: aggregateDigest,
        },
      },
      usage,
    };
  }

  private async stageAnalysis(
    snapshot: RunSnapshot,
    _step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const batchId = policyString(snapshot.run.policy, "batchId");
    requireAnalysisOwnership(
      this.delivery.requireImportBatch(batchId),
      snapshot.run.id,
    );
    const analysis = ImportAnalysisSchema.parse(
      requiredArtifact(snapshot, "import.analyze"),
    );
    const now = this.now().toISOString();
    const source = this.importedSource(batchId);
    const locator = new ParagraphLocator(source.text);
    const labels =
      IMPORT_STAGE_LABELS[
        promptLanguageOf(this.projects.get(snapshot.run.projectId)?.language)
      ];
    // Each located paragraph also records the document candidate (chapter)
    // it comes from, so later work can tell which chapter an item cites.
    const withEvidence = <T extends { evidenceParagraphs: number[] }>(
      item: T,
    ) => ({
      ...item,
      evidence: locator.locate(item.evidenceParagraphs).map((evidence) => ({
        ...evidence,
        documentCandidateId: documentCandidateAt(source.spans, evidence.start),
      })),
    });
    const candidates = [
      {
        id: `${batchId}:intent:0`,
        kind: "intent" as const,
        ordinal: 0,
        title: labels.intent,
        payload: {
          promise: analysis.synopsis,
          themes: analysis.themes,
          audience: analysis.audience,
          tone: analysis.tone,
          boundaries: analysis.boundaries,
          endingDirection: null,
          currentFocus: null,
        },
      },
      {
        id: `${batchId}:style:1`,
        kind: "style" as const,
        ordinal: 1,
        title: analysis.style.name,
        payload: { ...analysis.style, active: false },
      },
      ...analysis.entities.map((entity, index) => ({
        id: `${batchId}:entity:${index}`,
        kind: "entity" as const,
        ordinal: index,
        title: entity.name,
        payload: { ...entity, attributes: {} },
      })),
      ...analysis.skills.map((skill, index) => ({
        id: `${batchId}:skill:${index}`,
        kind: "skill" as const,
        ordinal: index,
        title: skill.name,
        payload: { ...skill, enabled: true },
      })),
      ...analysis.relationships
        .map(withEvidence)
        .map((relationship, index) => ({
          id: `${batchId}:relationship:${index}`,
          kind: "relationship" as const,
          ordinal: index,
          title: `${relationship.fromName} · ${relationship.relation} · ${relationship.toName}`,
          payload: relationship,
        })),
      ...analysis.timeline.map(withEvidence).map((event, index) => ({
        id: `${batchId}:timeline:${index}`,
        kind: "timeline" as const,
        ordinal: index,
        title: event.title,
        payload: event,
      })),
      ...analysis.foreshadows.map(withEvidence).map((foreshadow, index) => ({
        id: `${batchId}:foreshadow:${index}`,
        kind: "foreshadow" as const,
        ordinal: index,
        title: foreshadow.title,
        payload: foreshadow,
      })),
      ...analysis.characterArcs.map(withEvidence).map((arc, index) => ({
        id: `${batchId}:character-arc:${index}`,
        kind: "character-arc" as const,
        ordinal: index,
        title: `${arc.characterName} · ${labels.characterArc}`,
        payload: arc,
      })),
      ...analysis.scenes.map(withEvidence).map((scene, index) => ({
        id: `${batchId}:scene-analysis:${index}`,
        kind: "scene-analysis" as const,
        ordinal: index,
        title: scene.title,
        payload: scene,
      })),
    ];
    this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      requireAnalysisOwnership(
        this.delivery.requireImportBatch(batchId),
        snapshot.run.id,
      );
      for (const item of candidates) {
        this.delivery.upsertImportCandidate({
          ...item,
          batchId,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        });
      }
      this.delivery.updateImportBatch(
        batchId,
        { status: "ready", analysisRunId: snapshot.run.id },
        now,
      );
    });
    return {
      artifactKind: "import-candidate-set",
      output: { batchId, stagedCandidates: candidates.length },
      usage: zeroUsage(),
    };
  }

  private importedText(batchId: string): string {
    return this.importedSource(batchId).text;
  }

  private importedSource(batchId: string) {
    return importSourceText(
      this.delivery
        .listImportCandidates(batchId)
        .filter((candidate) => candidate.kind === "document"),
    );
  }

  /** Extract a style profile from sample text: the output is a disabled style
   *  profile draft the author reviews and enables. Saved with
   *  source=extract:{runId}; replaying a completed run returns the existing
   *  draft. */
  private async extractStyle(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const source = `extract:${snapshot.run.id}`;
    const existing = this.delivery
      .listStyleProfiles(snapshot.run.projectId, true)
      .find((profile) => profile.source === source);
    if (existing) {
      return {
        artifactKind: "style-extract",
        output: { styleProfileId: existing.id, name: existing.name },
        usage: zeroUsage(),
      };
    }
    const text = policyString(snapshot.run.policy, "sourceText").trim();
    if (text.length < 200) {
      throw permanent(
        "style.extract.text_too_short",
        "The writing sample must be at least 200 characters",
      );
    }
    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const result = await this.model.structured(
      snapshot.run,
      step,
      "style-extract",
      styleExtractionRequest({
        projectTitle: project.title,
        language: project.language,
        text,
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "styleExtractMaxOutputTokens",
          4_000,
        ),
      }),
      STYLE_PROFILE_CONTRACT,
      deliveryValidator(StyleSchema),
      signal,
    );
    const now = this.now().toISOString();
    const profile = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      return this.delivery.insertStyleProfile({
        id: randomUuid(),
        projectId: snapshot.run.projectId,
        name: uniqueStyleName(
          this.delivery.listStyleProfiles(snapshot.run.projectId, true),
          result.value.name,
        ),
        description: result.value.description,
        rules: [...result.value.rules],
        negativeRules: [...result.value.negativeRules],
        examples: [...result.value.examples],
        source,
        active: false,
        status: "active",
        createdAt: now,
        updatedAt: now,
        version: 0,
      });
    });
    return {
      artifactKind: "style-extract",
      output: { styleProfileId: profile.id, name: profile.name },
      usage: result.usage,
    };
  }
}

/** Version of the book-analysis prompts (segment analysis and merge), part of
 *  the input digest of cached outputs. Bump it when changing the instructions
 *  or message format of either prompt, so cached analyses from old prompts are
 *  no longer reused. */
const IMPORT_ANALYSIS_PROMPT_VERSION = "import-analysis-prompt-4";

/** Candidate language follows the source manuscript, not the instruction
 *  language: project.language is only pt-BR / en, but a manuscript in another
 *  language must still receive candidates in that language. */
const IMPORT_LANGUAGE_INVARIANT: Record<ProjectLanguage, string> = {
  "pt-BR":
    "Invariante de idioma: todos os campos em linguagem natural (title, synopsis, themes, audience, tone, boundaries, descrições de entidades, relações, linha do tempo, pistas, arcos de personagem, cenas, perfil de estilo e textos de Skill) devem ser escritos no mesmo idioma do texto original do manuscrito, mesmo que difira do idioma destas instruções; nomes próprios de personagens, lugares e afins permanecem exatamente como no original, sem traduzir. Nomes de campos e valores de enum permanecem como definidos pelo esquema.",
  en: "Language invariant: write every natural-language field (title, synopsis, themes, audience, tone, boundaries, entity descriptions, relationships, timeline, foreshadowing, character arcs, scenes, style profile, and Skill texts) in the same language as the source manuscript text, even when it differs from the language of these instructions; keep character, place, and other proper names exactly as written in the source, never translated. Field names and enum values stay as defined by the schema.",
};

/**
 * The merge step cannot see the manuscript and can only keep the language of
 * the input analyses; both the instructions and the user message say so
 * explicitly.
 */
const IMPORT_SYNTHESIS_LANGUAGE_INVARIANT: Record<ProjectLanguage, string> = {
  "pt-BR":
    "Invariante de idioma: mantenha o idioma das análises de entrada. Todos os campos em linguagem natural do resultado mesclado permanecem no mesmo idioma do manuscrito original das análises de entrada; nunca traduza para o idioma destas instruções; nomes próprios permanecem exatamente como no original. Nomes de campos e valores de enum permanecem como definidos pelo esquema.",
  en: "Language invariant: Keep the language of the input analyses. Keep every natural-language field of the merged result in the same source-manuscript language as the input analyses; never translate it into the language of these instructions, and keep proper names exactly as written. Field names and enum values stay as defined by the schema.",
};

const IMPORT_SYNTHESIS_MESSAGE_LEAD: Record<ProjectLanguage, string> = {
  "pt-BR":
    "Mantenha o idioma das análises de entrada: o resultado mesclado segue o idioma já usado pelos campos em linguagem natural de <accumulated> e <next>; não traduza.",
  en: "Keep the language of the input analyses: write the merged result in the language already used by the natural-language fields of <accumulated> and <next>; do not translate.",
};

const IMPORT_STAGE_LABELS: Record<
  ProjectLanguage,
  { intent: string; characterArc: string }
> = {
  "pt-BR": {
    intent: "Candidato de intenção do autor",
    characterArc: "Arco de personagem",
  },
  en: { intent: "Author intent candidate", characterArc: "Character arc" },
};

/** User message for segment analysis. When the manuscript language is detected,
 *  add a reference line (best-effort heuristic detection); the language
 *  invariant in the instructions still requires following the text itself. */
function importAnalysisMessage(input: {
  language: string | null;
  projectTitle: string;
  premise: string | null;
  filename: string;
  segment: number;
  segments: number;
  text: string;
  manuscriptLanguage: DetectedManuscriptLanguage;
}): string {
  const language = promptLanguageOf(input.language);
  const hint = manuscriptLanguageHint(language, input.manuscriptLanguage) ?? "";
  const lines =
    language === "en"
      ? [
          `Target work: "${input.projectTitle}"`,
          input.premise ? `Existing premise: ${input.premise}` : "",
          `Imported file: ${input.filename}`,
          hint,
          `Segment ${input.segment}/${input.segments}`,
          `Manuscript text:\n${input.text}`,
          "Deconstruct the synopsis, themes, audience, tone boundaries, entities, relationships, timeline, foreshadowing, character arcs, scenes, style profile, and 1-4 general-purpose writing Skills.",
        ]
      : [
          `Obra-alvo: «${input.projectTitle}»`,
          input.premise ? `Premissa já existente: ${input.premise}` : "",
          `Arquivo importado: ${input.filename}`,
          hint,
          `Segmento ${input.segment}/${input.segments}`,
          `Texto:\n${input.text}`,
          "Desmonte sinopse, temas, público, limites de tom, entidades, relações, linha do tempo, pistas, arcos de personagem, cenas, perfil de estilo e 1-4 Skills de escrita de uso geral.",
        ];
  return lines.filter(Boolean).join("\n\n");
}

function importAnalysisRequest(input: {
  projectTitle: string;
  premise: string | null;
  language: string | null;
  filename: string;
  text: string;
  segment: number;
  segments: number;
  manuscriptLanguage: DetectedManuscriptLanguage;
  maxOutputTokens: number;
}) {
  return {
    instructions: instructionsFor(input.language, {
      "pt-BR": [
        "Você é o editor de desmontagem de um romance de longo fôlego. Analise só o texto dado; não continue a história, não preencha lacunas e não imite as frases originais.",
        "A saída é um conjunto de candidatos à espera do julgamento do autor, não cânone. Entidades precisam de evidência textual; na dúvida, prefira omitir a incluir.",
        "Regras de estilo devem ser acionáveis e separadas dos fatos de gênero; examples só podem citar trechos muito curtos do original.",
        "Uma Writing Skill é uma instrução de processo ligável e desligável: não pode conter personagens concretos, fatos de mundo nem exigência de copiar o original.",
        "Extraia relações, linha do tempo, pistas, arcos de personagem e cenas em separado; cada item deve citar um ou mais parágrafos originais deste segmento com etiqueta [P#] em evidenceParagraphs.",
        IMPORT_LANGUAGE_INVARIANT["pt-BR"],
      ],
      en: [
        "You are the deconstruction editor of a long-form novel. Analyze only the given text; do not continue it, fill gaps, or imitate its sentences.",
        "The output is a set of candidates awaiting the author's adjudication, not canon. Entities must have textual evidence; when uncertain, prefer omission over inclusion.",
        "Style rules must be actionable and separated from genre facts; examples may quote only very short excerpts of the original text.",
        "A Writing Skill is a switchable process instruction and must not contain specific characters, world facts, or demands to copy the original text.",
        "Extract relations, timeline, foreshadowing, character arcs, and scenes separately; every item must cite one or more source paragraphs tagged [P#] within this segment through evidenceParagraphs.",
        IMPORT_LANGUAGE_INVARIANT.en,
      ],
    }),
    messages: [
      {
        role: "user" as const,
        content: importAnalysisMessage(input),
      },
    ],
    reasoningEffort: "medium" as const,
    maxOutputTokens: input.maxOutputTokens,
  };
}

function importSynthesisRequest(
  accumulated: ImportAnalysis,
  next: ImportAnalysis,
  language: string | null,
  maxOutputTokens: number,
) {
  return {
    instructions: instructionsFor(language, {
      "pt-BR": [
        "Você é o editor de mescla dos resultados de desmontagem de um romance longo. Una duas análises de segmento, deduplicando sem descartar informação exclusiva do segmento posterior.",
        "As evidências evidenceParagraphs devem ser preservadas tal como vieram das análises de entrada; nunca reescreva, una ou invente números de parágrafo.",
        "Renumere a linha do tempo pela ordem causal do livro inteiro; una entidades de mesmo nome com cautela e, na dúvida, mantenha-as separadas.",
        "A saída continua sendo o mesmo ImportAnalysis JSON completo.",
        IMPORT_SYNTHESIS_LANGUAGE_INVARIANT["pt-BR"],
      ],
      en: [
        "You are the merge editor for long-form deconstruction results. Merge two segment analyses, deduplicating without dropping information unique to the later segment.",
        "Evidence evidenceParagraphs must be preserved verbatim from the input analyses; never rewrite, merge, or invent paragraph numbers.",
        "Renumber the timeline by whole-book causal order; merge same-name entities cautiously and keep them separate when unsure.",
        "The output remains the same complete ImportAnalysis JSON.",
        IMPORT_SYNTHESIS_LANGUAGE_INVARIANT.en,
      ],
    }),
    messages: [
      {
        role: "user" as const,
        content: `${IMPORT_SYNTHESIS_MESSAGE_LEAD[promptLanguageOf(language)]}\n\n<accumulated>${JSON.stringify(accumulated)}</accumulated>\n<next>${JSON.stringify(next)}</next>`,
      },
    ],
    reasoningEffort: "medium" as const,
    maxOutputTokens,
  };
}

interface ImportTextChunk {
  text: string;
  promptText: string;
  paragraphOrdinals: number[];
}

interface ImportChunkResult {
  analysis: ImportAnalysis;
  digest: string;
  usage: RunBudgetUsage;
  reused: boolean;
}

async function concurrentMap<T, R extends { usage: RunBudgetUsage }>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  task: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results: Array<R | undefined> = new Array(items.length);
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  let cursor = 0;
  let firstError: unknown;
  const worker = async () => {
    while (!combined.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index]!, index, combined);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
          local.abort(error);
        }
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () =>
      worker(),
    ),
  );
  if (firstError !== undefined || signal.aborted) {
    throw errorWithPartialUsage(
      firstError ?? {
        code: "model.cancelled",
        message: "Import analysis was cancelled",
        retryable: true,
      },
      results.filter((result): result is R => result !== undefined),
    );
  }
  return results as R[];
}

function errorWithPartialUsage<R extends { usage: RunBudgetUsage }>(
  error: unknown,
  completed: readonly R[],
): unknown {
  const partial = completed.reduce(
    (total, result) => addUsage(total, result.usage),
    zeroUsage(),
  );
  const existing = errorUsage(error);
  const usage = existing ? addUsage(partial, existing) : partial;
  if (error && typeof error === "object") return { ...error, usage };
  return {
    code: "import.analysis.failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    usage,
  };
}

function errorUsage(error: unknown): RunBudgetUsage | null {
  if (!error || typeof error !== "object") return null;
  const usage = (error as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const candidate = usage as Partial<RunBudgetUsage>;
  return typeof candidate.calls === "number" &&
    typeof candidate.inputTokens === "number" &&
    typeof candidate.outputTokens === "number" &&
    typeof candidate.costUsd === "number" &&
    typeof candidate.wallTimeMs === "number"
    ? (candidate as RunBudgetUsage)
    : null;
}

function requireAnalysisOwnership(
  batch: { status: string; analysisRunId: string | null },
  runId: string,
): void {
  if (batch.status === "analyzing" && batch.analysisRunId === runId) return;
  const error = new Error("Import analysis is no longer writable");
  error.name = "AbortError";
  throw error;
}

function splitImportParagraphs(
  locator: ParagraphLocator,
  maxCharacters: number,
): ImportTextChunk[] {
  const chunks: ImportTextChunk[] = [];
  let ordinals: number[] = [];
  let characters = 0;
  const flush = () => {
    if (ordinals.length === 0) return;
    const selected = ordinals.map(
      (ordinal) => locator.paragraphs[ordinal - 1]!,
    );
    chunks.push({
      text: selected.map((paragraph) => paragraph.quote).join("\n\n"),
      promptText: locator.render(ordinals),
      paragraphOrdinals: ordinals,
    });
    ordinals = [];
    characters = 0;
  };
  for (const paragraph of locator.paragraphs) {
    const added = paragraph.quote.length + (ordinals.length > 0 ? 2 : 0);
    if (ordinals.length > 0 && characters + added > maxCharacters) flush();
    ordinals.push(paragraph.ordinal);
    characters += paragraph.quote.length + (ordinals.length > 1 ? 2 : 0);
  }
  flush();
  return chunks;
}

function sha256(value: string): string {
  return sha256Hex(value);
}

function addUsage(left: RunBudgetUsage, right: RunBudgetUsage): RunBudgetUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    calls: left.calls + right.calls,
    costUsd: left.costUsd + right.costUsd,
    wallTimeMs: left.wallTimeMs + right.wallTimeMs,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function importEvidenceIssues(
  analysis: ImportAnalysis,
  locator: ParagraphLocator,
  allowedOrdinals?: ReadonlySet<number>,
): string[] {
  const issues: string[] = [];
  for (const key of [
    "relationships",
    "timeline",
    "foreshadows",
    "characterArcs",
    "scenes",
  ] as const) {
    analysis[key].forEach((item, index) => {
      issues.push(
        ...locator.validate(
          item.evidenceParagraphs,
          `${key}.${index}.evidenceParagraphs`,
          allowedOrdinals,
        ),
      );
    });
  }
  return issues;
}

function styleExtractionRequest(input: {
  projectTitle: string;
  language: string | null;
  text: string;
  maxOutputTokens: number;
}) {
  return {
    instructions: instructionsFor(input.language, {
      "pt-BR": [
        "Você é um analista de estilo em prosa. Destile a amostra dada num perfil de estilo acionável, para o autor revisar e ativar.",
        "rules enunciam regras de ofício acionáveis (ritmo da frase, hábitos de narração, densidade de diálogo, como a emoção se exterioriza), nunca fatos de gênero ou de enredo.",
        "negativeRules enunciam tendências claramente ausentes da amostra que desviariam a voz se fossem adotadas.",
        "examples citam só trechos curtos que melhor representam a voz.",
        "name é um rótulo curto que descreve a voz, nunca o nome de uma pessoa ou de um livro.",
      ],
      en: [
        "You are a prose style analyst. Distill the given writing sample into an actionable style profile for the author to review and enable.",
        "rules state actionable craft rules (sentence rhythm, narration habits, dialogue density, how emotion is externalized), never genre or plot facts.",
        "negativeRules state tendencies clearly absent from the sample that would drift the voice if adopted.",
        "examples quote only short excerpts that best represent the voice.",
        "name is a short voice-describing label, never a person or book name.",
      ],
    }),
    messages: [
      {
        role: "user" as const,
        content:
          promptLanguageOf(input.language) === "en"
            ? [
                `Target work: "${input.projectTitle}"`,
                `Writing sample:\n${input.text}`,
                "Distill a style profile (name, description, rules, negativeRules, examples).",
              ].join("\n\n")
            : [
                `Obra-alvo: «${input.projectTitle}»`,
                `Amostra:\n${input.text}`,
                "Destile um perfil de estilo (name, description, rules, negativeRules, examples).",
              ].join("\n\n"),
      },
    ],
    reasoningEffort: "medium" as const,
    maxOutputTokens: input.maxOutputTokens,
  };
}

/**
 * When the extracted profile's name clashes with an existing profile, append a
 * number so a single extraction can always be saved.
 */
function uniqueStyleName(
  existing: ReadonlyArray<{ name: string }>,
  name: string,
): string {
  const taken = new Set(existing.map((profile) => profile.name));
  if (!taken.has(name)) return name;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${name} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} ${Date.now()}`;
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
) {
  const artifact = [...snapshot.steps]
    .reverse()
    .find(
      (step) => step.kind === kind && step.status === "succeeded",
    )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing artifact for step ${kind}`);
  return { ...artifact };
}

function policyString(policy: Readonly<Record<string, unknown>>, key: string) {
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
) {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
  const error = new Error(message) as Error & {
    code: string;
    retryable: boolean;
  };
  error.code = code;
  error.retryable = false;
  return error;
}
import { randomUuid, sha256Hex } from "@lapis/domain";
