import type { ContextCompiler, ContextSource } from "@lapis/context";
import { sha256Hex } from "@lapis/domain";
import type {
  NarrativeDatabase,
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteContextReceiptRepository,
  SqliteDeliveryRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
} from "@lapis/persistence";
import type { NarrativeModelClient } from "../model-client.js";
import type { SettlementApplicationService } from "../settlement-application-service.js";
import type { StoryStatePacketBuilder } from "../story-state-packet.js";
import {
  type CanonFact,
  type Document,
  type DocumentVersion,
  type Foreshadow,
  type NarrativeRunStep,
  type OutlineNode,
  type RelationshipEvent,
  type RunBudgetUsage,
  type RunSnapshot,
  type TimelineEvent,
} from "@lapis/domain";
import {
  ParagraphLocator,
  ParagraphLocatorError,
  bindEvidenceDocumentVersion,
  type GroundedParagraphEvidence,
} from "../paragraph-locator.js";
import {
  authoredInstructions,
  instructionsFor,
  promptLanguageOf,
  workCraftLayer,
} from "../prompt-language.js";
import { promptDefaultInstructions, promptInvariants } from "@lapis/harness";
import {
  importEvidenceDocuments,
  importSourceText,
  type ImportSourceText,
} from "../import-evidence.js";
import {
  selectAnchorableTimeline,
  type AnchorableTimeline,
  type TimelineEvidencePlacement,
} from "../unanchored-timeline.js";
import {
  type DerivedReviewResult,
  type GroundedSettlement,
  type ReviewResult,
  type Settlement,
} from "../schemas.js";

export interface ChapterWorkerDeps {
  readonly database: NarrativeDatabase;
  readonly model: NarrativeModelClient;
  readonly now: () => Date;
  readonly automation: SqliteAutomationRepository;
  readonly projects: SqliteProjectRepository;
  readonly story: SqliteStoryRepository;
  readonly canon: SqliteCanonRepository;
  readonly state: SqliteNarrativeStateRepository;
  readonly documents: SqliteDocumentRepository;
  readonly retrieval: SqliteRetrievalRepository;
  readonly receipts: SqliteContextReceiptRepository;
  readonly reviews: SqliteReviewRepository;
  readonly runs: SqliteRunRepository;
  readonly delivery: SqliteDeliveryRepository;
  readonly compiler: ContextCompiler;
  readonly templates: SqliteTemplateRepository;
  readonly storyState: StoryStatePacketBuilder;
  readonly settlementApplication: SettlementApplicationService;
}

export function chapterAuthoredInstructions(
  deps: ChapterWorkerDeps,
  projectId: string,
  key: string,
  options?: { craft?: boolean },
): string {
  return authoredInstructions({
    language: promptLanguageOf(projectLanguage(deps, projectId)),
    templateContent: deps.templates.getByKey(key)?.effectiveContent ?? null,
    fallback: promptDefaultInstructions(key),
    invariants: promptInvariants(key),
    craft: options?.craft ? workCraft(deps, projectId) : null,
  });
}

function workCraft(deps: ChapterWorkerDeps, projectId: string): string {
  return workCraftLayer({
    language: promptLanguageOf(projectLanguage(deps, projectId)),
    templateContent:
      deps.templates.getByKey("prompt.chapter-draft")?.effectiveContent ?? null,
    fallback: promptDefaultInstructions("prompt.chapter-draft"),
  });
}

export function projectLanguage(
  deps: ChapterWorkerDeps,
  projectId: string,
): string | null {
  return deps.projects.get(projectId)?.language ?? null;
}

export function requestedRevisionSource(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
): RunSnapshot {
  const sourceRunId = stringField(snapshot.run.policy, "revisionSourceRunId");
  const source = deps.runs.getSnapshot(sourceRunId);
  if (
    source.run.projectId !== snapshot.run.projectId ||
    source.run.targetOutlineNodeId !== snapshot.run.targetOutlineNodeId
  ) {
    throw permanent(
      "revision.source.scope_mismatch",
      "The revision source manuscript does not belong to the current project and chapter",
    );
  }
  return source;
}

export function paragraphLocator(
  deps: ChapterWorkerDeps,
  projectId: string,
  content: string,
  context: Readonly<Record<string, unknown>>,
): ParagraphLocator {
  const documentId = stringOrNull(context.baseDocumentId);
  const versionId = stringOrNull(context.baseVersionId);
  const version =
    documentId && versionId
      ? deps.documents.getVersion(projectId, documentId, versionId)
      : null;
  return new ParagraphLocator(content, {
    documentVersionId:
      version?.contentHash === sha256(content) ? version.id : null,
  });
}

