import { outlineStructureFingerprint } from "../outline-baseline.js";

import {
  type ContextCompileError,
  type ContextSource,
} from "@narralume/context";
import { type NarrativeRunStep, type RunSnapshot } from "@narralume/domain";
import type { StepExecutionResult } from "@narralume/harness";

import {
  optionalEmbeddings,
  recordEmbeddingDegradation,
} from "../embedding-support.js";
import { outlineContextSources } from "../outline-context.js";
import { promptLanguageOf } from "../prompt-language.js";

import {
  type ChapterWorkerDeps,
  documentReviewTarget,
  permanent,
  policyNumber,
  sha256,
  stableContextInventory,
} from "./helpers.js";

export async function compileContext(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
  step: NarrativeRunStep,
  signal: AbortSignal,
): Promise<StepExecutionResult> {
  const run = snapshot.run;
  const project = deps.projects.get(run.projectId);
  if (!project) throw permanent("project.not_found", "Project not found");
  const copy = contextCopy(project.language);
  if (!run.targetOutlineNodeId) {
    throw permanent(
      "run.target.missing",
      "The chapter run has no target outline node",
    );
  }
  const target = deps.story.requireOutlineNode(
    run.projectId,
    run.targetOutlineNodeId,
  );
  if (target.kind !== "chapter") {
    throw permanent(
      "run.target.not_chapter",
      "The chapter production target must be a chapter",
    );
  }
  const compass = deps.automation.getCompass(run.projectId);
  const chapterWritingReference = compass
    ? {
        targetCharacters: compass.target.wordsPerChapter,
        compassVersion: compass.version,
      }
    : null;
  const documentReview = documentReviewTarget(deps, snapshot);
  const plannedEntityIds = [
    ...new Set([
      ...(Array.isArray(target.metadata.plannedEntityIds)
        ? target.metadata.plannedEntityIds.filter(
            (id): id is string => typeof id === "string",
          )
        : []),
      ...(target.povEntityId ? [target.povEntityId] : []),
    ]),
  ];
  const plannedEntities = plannedEntityIds.map((id) => {
    const entity = deps.canon.getEntity(run.projectId, id);
    if (!entity || entity.status !== "active")
      throw permanent(
        "planning.entities.conflict",
        "A chapter entity is no longer available; update the chapter plan",
      );
    return entity;
  });
  const entitySources = (authorView: boolean): ContextSource[] =>
    plannedEntities.map((entity) => ({
      id: `planned-entity:${entity.id}`,
      kind: "canon",
      label: authorView ? copy.entityAuthor : copy.entityDraft,
      content: JSON.stringify({
        id: entity.id,
        type: entity.type,
        name: entity.name,
        aliases: entity.aliases,
        ...(authorView
          ? { description: entity.description, attributes: entity.attributes }
          : {}),
      }),
      authority: "confirmed",
      priority: 97,
      required: true,
      compressible: false,
      sourceType: "canon_entity",
      sourceId: entity.id,
    }));
  const sources: ContextSource[] = [
    {
      id: `task:${target.id}`,
      kind: "task",
      label: copy.task(target.title),
      content: [
        copy.taskLead(project.title, target.title),
        target.summary && copy.summary(target.summary),
        target.goal && copy.goal(target.goal),
        target.conflict && copy.conflict(target.conflict),
        target.outcome && copy.outcome(target.outcome),
        target.povEntityId && copy.pov(target.povEntityId),
      ]
        .filter(Boolean)
        .join("\n"),
      authority: "locked",
      priority: 100,
      required: true,
      compressible: false,
      sourceType: "outline_node",
      sourceId: target.id,
    },
  ];
  const activeStyle = deps.delivery.getActiveStyleProfile(run.projectId);
  if (activeStyle) {
    sources.push({
      id: `style:${activeStyle.id}`,
      kind: "style",
      label: copy.style(activeStyle.name),
      content: [
        activeStyle.description ?? "",
        ...activeStyle.rules.map((rule) => copy.must(rule)),
        ...activeStyle.negativeRules.map((rule) => copy.avoid(rule)),
        ...activeStyle.examples.map((example) => copy.example(example)),
      ]
        .filter(Boolean)
        .join("\n"),
      authority: "locked",
      priority: 98,
      required: true,
      compressible: false,
      sourceType: "style_profile",
      sourceId: activeStyle.id,
    });
  }
  for (const skill of deps.delivery.listApplicableSkills(
    run.projectId,
    "chapter",
  )) {
    sources.push({
      id: `skill:${skill.id}`,
      kind: "system",
      label: copy.skill(skill.name),
      content: skill.instructions,
      authority: "locked",
      priority: 90 + skill.priority / 20,
      required: skill.priority >= 80,
      compressible: skill.priority < 80,
      sourceType: "writing_skill",
      sourceId: skill.id,
    });
  }
  const lessons = deps.reviews.listLessons(run.projectId).slice(0, 30);
  if (lessons.length > 0) {
    sources.push({
      id: "review:learned-lessons",
      kind: "system",
      label: copy.lessons,
      content: lessons
        .map((lesson) =>
          copy.lessonLine(
            lesson.category,
            lesson.confidence,
            lesson.occurrences,
            lesson.guidance,
          ),
        )
        .join("\n"),
      summary: lessons
        .slice(0, 10)
        .map((lesson) => `- [${lesson.category}] ${lesson.guidance}`)
        .join("\n"),
      authority: "confirmed",
      priority: 91,
      sourceType: "review_lesson",
      sourceId: run.projectId,
    });
  }
  const steerNotes = Array.isArray(run.policy.steerNotes)
    ? run.policy.steerNotes.filter(
        (note): note is string =>
          typeof note === "string" && Boolean(note.trim()),
      )
    : [];
  if (steerNotes.length > 0) {
    sources.push({
      id: `steer:${run.id}`,
      kind: "author-intent",
      label: copy.steer,
      content: steerNotes.map((note) => `- ${note}`).join("\n"),
      authority: "locked",
      priority: 99,
      required: true,
      compressible: false,
      sourceType: "story_steer",
      sourceId: run.id,
    });
  }
  const intent = deps.story.getAuthorIntent(run.projectId);
  if (intent) {
    const content = [
      intent.promise && copy.promise(intent.promise),
      intent.themes.length && copy.themes(intent.themes),
      intent.audience && copy.audience(intent.audience),
      intent.tone && copy.tone(intent.tone),
      intent.boundaries.length && copy.boundaries(intent.boundaries),
      intent.endingDirection && copy.ending(intent.endingDirection),
      intent.currentFocus && copy.focus(intent.currentFocus),
    ]
      .filter(Boolean)
      .join("\n");
    if (content) {
      sources.push({
        id: "author-intent",
        kind: "author-intent",
        label: copy.intent,
        content,
        authority: "locked",
        priority: 98,
        required: true,
        compressible: false,
        sourceType: "author_intent",
        sourceId: run.projectId,
      });
    }
  }
  const outline = deps.story.listOutline(run.projectId);
  sources.push(
    ...outlineContextSources({
      projectId: run.projectId,
      outline,
      chapterSummaries: deps.state.listLatestSummaries(
        run.projectId,
        "chapter",
      ),
      targetOutlineNodeId: target.id,
    }),
  );
  const authorStoryStatePacket = deps.storyState.build({
    projectId: run.projectId,
    audience: "author",
    focalEntityIds: plannedEntityIds,
    targetOutlineNodeId: target.id,
  });
  const draftStoryStatePacket = target.povEntityId
    ? deps.storyState.build({
        projectId: run.projectId,
        audience: "character",
        characterId: target.povEntityId,
        focalEntityIds: plannedEntityIds,
        targetOutlineNodeId: target.id,
      })
    : authorStoryStatePacket;

  const chapterNodes = outline.filter((node) => node.kind === "chapter");
  const pinnedDocumentSourceIds = new Set<string>();
  const targetChapterIndex = chapterNodes.findIndex(
    (node) => node.id === target.id,
  );
  for (let index = targetChapterIndex - 1; index >= 0; index -= 1) {
    const previousChapter = chapterNodes[index]!;
    const previousDocument = deps.documents.getByOutlineNodeId(
      run.projectId,
      previousChapter.id,
    );
    const previousVersion = previousDocument?.currentVersionId
      ? deps.documents.getVersion(
          run.projectId,
          previousDocument!.id,
          previousDocument.currentVersionId,
        )
      : null;
    if (!previousVersion?.content) continue;
    pinnedDocumentSourceIds.add(previousDocument!.id);
    pinnedDocumentSourceIds.add(previousVersion.id);
    const previousSummary = deps.state.latestSummary(
      run.projectId,
      "chapter",
      previousChapter.id,
    )?.summary;
    sources.push({
      id: `previous-chapter:${previousVersion.id}`,
      kind: "recent-text",
      label: copy.previous(previousChapter.title),
      content: previousVersion.content,
      ...(previousSummary ? { summary: previousSummary } : {}),
      authority: "confirmed",
      priority: 97,
      required: true,
      compressible: true,
      sourceType: "document_version",
      sourceId: previousVersion.id,
      metadata: {
        outlineNodeId: previousChapter.id,
        documentId: previousDocument!.id,
      },
    });
    break;
  }

  const chapterDocument =
    documentReview?.document ??
    deps.documents.getByOutlineNodeId(run.projectId, target.id);
  const baseVersion =
    documentReview?.version ??
    (chapterDocument?.currentVersionId && chapterDocument
      ? deps.documents.getVersion(
          run.projectId,
          chapterDocument.id,
          chapterDocument.currentVersionId,
        )
      : null);
  if (baseVersion?.content) {
    pinnedDocumentSourceIds.add(chapterDocument!.id);
    pinnedDocumentSourceIds.add(baseVersion.id);
    const existingSummary = deps.state.latestSummary(
      run.projectId,
      "chapter",
      target.id,
    )?.summary;
    sources.push({
      id: `recent:${baseVersion.id}`,
      kind: "recent-text",
      label: copy.draft,
      content: baseVersion.content,
      ...(existingSummary ? { summary: existingSummary } : {}),
      authority: "confirmed",
      priority: 75,
      sourceType: "document_version",
      sourceId: baseVersion.id,
    });
  }
  const retrievalQuery = [target.title, target.summary]
    .filter(Boolean)
    .join(" ");
  const queryEmbedding = await optionalEmbeddings(
    deps.model,
    run,
    step,
    "context-retrieval-query",
    retrievalQuery ? [retrievalQuery] : [],
    signal,
  );
  recordEmbeddingDegradation(
    deps.database,
    run.id,
    step.id,
    queryEmbedding.degradation,
  );
  const retrievalHits = deps.retrieval.search(run.projectId, retrievalQuery, {
    entityIds: plannedEntityIds,
    limit: 8,
    rerank: false,
    ...(queryEmbedding.vectors[0]
      ? {
          queryEmbedding: queryEmbedding.vectors[0],
        }
      : {}),
    ...(queryEmbedding.model ? { embeddingModel: queryEmbedding.model } : {}),
  });
  for (const hit of retrievalHits) {
    if (pinnedDocumentSourceIds.has(hit.sourceId)) continue;
    sources.push({
      id: `retrieval:${hit.id}`,
      kind: "retrieval",
      label: hit.title || `${hit.sourceType}:${hit.sourceId}`,
      content: hit.content,
      authority:
        hit.authority === "locked"
          ? "locked"
          : hit.authority === "confirmed"
            ? "confirmed"
            : "reference",
      priority: 55 + Math.round(hit.score * 100),
      sourceType: hit.sourceType,
      sourceId: hit.sourceId,
      metadata: {
        retrievalReasons: hit.reasons,
        lexicalRank: hit.lexicalRank,
        vectorRank: hit.vectorRank,
        vectorScore: hit.vectorScore,
        rerankScore: hit.rerankScore,
      },
    });
  }

  const requestedContextWindow = policyNumber(
    run.policy,
    "contextWindow",
    128_000,
  );
  const inventoryDigest = sha256(
    stableContextInventory([
      ...sources,
      ...entitySources(true),
      ...authorStoryStatePacket.sources,
    ]),
  );
  const purposeRequests = {
    "scene-plan": 3_000,
    "chapter-draft": policyNumber(run.policy, "draftMaxOutputTokens", 32_000),
    "semantic-review": policyNumber(
      run.policy,
      "reviewMaxOutputTokens",
      24_000,
    ),
    "chapter-revision": policyNumber(
      run.policy,
      "draftMaxOutputTokens",
      32_000,
    ),
    "chapter-settlement": policyNumber(
      run.policy,
      "settlementMaxOutputTokens",
      24_000,
    ),
  } as const;
  const contexts: Record<
    string,
    {
      text: string;
      receiptId: string;
      compiledHash: string;
      contextWindow: number;
      outputReserve: number;
      modelMaterializationKey: string;
      inventoryDigest: string;
    }
  > = {};
  for (const [purpose, purposeRequest] of Object.entries(purposeRequests)) {
    const statePacket = [
      "scene-plan",
      "semantic-review",
      "chapter-settlement",
    ].includes(purpose)
      ? authorStoryStatePacket
      : draftStoryStatePacket;
    const purposeSources = [
      ...sources,
      ...entitySources(statePacket === authorStoryStatePacket),
      ...statePacket.sources,
    ];
    const purposeInventoryDigest = sha256(
      stableContextInventory(purposeSources),
    );
    const contextWindow =
      deps.model.effectiveContextWindow?.(run, purpose) ??
      requestedContextWindow;
    const outputReserve = Math.min(
      purposeRequest,
      deps.model.effectiveOutputLimit?.(run, purpose) ?? purposeRequest,
      Math.floor(contextWindow * 0.4),
    );
    const modelMaterializationKey =
      deps.model.contextMaterializationKey?.(run, purpose) ?? "unresolved";
    const budget = {
      contextWindow,
      outputReserve,
      fixedInstructionReserve: 1_500,
      toolReserve: purpose.includes("draft") ? 0 : 500,
      schemaReserve: purpose.includes("draft") ? 0 : 1_000,
    };
    let compiled;
    try {
      compiled = deps.compiler.compile({
        projectId: run.projectId,
        purpose,
        budget,
        sources: purposeSources,
      });
    } catch (error) {
      const contextError = error as Partial<ContextCompileError>;
      throw permanent(
        typeof contextError.code === "string"
          ? contextError.code
          : "context.compile.failed",
        `${purpose} context compilation failed: ${error instanceof Error ? error.message : String(error)}; budget ${JSON.stringify(budget)}`,
      );
    }
    const receipt = {
      ...compiled.receipt,
      id: `${step.id}:receipt:${purpose}`,
      inventoryDigest: purposeInventoryDigest,
      materializationDigest: sha256(
        `${purposeInventoryDigest}\0${purpose}\0${contextWindow}\0${outputReserve}\0${modelMaterializationKey}`,
      ),
      ...(queryEmbedding.degradation
        ? { degradations: [queryEmbedding.degradation] }
        : {}),
    };
    if (!deps.receipts.get(run.projectId, receipt.id)) {
      deps.receipts.insert(receipt, { runId: run.id, stepId: step.id });
    }
    contexts[purpose] = {
      text: compiled.text,
      receiptId: receipt.id,
      compiledHash: receipt.compiledHash,
      contextWindow,
      outputReserve,
      modelMaterializationKey,
      inventoryDigest: purposeInventoryDigest,
    };
  }
  return {
    artifactKind: "compiled-context",
    output: {
      inventoryDigest,
      outlineStructureFingerprint: outlineStructureFingerprint(outline),
      inventorySources: sources.length,
      contexts,
      baseDocumentId: chapterDocument?.id ?? null,
      baseVersionId: baseVersion?.id ?? null,
      targetOutlineNodeId: target.id,
      chapterWritingReference,
      storyStateFingerprint: authorStoryStatePacket.fingerprint,
      storyStateCounts: authorStoryStatePacket.counts,
      storyStateFingerprints: {
        author: authorStoryStatePacket.fingerprint,
        draft: draftStoryStatePacket.fingerprint,
      },
      retrievalEmbedding: {
        model: queryEmbedding.model,
        modelId: queryEmbedding.modelId,
        warning: queryEmbedding.warning,
      },
    },
    usage: queryEmbedding.usage,
  };
}