export function manualSettlementTarget(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
): {
  document: Document;
  version: DocumentVersion;
  outlineNode: OutlineNode;
  content: string;
} | null {
  if (snapshot.run.recipe !== "manual-settlement") return null;
  const documentId = stringOrNull(snapshot.run.policy.documentId);
  const versionId = stringOrNull(snapshot.run.policy.documentVersionId);
  if (!documentId || !versionId) {
    throw permanent(
      "manual_settlement.target.missing",
      "The manual settlement run is missing a manuscript version target",
    );
  }
  const document = deps.documents.get(snapshot.run.projectId, documentId);
  if (!document) {
    throw permanent(
      "document.not_found",
      "The manual settlement target document does not exist",
    );
  }
  const version = deps.documents.getVersion(
    snapshot.run.projectId,
    documentId,
    versionId,
  );
  if (!version) {
    throw permanent(
      "document.version.not_found",
      "The manual settlement target version does not exist",
    );
  }
  if (!document.outlineNodeId) {
    throw permanent(
      "document.outline_node.missing",
      "The manual settlement target is not bound to an outline node",
    );
  }
  return {
    document,
    version,
    outlineNode: deps.story.requireOutlineNode(
      snapshot.run.projectId,
      document.outlineNodeId,
    ),
    content: version.content,
  };
}

export function documentReviewTarget(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
): {
  document: Document;
  version: DocumentVersion;
  outlineNode: OutlineNode;
  content: string;
} | null {
  if (snapshot.run.recipe !== "document-review") return null;
  const documentId = stringOrNull(snapshot.run.policy.documentId);
  const versionId = stringOrNull(snapshot.run.policy.documentVersionId);
  if (!documentId || !versionId) {
    throw permanent(
      "document_review.target.missing",
      "The review run is missing a manuscript version target",
    );
  }
  const document = deps.documents.get(snapshot.run.projectId, documentId);
  if (!document) {
    throw permanent(
      "document.not_found",
      "The review target document does not exist",
    );
  }
  const version = deps.documents.getVersion(
    snapshot.run.projectId,
    documentId,
    versionId,
  );
  if (!version) {
    throw permanent(
      "document.version.not_found",
      "The review target version does not exist",
    );
  }
  if (!document.outlineNodeId) {
    throw permanent(
      "document.outline_node.missing",
      "The review target is not bound to a chapter outline",
    );
  }
  if (document.outlineNodeId !== snapshot.run.targetOutlineNodeId) {
    throw permanent(
      "document_review.target.conflict",
      "The review target does not match the run chapter",
    );
  }
  return {
    document,
    version,
    outlineNode: deps.story.requireOutlineNode(
      snapshot.run.projectId,
      document.outlineNodeId,
    ),
    content: version.content,
  };
}

export function rereadNote(deps: ChapterWorkerDeps, projectId: string): string {
  const table = {
    "pt-BR": [
      "A autoria pediu para reler este capítulo: ele já foi acertado, então os fatos, relações, linha do tempo, conhecimento dos personagens e antecipações no contexto de autoridade já incluem os registros que ele produziu.",
      "Só acrescente o que esses registros omitem e corrija o que contradiz a prosa: supersede ou withdraw um fato existente pelo ID, update/end nas relações, develop/resolve nas antecipações.",
      "Não crie um fato, evento, relação ou antecipação nova para algo já registrado; quando nada precisar ser acrescentado ou corrigido, deixe os arrays de candidatos vazios.",
    ],
    en: [
      "The author asked to read this chapter again: it was settled before, so the facts, relationships, timeline, character knowledge and foreshadows in the authoritative context already include the records it produced.",
      "Only add what those records miss and correct what contradicts the prose: supersede or withdraw an existing fact by its ID, update/end relationships, develop/resolve foreshadows.",
      "Do not create a new fact, event, relationship or foreshadow for something already recorded; when nothing needs adding or correcting, leave the candidate arrays empty.",
    ],
  };
  return instructionsFor(
    projectLanguage(deps, projectId),
    table as unknown as Parameters<typeof instructionsFor>[1],
  );
}

export function existingStoryStateNote(
  deps: ChapterWorkerDeps,
  projectId: string,
): string {
  const table = {
    "pt-BR": [
      "Este capítulo vem de um manuscrito importado e já concluído; a Bíblia da história está sendo completada capítulo a capítulo na ordem de leitura.",
      "Relações, eventos da linha do tempo e antecipações já foram extraídos na importação, mas ainda não estão ancorados a um capítulo. Relações e antecipações aparecem no contexto de autoridade; os eventos da linha do tempo ainda sem âncora cuja evidência de importação cita este capítulo, ou que não puderam ser colocados num capítulo, estão em <unanchored-timeline>.",
      "Quando este capítulo toca um deles, cite-o pelo ID estável: update/end nas relações e develop/resolve nas antecipações. Quando a prosa mostra um dos eventos de <unanchored-timeline> acontecendo, ancore-o a este capítulo pondo o ID em anchorEventId de um item de timelineCandidates, em vez de criar um evento novo para a mesma coisa. Eventos existentes também podem ser citados em causeEventIds. Não start/plant um duplicado da mesma coisa.",
      "Regras de ancoragem: ancore só eventos listados em <unanchored-timeline> que a prosa deste capítulo mostre acontecendo (não os que só recorda ou menciona); copie o título exatamente, ponha description em null e participantIds e causeEventIds em arrays vazios, e preencha storyTime, knownBy e evidenceParagraphs como de costume. O evento existente guarda a própria descrição, participantes, causas e visibilidade; preencha visibility como de costume, isso não altera o evento. Cada evento só pode ser ancorado uma vez; um evento novo tem anchorEventId null.",
      "Só crie uma relação, evento ou antecipação nova quando o capítulo introduz algo que realmente não existe no contexto.",
    ],
    en: [
      "This chapter comes from an imported, finished manuscript; the Story Bible is being completed chapter by chapter in reading order.",
      "Relationships, timeline events and foreshadows were already extracted during import, but they are not anchored to a chapter yet. Relationships and foreshadows appear in the authoritative context; the unanchored timeline events whose import evidence cites this chapter, or that could not be placed in a chapter, are listed in <unanchored-timeline>.",
      "When this chapter touches one of them, reference it by its stable ID: update/end relationships and develop/resolve foreshadows. When this chapter shows one of the events in <unanchored-timeline> happening, anchor it to this chapter by putting its ID in a timelineCandidates item's anchorEventId instead of creating a new event for the same thing. Existing events can also be cited in causeEventIds. Do not start/plant a duplicate for the same thing.",
      "Anchoring rules: anchor only events listed in <unanchored-timeline> that this chapter's prose shows happening (not ones it merely recalls or mentions); copy the event's title exactly, set description to null and participantIds and causeEventIds to empty arrays, and fill storyTime, knownBy and evidenceParagraphs as usual. The existing event keeps its own description, participants, causes and visibility; fill visibility as usual, it does not change the event. Each event can be anchored once; a new event has anchorEventId null.",
      "Only create a new relationship, event or foreshadow when the chapter introduces one that truly does not exist in the context.",
    ],
  };
  return instructionsFor(
    projectLanguage(deps, projectId),
    table as unknown as Parameters<typeof instructionsFor>[1],
  );
}

export function anchorableTimeline(
  deps: ChapterWorkerDeps,
  projectId: string,
  outlineNodeId: string,
  events: readonly TimelineEvent[],
): AnchorableTimeline {
  const chapters = deps.story
    .listOutline(projectId)
    .filter((node) => node.kind === "chapter");
  const positionByDocumentCandidate = new Map<string, number>();
  chapters.forEach((node, position) => {
    const candidateId = node.metadata.importCandidateId;
    if (typeof candidateId === "string") {
      positionByDocumentCandidate.set(candidateId, position);
    }
  });
  const sources = new Map<string, ImportSourceText>();
  const sourceOf = (batchId: string) => () => {
    let source = sources.get(batchId);
    if (!source) {
      source = importSourceText(
        deps.delivery
          .listImportCandidates(batchId)
          .filter((candidate) => candidate.kind === "document"),
      );
      sources.set(batchId, source);
    }
    return source;
  };
  const placements = new Map<string, TimelineEvidencePlacement>();
  for (const event of events) {
    if (event.outlineNodeId !== null || !event.sourceId) continue;
    const candidate = deps.delivery.getImportCandidate(event.sourceId);
    if (candidate?.kind !== "timeline") continue;
    const batch = deps.delivery.getImportBatch(candidate.batchId);
    if ((batch?.appliedProjectId ?? batch?.targetProjectId) !== projectId) {
      continue;
    }
    const positions = importEvidenceDocuments(
      candidate.payload.evidence,
      sourceOf(candidate.batchId),
    ).map((documentCandidateId) =>
      documentCandidateId === null
        ? undefined
        : positionByDocumentCandidate.get(documentCandidateId),
    );
    placements.set(event.id, {
      chapters: positions.filter(
        (position): position is number => position !== undefined,
      ),
      unplaced: positions.filter((position) => position === undefined).length,
    });
  }
  const current = chapters.findIndex((node) => node.id === outlineNodeId);
  return selectAnchorableTimeline(
    events,
    placements,
    current < 0 ? null : current,
  );
}