function contextCopy(language: string | null | undefined) {
  const english = promptLanguageOf(language) === "en";
  const join = (items: readonly string[], sep: string) => items.join(sep);
  if (english) {
    return {
      entityAuthor:
        "Chapter entity notes (author reference; plot function is not an event that has happened)",
      entityDraft:
        "Chapter entity identity (does not mean the POV already knows this)",
      task: (title: string) => `Chapter task · ${title}`,
      taskLead: (work: string, title: string) =>
        `Write chapter “${title}” for “${work}”.`,
      summary: (value: string) => `Summary: ${value}`,
      goal: (value: string) => `Goal: ${value}`,
      conflict: (value: string) => `Conflict: ${value}`,
      outcome: (value: string) => `Intended outcome: ${value}`,
      pov: (value: string) => `POV entity: ${value}`,
      style: (name: string) => `Active style · ${name}`,
      must: (rule: string) => `Must: ${rule}`,
      avoid: (rule: string) => `Avoid: ${rule}`,
      example: (value: string) => `Short sample: ${value}`,
      skill: (name: string) => `Writing skill · ${name}`,
      lessons: "Confirmed long-term writing lessons",
      lessonLine: (
        category: string,
        confidence: number,
        occurrences: number,
        guidance: string,
      ) =>
        `- [${category} | confidence ${confidence.toFixed(2)} | ${occurrences}×] ${guidance}`,
      steer: "Director notes for this chapter",
      promise: (value: string) => `Core promise: ${value}`,
      themes: (values: readonly string[]) => `Themes: ${join(values, ", ")}`,
      audience: (value: string) => `Audience: ${value}`,
      tone: (value: string) => `Tone: ${value}`,
      boundaries: (values: readonly string[]) =>
        `Boundaries: ${join(values, "; ")}`,
      ending: (value: string) => `Ending direction: ${value}`,
      focus: (value: string) => `Current focus: ${value}`,
      intent: "Author intent",
      previous: (title: string) =>
        `Latest prose of the previous chapter · ${title}`,
      draft: "Current chapter draft",
    };
  }
  return {
    entityAuthor:
      "Notas da entidade deste capítulo (referência da autoria; a função na trama não é um evento ocorrido)",
    entityDraft:
      "Identidade da entidade deste capítulo (não significa que o POV já saiba disso)",
    task: (title: string) => `Tarefa do capítulo · ${title}`,
    taskLead: (work: string, title: string) =>
      `Escreva o capítulo “${title}” de “${work}”.`,
    summary: (value: string) => `Resumo: ${value}`,
    goal: (value: string) => `Objetivo: ${value}`,
    conflict: (value: string) => `Conflito: ${value}`,
    outcome: (value: string) => `Desfecho previsto: ${value}`,
    pov: (value: string) => `Entidade de POV: ${value}`,
    style: (name: string) => `Estilo ativo · ${name}`,
    must: (rule: string) => `Deve: ${rule}`,
    avoid: (rule: string) => `Evite: ${rule}`,
    example: (value: string) => `Amostra curta: ${value}`,
    skill: (name: string) => `Skill de escrita · ${name}`,
    lessons: "Lições de escrita de longo prazo confirmadas",
    lessonLine: (
      category: string,
      confidence: number,
      occurrences: number,
      guidance: string,
    ) =>
      `- [${category} | confiança ${confidence.toFixed(2)} | ${occurrences} vezes] ${guidance}`,
    steer: "Notas de direção deste capítulo",
    promise: (value: string) => `Promessa central: ${value}`,
    themes: (values: readonly string[]) => `Temas: ${join(values, ", ")}`,
    audience: (value: string) => `Público: ${value}`,
    tone: (value: string) => `Tom: ${value}`,
    boundaries: (values: readonly string[]) => `Limites: ${join(values, "; ")}`,
    ending: (value: string) => `Direção do desfecho: ${value}`,
    focus: (value: string) => `Foco atual: ${value}`,
    intent: "Intenção da autoria",
    previous: (title: string) =>
      `Prosa mais recente do capítulo anterior · ${title}`,
    draft: "Rascunho atual do capítulo",
  };
}