export function manualSettlementContext(
  deps: ChapterWorkerDeps,
  projectId: string,
  outlineNodeId: string,
): string {
  const packet = deps.storyState.build({
    projectId,
    audience: "author",
    targetOutlineNodeId: outlineNodeId,
  });
  return packet.sources
    .map((source) => `[${source.label}]\n${source.content}`)
    .join("\n\n");
}

export function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Record<string, unknown> {
  const output = [...snapshot.steps]
    .reverse()
    .find(
      (step) => step.kind === kind && step.status === "succeeded",
    )?.outputArtifact;
  if (!output) {
    throw permanent(
      "artifact.missing",
      `Missing confirmed artifact for step ${kind}`,
    );
  }
  return { ...output };
}

export function latestGateArtifact(
  snapshot: RunSnapshot,
): Record<string, unknown> {
  const output = [...snapshot.steps]
    .reverse()
    .find(
      (step) =>
        step.status === "succeeded" &&
        (step.kind === "semantic.review" ||
          step.kind === "deterministic.check"),
    )?.outputArtifact;
  if (!output)
    throw permanent(
      "review.missing",
      "No quality gate artifact exists before revision",
    );
  return { ...output };
}

export function finalContent(snapshot: RunSnapshot): string {
  const output = [...snapshot.steps]
    .reverse()
    .find(
      (step) =>
        step.status === "succeeded" &&
        (step.kind === "revision.generate" || step.kind === "draft.generate"),
    )?.outputArtifact;
  return output ? stringField(output, "content") : "";
}

export function reviewSemanticIssues(
  review: ReviewResult,
  locator: ParagraphLocator,
): string[] {
  const issues: string[] = [];
  for (const [index, issue] of review.issues.entries()) {
    issues.push(
      ...locator.validate(
        issue.evidenceParagraphs,
        `issues.${index}.evidenceParagraphs`,
      ),
    );
  }
  return issues;
}

export function groundReviewEvidence(
  review: DerivedReviewResult,
  locator: ParagraphLocator,
): GroundedReviewResult {
  return {
    ...review,
    issues: review.issues.map((issue) => {
      const evidence = locateEvidence(locator, issue.evidenceParagraphs);
      return {
        ...issue,
        evidence,
      };
    }),
  };
}

/** Strip prefixes where the model copied context annotation syntax ([node:…],
 *  [timeline:…], etc.) into ID values. Returns the normalized settlement
 *  object; only field values are rewritten, no candidate is dropped. */
export function stripContextTagPrefixes(settlement: Settlement): Settlement {
  const id = (value: string): string =>
    value.replace(
      /^(?:node|timeline|entity|foreshadow|relationship|fact):/,
      "",
    );
  const nullableId = (value: string | null): string | null =>
    value === null ? null : id(value);
  return {
    ...settlement,
    factCandidates: settlement.factCandidates.map((fact) => ({
      ...fact,
      subjectId: id(fact.subjectId),
      objectEntityId: nullableId(fact.objectEntityId),
      factId: nullableId(fact.factId),
      knowledgeSubjectId: nullableId(fact.knowledgeSubjectId),
    })),
    timelineCandidates: settlement.timelineCandidates.map((event) => ({
      ...event,
      anchorEventId: nullableId(event.anchorEventId),
      participantIds: event.participantIds.map(id),
      causeEventIds: event.causeEventIds.map(id),
      knownBy: event.knownBy.map((knowledge) => ({
        ...knowledge,
        entityId: id(knowledge.entityId),
      })),
    })),
    relationshipCandidates: settlement.relationshipCandidates.map(
      (relation) => ({
        ...relation,
        relationshipId: nullableId(relation.relationshipId),
        fromEntityId: id(relation.fromEntityId),
        toEntityId: id(relation.toEntityId),
      }),
    ),
    foreshadowCandidates: settlement.foreshadowCandidates.map((foreshadow) => ({
      ...foreshadow,
      foreshadowId: nullableId(foreshadow.foreshadowId),
      targetFromNodeId: nullableId(foreshadow.targetFromNodeId),
      targetToNodeId: nullableId(foreshadow.targetToNodeId),
    })),
  };
}

export function settlementSemanticIssues(
  settlement: Settlement,
  entityIds: ReadonlySet<string>,
  current: {
    facts: ReadonlyMap<string, CanonFact>;
    relationships: ReadonlyMap<string, RelationshipEvent>;
    /** Current (not voided) timeline events. */
    timelineEvents: ReadonlyMap<string, TimelineEvent>;
    foreshadows: ReadonlyMap<string, Foreshadow>;
    outlineNodeIds: ReadonlySet<string>;
  },
  locator: ParagraphLocator,
  /**
   * Whether this is a Story Bible completion (backfill) settlement, the only
   * kind that is shown unanchored events and told how to anchor them.
   */
  allowAnchoring: boolean,
): string[] {
  const issues: string[] = [];
  const requireEntity = (id: string, path: string) => {
    if (!entityIds.has(id))
      issues.push(`${path}: ID de entidade desconhecido ${id}`);
  };
  settlement.factCandidates.forEach((fact, index) => {
    const path = `factCandidates.${index}`;
    requireEntity(fact.subjectId, `factCandidates.${index}.subjectId`);
    if (fact.objectEntityId)
      requireEntity(
        fact.objectEntityId,
        `factCandidates.${index}.objectEntityId`,
      );
    if (fact.knowledgeSubjectId)
      requireEntity(
        fact.knowledgeSubjectId,
        `factCandidates.${index}.knowledgeSubjectId`,
      );
    if (
      fact.knowledgeScope === "character" &&
      fact.knowledgeSubjectId === null
    ) {
      issues.push(
        `${path}.knowledgeSubjectId: conhecimento de personagem exige um personagem conhecedor`,
      );
    }
    if (
      fact.knowledgeScope !== "character" &&
      fact.knowledgeSubjectId !== null
    ) {
      issues.push(
        `${path}.knowledgeSubjectId: quando knowledgeScope é ${fact.knowledgeScope}, deve ser null (esvazie o campo; se só um personagem souber, use character e preencha o ID)`,
      );
    }
    if (fact.operation === "assert" && fact.factId !== null) {
      issues.push(`${path}.factId: assert não pode citar um fato existente`);
    }
    if (fact.operation !== "assert") {
      const target = fact.factId ? current.facts.get(fact.factId) : null;
      if (!target) {
        issues.push(
          `${path}.factId: ${fact.operation} deve citar o ID do fato atual`,
        );
      } else if (
        target.subjectId !== fact.subjectId ||
        target.predicate !== fact.predicate
      ) {
        issues.push(
          `${path}.factId: o fato citado não coincide com subject/predicate`,
        );
      }
    }
    issues.push(
      ...locator.validate(
        fact.evidenceParagraphs,
        `factCandidates.${index}.evidenceParagraphs`,
      ),
    );
  });
  const anchoredEventIds = new Set<string>();
  settlement.timelineCandidates.forEach((event, index) => {
    const path = `timelineCandidates.${index}`;
    event.participantIds.forEach((id) =>
      requireEntity(id, `timelineCandidates.${index}.participantIds`),
    );
    event.knownBy.forEach((knowledge, knowledgeIndex) =>
      requireEntity(
        knowledge.entityId,
        `timelineCandidates.${index}.knownBy.${knowledgeIndex}.entityId`,
      ),
    );
    event.causeEventIds.forEach((id) => {
      if (!current.timelineEvents.has(id)) {
        issues.push(
          `timelineCandidates.${index}.causeEventIds: ID de evento da linha do tempo desconhecido ${id} (só IDs marcados [timeline:…] no contexto)`,
        );
      }
    });
    if (event.anchorEventId !== null && !allowAnchoring) {
      issues.push(
        `${path}.anchorEventId: só o acerto capítulo a capítulo de “completar a Bíblia da história a partir do manuscrito” pode ancorar eventos existentes; neste acerto, anchorEventId deve ser null (evento novo)`,
      );
    } else if (event.anchorEventId !== null) {
      const target = current.timelineEvents.get(event.anchorEventId);
      if (!target) {
        issues.push(
          `${path}.anchorEventId: ID de evento da linha do tempo desconhecido ${event.anchorEventId} (só eventos listados no contexto ainda sem âncora de capítulo; evento novo usa null)`,
        );
      } else if (target.outlineNodeId !== null) {
        issues.push(
          `${path}.anchorEventId: o evento ${target.id} já está ancorado a um capítulo e não pode ser ancorado de novo (se este capítulo só o menciona, cite-o em causeEventIds; evento novo usa null)`,
        );
      } else if (normalizeTitle(target.title) !== normalizeTitle(event.title)) {
        issues.push(
          `${path}.title: ao ancorar um evento existente, title deve copiar exatamente o título “${target.title}”`,
        );
      }
      if (anchoredEventIds.has(event.anchorEventId)) {
        issues.push(
          `${path}.anchorEventId: o mesmo evento ${event.anchorEventId} só pode ser ancorado uma vez`,
        );
      }
      anchoredEventIds.add(event.anchorEventId);
      if (event.description !== null) {
        issues.push(
          `${path}.description: ao ancorar um evento existente, description deve ser null (o evento guarda a própria descrição)`,
        );
      }
      if (event.participantIds.length > 0 || event.causeEventIds.length > 0) {
        issues.push(
          `${path}.participantIds: ao ancorar um evento existente, participantIds e causeEventIds devem ser arrays vazios (o evento guarda participantes e causas)`,
        );
      }
    }
    issues.push(
      ...locator.validate(
        event.evidenceParagraphs,
        `timelineCandidates.${index}.evidenceParagraphs`,
      ),
    );
  });
  settlement.relationshipCandidates.forEach((relation, index) => {
    const path = `relationshipCandidates.${index}`;
    requireEntity(
      relation.fromEntityId,
      `relationshipCandidates.${index}.fromEntityId`,
    );
    if (relation.action === "start" && relation.relationshipId !== null) {
      issues.push(
        `${path}.relationshipId: start não pode citar uma relação existente`,
      );
    }
    if (relation.action !== "start") {
      const target = relation.relationshipId
        ? current.relationships.get(relation.relationshipId)
        : null;
      if (!target) {
        issues.push(
          `${path}.relationshipId: ${relation.action} deve citar o ID da relação atual`,
        );
      } else if (
        target.fromEntityId !== relation.fromEntityId ||
        target.toEntityId !== relation.toEntityId
      ) {
        issues.push(
          `${path}.relationshipId: as partes da relação citada não coincidem`,
        );
      }
    }
    requireEntity(
      relation.toEntityId,
      `relationshipCandidates.${index}.toEntityId`,
    );
    issues.push(
      ...locator.validate(
        relation.evidenceParagraphs,
        `relationshipCandidates.${index}.evidenceParagraphs`,
      ),
    );
  });
  settlement.foreshadowCandidates.forEach((foreshadow, index) => {
    const path = `foreshadowCandidates.${index}`;
    if (foreshadow.action === "plant") {
      if (foreshadow.foreshadowId !== null)
        issues.push(
          `${path}.foreshadowId: plant não pode citar uma antecipação existente (não preencha foreshadowId nem expectedStatus numa nova)`,
        );
      if (foreshadow.expectedStatus !== null)
        issues.push(
          `${path}.expectedStatus: plant não pode preencher um status existente (não preencha foreshadowId nem expectedStatus numa nova)`,
        );
    } else {
      const target = foreshadow.foreshadowId
        ? current.foreshadows.get(foreshadow.foreshadowId)
        : null;
      if (!target) {
        issues.push(
          `${path}.foreshadowId: ${foreshadow.action} deve citar o ID de uma antecipação existente`,
        );
      } else if (target.status !== foreshadow.expectedStatus) {
        issues.push(
          `${path}.expectedStatus: preencha o status atual da antecipação ${target.status} (checagem otimista de concorrência, não o status novo; o novo vem de action)`,
        );
      }
    }
    for (const [field, id] of [
      ["targetFromNodeId", foreshadow.targetFromNodeId],
      ["targetToNodeId", foreshadow.targetToNodeId],
    ] as const) {
      if (id && !current.outlineNodeIds.has(id))
        issues.push(
          `${path}.${field}: ID de nó da estrutura desconhecido ${id} (só IDs marcados [node:…] no contexto)`,
        );
    }
    issues.push(
      ...locator.validate(
        foreshadow.evidenceParagraphs,
        `foreshadowCandidates.${index}.evidenceParagraphs`,
      ),
    );
  });
  settlement.stateDelta.forEach((change, index) => {
    issues.push(
      ...locator.validate(
        change.evidenceParagraphs,
        `stateDelta.${index}.evidenceParagraphs`,
      ),
    );
  });
  return issues;
}

export function groundSettlementEvidence(
  settlement: Settlement,
  locator: ParagraphLocator,
): GroundedSettlement {
  return {
    ...settlement,
    stateDelta: settlement.stateDelta.map((change) => ({
      ...change,
      evidence: locateEvidence(locator, change.evidenceParagraphs),
    })),
    factCandidates: settlement.factCandidates.map((candidate) => ({
      ...candidate,
      evidence: locateEvidence(locator, candidate.evidenceParagraphs),
    })),
    timelineCandidates: settlement.timelineCandidates.map((candidate) => ({
      ...candidate,
      evidence: locateEvidence(locator, candidate.evidenceParagraphs),
    })),
    relationshipCandidates: settlement.relationshipCandidates.map(
      (candidate) => ({
        ...candidate,
        evidence: locateEvidence(locator, candidate.evidenceParagraphs),
      }),
    ),
    foreshadowCandidates: settlement.foreshadowCandidates.map((candidate) => ({
      ...candidate,
      evidence: locateEvidence(locator, candidate.evidenceParagraphs),
    })),
  };
}

type GroundedReviewResult = Omit<DerivedReviewResult, "issues"> & {
  issues: Array<
    DerivedReviewResult["issues"][number] & {
      evidence: GroundedParagraphEvidence[];
    }
  >;
};

function locateEvidence(
  locator: ParagraphLocator,
  ordinals: readonly number[],
): GroundedParagraphEvidence[] {
  try {
    return locator.locate(ordinals);
  } catch (error) {
    if (error instanceof ParagraphLocatorError) {
      throw permanent(error.code, error.message);
    }
    throw error;
  }
}

export function bindSettlementEvidence(
  settlement: GroundedSettlement,
  documentVersionId: string,
): GroundedSettlement {
  const bind = <T extends { evidence: GroundedParagraphEvidence[] }>(
    item: T,
  ) => ({
    ...item,
    evidence: bindEvidenceDocumentVersion(item.evidence, documentVersionId),
  });
  return {
    ...settlement,
    stateDelta: settlement.stateDelta.map(bind),
    factCandidates: settlement.factCandidates.map(bind),
    timelineCandidates: settlement.timelineCandidates.map(bind),
    relationshipCandidates: settlement.relationshipCandidates.map(bind),
    foreshadowCandidates: settlement.foreshadowCandidates.map(bind),
  };
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function settlementEntityIds(
  settlement: Record<string, unknown>,
): string[] {
  const ids = new Set<string>();
  for (const key of [
    "factCandidates",
    "timelineCandidates",
    "relationshipCandidates",
  ]) {
    const entries = Array.isArray(settlement[key]) ? settlement[key] : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      for (const field of [
        "subjectId",
        "objectEntityId",
        "fromEntityId",
        "toEntityId",
      ]) {
        if (typeof entry[field] === "string") ids.add(entry[field]);
      }
      if (Array.isArray(entry.participantIds)) {
        entry.participantIds.forEach((id) => {
          if (typeof id === "string") ids.add(id);
        });
      }
    }
  }
  return [...ids];
}

export function buildTextDiff(
  before: string,
  after: string,
): Record<string, unknown> {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    prefixCharacters: prefix,
    removed: before.slice(prefix, before.length - suffix),
    inserted: after.slice(prefix, after.length - suffix),
    suffixCharacters: suffix,
  };
}

export function cleanManuscript(value: string): string {
  return value
    .trim()
    .replace(/^```(?:markdown|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function revisionManuscript(value: string): string {
  const fenced =
    /^\s*```(?:markdown|text)?[\t ]*\r?\n([\s\S]*?)\r?\n```\s*$/iu.exec(value);
  return fenced?.[1] ?? value;
}

/**
 * Empty output means the model declines to change the manuscript. Apart from
 * CRLF/CR normalization, every whitespace/indentation/paragraph edit remains
 * a real revision.
 */
export function isRevisionNoop(base: string, candidate: string): boolean {
  return (
    candidate.length === 0 ||
    normalizeLineEndings(candidate) === normalizeLineEndings(base)
  );
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function repeatedPhraseEvidence(
  content: string,
  phraseLength: number,
  threshold: number,
): string | null {
  const normalized = content.replace(/\s+/g, "");
  const counts = new Map<string, number>();
  for (let index = 0; index + phraseLength <= normalized.length; index += 3) {
    const phrase = normalized.slice(index, index + phraseLength);
    if (/^[\p{P}\p{S}]+$/u.test(phrase)) continue;
    const count = (counts.get(phrase) ?? 0) + 1;
    if (count >= threshold) return phrase;
    counts.set(phrase, count);
  }
  return null;
}

/**
 * Word-window variant for space-delimited scripts. A character window there
 * catches names ("Lady Catherine" with the spaces removed is 13 letters), so
 * it counts runs of whole words instead.
 */
export function repeatedWordPhraseEvidence(
  content: string,
  phraseWords: number,
  threshold: number,
): string | null {
  const words =
    content
      .normalize("NFC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  const counts = new Map<string, number>();
  for (let index = 0; index + phraseWords <= words.length; index += 1) {
    const phrase = words.slice(index, index + phraseWords).join(" ");
    const count = (counts.get(phrase) ?? 0) + 1;
    if (count >= threshold) return phrase;
    counts.set(phrase, count);
  }
  return null;
}

/** True when Han, kana or Hangul make up at least half of the letters. */
export function isMostlyCjk(content: string): boolean {
  const letters = content.match(/\p{L}/gu)?.length ?? 0;
  const cjk =
    content.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    )?.length ?? 0;
  return letters > 0 && cjk * 2 >= letters;
}

export function paragraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function policyNumber(
  policy: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/**
 * Reads the continuation prefix persisted in run.policy by the partial
 * continue endpoint. Blank/missing values mean a normal from-scratch draft.
 */
export function continuationPrefixOf(
  policy: Readonly<Record<string, unknown>>,
): string | null {
  const value = policy.continuationPrefix;
  return typeof value === "string" && value.trim() ? value : null;
}

export function stringField(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw permanent(
      "artifact.field.invalid",
      `Artifact field ${key} is not a string`,
    );
  }
  return field;
}

export function purposeContextText(
  artifact: Record<string, unknown>,
  purpose: string,
): string {
  const contexts = artifact.contexts;
  if (!isRecord(contexts) || !isRecord(contexts[purpose])) {
    throw permanent(
      "context.purpose.missing",
      `Missing the dedicated context for purpose ${purpose}`,
    );
  }
  return stringField(contexts[purpose], "text");
}

export function isOutputLimitFinish(value: unknown): boolean {
  return value === "length" || value === "context_length";
}

export function stableContextInventory(
  sources: readonly ContextSource[],
): string {
  return JSON.stringify(
    sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      label: source.label,
      content: source.content,
      summary: source.summary ?? null,
      authority: source.authority,
      priority: source.priority,
      required: source.required ?? false,
      compressible: source.compressible ?? true,
      sourceType: source.sourceType,
      sourceId: source.sourceId ?? null,
      metadata: source.metadata ?? null,
    })),
  );
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function chapterWritingReference(
  artifact: Readonly<Record<string, unknown>>,
): { targetCharacters: number; compassVersion: number } | null {
  const reference = artifact.chapterWritingReference;
  if (!isRecord(reference)) return null;
  const targetCharacters = reference.targetCharacters;
  const compassVersion = reference.compassVersion;
  return typeof targetCharacters === "number" &&
    Number.isInteger(targetCharacters) &&
    targetCharacters > 0 &&
    typeof compassVersion === "number" &&
    Number.isInteger(compassVersion) &&
    compassVersion > 0
    ? { targetCharacters, compassVersion }
    : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sha256(value: string): string {
  return sha256Hex(value);
}

export function zeroUsage(): RunBudgetUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
}

export function permanent(code: string, message: string) {
  return { code, message, retryable: false };
}

export function retryable(code: string, message: string) {
  return { code, message, retryable: true };
}
