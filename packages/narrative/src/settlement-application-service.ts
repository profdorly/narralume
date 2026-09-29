import { createCanonFact, type CanonFact } from "@narralume/domain";
import {
  CanonChangeSetDecisionConflictError,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type CanonChangeSetView,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import {
  GroundedParagraphEvidenceSchema,
  GroundedSettlementSchema,
  type GroundedSettlement,
} from "./schemas.js";

export type SettlementConflictPolicy = "reject" | "force";

/**
 * Change-set payload key holding the outline chapter a manual settlement
 * settled, recorded when the change set is committed (workers.ts
 * commitManualSettlement) so the anchor does not depend on the document's
 * binding at apply time.
 */
export const SETTLED_OUTLINE_NODE_KEY = "settledOutlineNodeId";

/**
 * An existing record a change set would withdraw, supersede, update, end or
 * resolve when applied, with the provenance the store keeps for it.
 */
export interface SettlementChangedRecord {
  /** Candidate path inside the change set, e.g. `factCandidates.0`. */
  path: string;
  kind: "fact" | "relationship" | "foreshadow";
  action: "withdraw" | "supersede" | "update" | "end" | "develop" | "resolve";
  id: string;
  /** Short author-facing description of the record. */
  label: string;
  /**
   * Change set that created the record, when its provenance says so (a fact's
   * source, a relationship's or foreshadow's source id, or a
   * settlement-created foreshadow's id); null when it came from elsewhere or
   * the store keeps no provenance.
   */
  createdByChangeSetId: string | null;
  /**
   * The record's own source reference (for relationships and foreshadows the
   * import candidate or change set that created it); null when none is stored.
   */
  sourceType: string | null;
  sourceId: string | null;
  /**
   * Foreshadows only: applying would move a resolved or abandoned foreshadow
   * out of that status (a develop reopens it, a resolve revives an abandoned
   * one).
   */
  reopens?: boolean;
}

export interface SettlementApplicationResult {
  changeSet: CanonChangeSetView;
  applied: {
    factIds: string[];
    timelineEventIds: string[];
    relationshipEventIds: string[];
    foreshadowIds: string[];
  };
  conflicts: Array<{
    path: string;
    existingIds: string[];
    reason: string;
  }>;
}

const CoCreateChangesSchema = z.object({
  source: z.literal("cocreate-adoption"),
  summary: z.string(),
  candidates: z.array(
    z.object({
      subjectName: z.string().min(1),
      predicate: z.string().min(1),
      value: z.string().min(1),
      evidenceParagraphs: z.array(z.number().int().positive()).min(1).max(5),
      evidence: z.array(GroundedParagraphEvidenceSchema).min(1).max(5),
      rationale: z.string().min(1),
    }),
  ),
});

export class SettlementApplicationService {
  private readonly canon: SqliteCanonRepository;
  private readonly story: SqliteStoryRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly runs: SqliteRunRepository;
  private readonly documents: SqliteDocumentRepository;

  constructor(private readonly database: NarrativeDatabase) {
    this.canon = new SqliteCanonRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
    this.reviews = new SqliteReviewRepository(database);
    this.runs = new SqliteRunRepository(database);
  }

  apply(input: {
    projectId: string;
    changeSetId: string;
    conflictPolicy?: SettlementConflictPolicy;
    now?: string;
  }): SettlementApplicationResult {
    const now = input.now ?? new Date().toISOString();
    const conflictPolicy = input.conflictPolicy ?? "reject";
    return this.database.transaction(() => {
      const changeSet = this.reviews.requireCanonChangeSet(
        input.projectId,
        input.changeSetId,
      );
      if (changeSet.status !== "candidate") {
        throw new CanonChangeSetDecisionConflictError(
          changeSet.id,
          "candidate",
          changeSet.status,
        );
      }
      const result = emptyResult(changeSet);
      const settlement = GroundedSettlementSchema.safeParse(changeSet.changes);
      if (settlement.success) {
        this.applyChapterSettlement(
          changeSet,
          settlement.data,
          conflictPolicy,
          now,
          result,
        );
      } else {
        const adoption = CoCreateChangesSchema.safeParse(changeSet.changes);
        if (!adoption.success) {
          throw new SettlementApplicationError(
            "settlement.changes.invalid",
            `Unsupported change-set payload: ${settlement.error.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          );
        }
        this.applyCoCreateSettlement(
          changeSet,
          adoption.data,
          conflictPolicy,
          now,
          result,
        );
      }
      if (result.conflicts.length > 0) {
        throw new SettlementConflictError(result.conflicts);
      }
      result.changeSet = this.reviews.decideCanonChangeSet({
        projectId: input.projectId,
        changeSetId: changeSet.id,
        expectedStatus: changeSet.status,
        status: "applied",
        now,
      });
      return result;
    });
  }

  reject(input: {
    projectId: string;
    changeSetId: string;
    expectedStatus?: "candidate";
    now?: string;
  }): CanonChangeSetView {
    return this.reviews.decideCanonChangeSet({
      projectId: input.projectId,
      changeSetId: input.changeSetId,
      expectedStatus: input.expectedStatus ?? "candidate",
      status: "rejected",
      now: input.now ?? new Date().toISOString(),
    });
  }

  /**
   * Existing records applying a candidate change set now would withdraw,
   * supersede, update, end, develop or resolve. Only targets apply() would
   * change are listed: a missing, stale, locked, mismatched or
   * status-changed target is reported by apply() as a conflict instead. A
   * payload apply() cannot read lists nothing (apply() refuses it).
   */
  changedExistingRecords(
    projectId: string,
    changeSetId: string,
  ): SettlementChangedRecord[] {
    const changeSet = this.reviews.requireCanonChangeSet(
      projectId,
      changeSetId,
    );
    const parsed = GroundedSettlementSchema.safeParse(changeSet.changes);
    if (!parsed.success) return [];
    const settlement = parsed.data;
    const records: SettlementChangedRecord[] = [];
    const name = (entityId: string | null) =>
      entityId
        ? (this.canon.getEntity(projectId, entityId)?.name ?? entityId)
        : "";

    settlement.factCandidates.forEach((candidate, index) => {
      if (candidate.operation === "assert" || !candidate.factId) return;
      const current = this.canon.getFact(projectId, candidate.factId);
      if (
        !current ||
        !this.isEffectiveFact(current) ||
        current.subjectId !== candidate.subjectId ||
        current.predicate !== candidate.predicate ||
        current.authority === "locked"
      ) {
        return;
      }
      const value = current.objectEntityId
        ? name(current.objectEntityId)
        : typeof current.value === "string"
          ? current.value
          : JSON.stringify(current.value);
      records.push({
        path: `factCandidates.${index}`,
        kind: "fact",
        action: candidate.operation,
        id: current.id,
        label: `${name(current.subjectId)} · ${current.predicate}: ${value}`,
        // Applied settlement facts are `${changeSetId}:fact:${index}`.
        createdByChangeSetId:
          current.sourceType === "canon_change_set"
            ? this.creatingChangeSet(
                projectId,
                current.id,
                current.sourceId,
                "fact",
              )
            : null,
        sourceType: current.sourceType,
        sourceId: current.sourceId,
      });
    });

    const currentRelationships = this.state.listCurrentRelationships(projectId);
    settlement.relationshipCandidates.forEach((candidate, index) => {
      if (candidate.action === "start" || !candidate.relationshipId) return;
      const previous = currentRelationships.find(
        (event) => event.id === candidate.relationshipId,
      );
      if (
        !previous ||
        previous.fromEntityId !== candidate.fromEntityId ||
        previous.toEntityId !== candidate.toEntityId
      ) {
        return;
      }
      records.push({
        path: `relationshipCandidates.${index}`,
        kind: "relationship",
        action: candidate.action,
        id: previous.id,
        label: `${name(previous.fromEntityId)} → ${name(previous.toEntityId)}: ${previous.relation}`,
        // Settlement-created rows are `${changeSetId}:relationship:${index}`.
        createdByChangeSetId: this.creatingChangeSet(
          projectId,
          previous.id,
          previous.sourceId,
          "relationship",
        ),
        sourceType: null,
        sourceId: previous.sourceId,
      });
    });

    const foreshadows = this.state.listForeshadows(projectId);
    settlement.foreshadowCandidates.forEach((candidate, index) => {
      if (candidate.action === "plant" || !candidate.foreshadowId) return;
      const existing = foreshadows.find(
        (item) => item.id === candidate.foreshadowId,
      );
      if (!existing || candidate.expectedStatus !== existing.status) return;
      const next = candidate.action === "resolve" ? "resolved" : "developing";
      // Settlement-created foreshadows record their change set as source;
      // before migration 047 only their id (`${changeSetId}:foreshadow:${index}`)
      // said where they came from.
      const prefix = /^(.+):foreshadow:\d+$/.exec(existing.id)?.[1] ?? null;
      records.push({
        path: `foreshadowCandidates.${index}`,
        kind: "foreshadow",
        action: candidate.action,
        id: existing.id,
        label: existing.title,
        createdByChangeSetId: this.creatingChangeSet(
          projectId,
          existing.id,
          existing.sourceId ?? prefix,
          "foreshadow",
        ),
        sourceType: null,
        sourceId: existing.sourceId,
        reopens:
          ["resolved", "abandoned"].includes(existing.status) &&
          existing.status !== next,
      });
    });
    return records;
  }

  /** The change set whose application created a row, verified by its id shape. */
  private creatingChangeSet(
    projectId: string,
    rowId: string,
    changeSetId: string | null,
    kind: "fact" | "relationship" | "foreshadow",
  ): string | null {
    if (!changeSetId || !rowId.startsWith(`${changeSetId}:${kind}:`)) {
      return null;
    }
    return this.reviews.getCanonChangeSet(projectId, changeSetId)
      ? changeSetId
      : null;
  }

  private applyChapterSettlement(
    changeSet: CanonChangeSetView,
    settlement: GroundedSettlement,
    conflictPolicy: SettlementConflictPolicy,
    now: string,
    result: MutableApplicationResult,
  ): void {
    const outlineNodeId = this.settlementAnchor(changeSet);
    settlement.factCandidates.forEach((candidate, index) => {
      const path = `factCandidates.${index}`;
      const current = candidate.factId
        ? this.canon.getFact(changeSet.projectId, candidate.factId)
        : null;
      if (candidate.operation === "withdraw") {
        if (!current || !this.isEffectiveFact(current)) {
          this.addConflict(
            result,
            path,
            candidate.factId,
            "target_not_current",
          );
          return;
        }
        if (
          current.subjectId !== candidate.subjectId ||
          current.predicate !== candidate.predicate
        ) {
          this.addConflict(result, path, current.id, "target_slot_mismatch");
          return;
        }
        if (current.authority === "locked" && conflictPolicy !== "force") {
          this.addConflict(result, path, current.id, "target_locked");
          return;
        }
        this.canon.withdrawFact({
          factId: current.id,
          projectId: changeSet.projectId,
          reason: `withdrawn by change set ${changeSet.id}`,
          withdrawnAt: now,
        });
        result.applied.factIds.push(current.id);
        return;
      }
      const fact = createCanonFact({
        id: `${changeSet.id}:fact:${index}`,
        projectId: changeSet.projectId,
        subjectId: candidate.subjectId,
        predicate: candidate.predicate,
        ...(candidate.objectEntityId
          ? { objectEntityId: candidate.objectEntityId }
          : { value: candidate.value }),
        validFromNodeId: outlineNodeId,
        knowledgeScope: candidate.knowledgeScope,
        knowledgeSubjectId: candidate.knowledgeSubjectId,
        authority: "confirmed",
        confidence: 1,
        sourceType: "canon_change_set",
        sourceId: changeSet.id,
        supersedesFactId:
          candidate.operation === "supersede" ? candidate.factId : null,
        now,
      });
      const appliedFact = this.applyFact(fact, path, conflictPolicy, result);
      if (
        appliedFact &&
        outlineNodeId &&
        ["reader", "character"].includes(candidate.knowledgeScope)
      ) {
        this.state.insertKnowledge({
          id: `${changeSet.id}:knowledge:fact:${index}`,
          projectId: changeSet.projectId,
          knowerType:
            candidate.knowledgeScope === "reader" ? "reader" : "character",
          knowerEntityId: candidate.knowledgeSubjectId,
          factId: appliedFact.factId,
          timelineEventId: null,
          learnedAtNodeId: outlineNodeId,
          belief: candidate.belief,
          sourceId: changeSet.id,
          createdAt: now,
        });
      }
    });

    let nextSequence =
      this.state
        .listTimeline(changeSet.projectId)
        .reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
    settlement.timelineCandidates.forEach((candidate, index) => {
      const id = `${changeSet.id}:timeline:${index}`;
      if (
        this.state
          .listTimeline(changeSet.projectId)
          .some((event) => event.id === id)
      ) {
        return;
      }
      this.state.insertTimelineEvent({
        id,
        projectId: changeSet.projectId,
        title: candidate.title,
        description: candidate.description,
        outlineNodeId,
        storyTimeStart: candidate.storyTime,
        storyTimeEnd: candidate.storyTime,
        sequence: nextSequence,
        participants: candidate.participantIds,
        causes: candidate.causeEventIds,
        visibility: candidate.visibility,
        sourceId: changeSet.id,
        createdAt: now,
        updatedAt: now,
      });
      nextSequence += 1;
      result.applied.timelineEventIds.push(id);
      if (outlineNodeId) {
        candidate.knownBy.forEach((knowledge, knowledgeIndex) => {
          this.state.insertKnowledge({
            id: `${changeSet.id}:knowledge:timeline:${index}:${knowledgeIndex}`,
            projectId: changeSet.projectId,
            knowerType: "character",
            knowerEntityId: knowledge.entityId,
            factId: null,
            timelineEventId: id,
            learnedAtNodeId: outlineNodeId,
            belief: knowledge.belief,
            sourceId: changeSet.id,
            createdAt: now,
          });
        });
      }
    });

    settlement.relationshipCandidates.forEach((candidate, index) => {
      const path = `relationshipCandidates.${index}`;
      const previous = candidate.relationshipId
        ? this.state.getRelationship(
            changeSet.projectId,
            candidate.relationshipId,
          )
        : null;
      if (candidate.action !== "start") {
        if (
          !previous ||
          !this.state
            .listCurrentRelationships(changeSet.projectId)
            .some((event) => event.id === previous.id)
        ) {
          this.addConflict(
            result,
            path,
            candidate.relationshipId,
            "target_not_current",
          );
          return;
        }
        if (
          previous.fromEntityId !== candidate.fromEntityId ||
          previous.toEntityId !== candidate.toEntityId
        ) {
          this.addConflict(result, path, previous.id, "target_pair_mismatch");
          return;
        }
      } else if (candidate.relationshipId) {
        this.addConflict(
          result,
          path,
          candidate.relationshipId,
          "start_must_not_target_existing",
        );
        return;
      }
      const id = `${changeSet.id}:relationship:${index}`;
      if (
        this.state
          .listCurrentRelationships(changeSet.projectId)
          .some((event) => event.id === id)
      ) {
        return;
      }
      this.state.insertRelationship({
        id,
        projectId: changeSet.projectId,
        fromEntityId: candidate.fromEntityId,
        toEntityId: candidate.toEntityId,
        relation: candidate.relation,
        intensity: null,
        state: {
          change: candidate.change,
          status: candidate.action === "end" ? "ended" : "active",
        },
        outlineNodeId,
        storyTime: null,
        sourceId: changeSet.id,
        supersedesEventId: previous?.id ?? null,
        createdAt: now,
      });
      result.applied.relationshipEventIds.push(id);
    });

    settlement.foreshadowCandidates.forEach((candidate, index) => {
      const path = `foreshadowCandidates.${index}`;
      const existing = candidate.foreshadowId
        ? this.state
            .listForeshadows(changeSet.projectId)
            .find((item) => item.id === candidate.foreshadowId)
        : null;
      if (candidate.action !== "plant") {
        if (!existing) {
          this.addConflict(
            result,
            path,
            candidate.foreshadowId,
            "target_not_found",
          );
          return;
        }
        if (
          candidate.expectedStatus !== existing.status &&
          conflictPolicy !== "force"
        ) {
          this.addConflict(result, path, existing.id, "status_changed");
          return;
        }
        const evidenceNodeIds = outlineNodeId
          ? [...new Set([...existing.evidenceNodeIds, outlineNodeId])]
          : [...existing.evidenceNodeIds];
        this.state.updateForeshadow({
          ...existing,
          status: candidate.action === "resolve" ? "resolved" : "developing",
          evidenceNodeIds,
          resolutionNodeId:
            candidate.action === "resolve"
              ? outlineNodeId
              : existing.resolutionNodeId,
          updatedAt: now,
        });
        result.applied.foreshadowIds.push(existing.id);
        return;
      }
      if (candidate.foreshadowId) {
        this.addConflict(
          result,
          path,
          candidate.foreshadowId,
          "plant_must_not_target_existing",
        );
        return;
      }
      const id = `${changeSet.id}:foreshadow:${index}`;
      this.state.insertForeshadow({
        id,
        projectId: changeSet.projectId,
        title: candidate.title,
        description: candidate.evidence.map((item) => item.quote).join("\n\n"),
        status: "planted",
        importance: candidate.importance,
        targetFromNodeId: candidate.targetFromNodeId ?? outlineNodeId,
        targetToNodeId: candidate.targetToNodeId,
        dependencies: [],
        evidenceNodeIds: outlineNodeId ? [outlineNodeId] : [],
        resolutionNodeId: null,
        sourceId: changeSet.id,
        createdAt: now,
        updatedAt: now,
      });
      result.applied.foreshadowIds.push(id);
    });
  }

  /**
   * The chapter a settlement's facts, knowledge, timeline, relationship and
   * foreshadow rows are anchored to. Chapter-production runs carry it as
   * targetOutlineNodeId. Manual settlements deliberately keep that null (they
   * must not take the writing-chain mutex); their change set records the
   * chapter that was settled (SETTLED_OUTLINE_NODE_KEY), so re-binding or
   * deleting the document afterwards neither moves nor blocks the anchor. A
   * manual settlement whose chapter no longer exists is refused instead of
   * being applied unanchored.
   */
  private settlementAnchor(changeSet: CanonChangeSetView): string | null {
    const run = this.runs.getRun(changeSet.runId);
    if (!run) return null;
    if (run.targetOutlineNodeId) return run.targetOutlineNodeId;
    if (run.recipe !== "manual-settlement") return null;
    const recorded = changeSet.changes[SETTLED_OUTLINE_NODE_KEY];
    let outlineNodeId: string | null;
    if (typeof recorded === "string" && recorded) {
      outlineNodeId = recorded;
    } else {
      // Legacy fallback, only for manual change sets committed before the
      // settled chapter was recorded in the payload: resolve it from the
      // document's current outline binding.
      const documentId =
        typeof run.policy.documentId === "string"
          ? run.policy.documentId
          : null;
      const document = documentId
        ? this.documents.get(changeSet.projectId, documentId)
        : null;
      outlineNodeId = document?.outlineNodeId ?? null;
    }
    if (
      !outlineNodeId ||
      !this.story.getOutlineNode(changeSet.projectId, outlineNodeId)
    ) {
      throw new SettlementApplicationError(
        "settlement.anchor.missing",
        "The settled chapter no longer exists, so these story changes cannot be anchored to it",
      );
    }
    return outlineNodeId;
  }

  private applyCoCreateSettlement(
    changeSet: CanonChangeSetView,
    adoption: z.infer<typeof CoCreateChangesSchema>,
    conflictPolicy: SettlementConflictPolicy,
    now: string,
    result: MutableApplicationResult,
  ): void {
    const entities = this.canon.listEntities(changeSet.projectId);
    adoption.candidates.forEach((candidate, index) => {
      const entity = entities.find(
        (item) =>
          normalize(item.name) === normalize(candidate.subjectName) ||
          item.aliases.some(
            (alias) => normalize(alias) === normalize(candidate.subjectName),
          ),
      );
      if (!entity) {
        this.addConflict(
          result,
          `candidates.${index}.subjectName`,
          null,
          `unknown_entity:${candidate.subjectName}`,
        );
        return;
      }
      const fact = createCanonFact({
        id: `${changeSet.id}:fact:${index}`,
        projectId: changeSet.projectId,
        subjectId: entity.id,
        predicate: candidate.predicate,
        value: candidate.value,
        authority: "confirmed",
        confidence: 1,
        knowledgeScope: "reader",
        sourceType: "canon_change_set",
        sourceId: changeSet.id,
        now,
      });
      this.applyFact(fact, `candidates.${index}`, conflictPolicy, result);
    });
  }

  private applyFact(
    fact: CanonFact,
    path: string,
    conflictPolicy: SettlementConflictPolicy,
    result: MutableApplicationResult,
  ): { factId: string; inserted: boolean } | null {
    if (this.canon.getFact(fact.projectId, fact.id)) {
      return { factId: fact.id, inserted: false };
    }
    const currentFacts = this.canon.listEffectiveFacts(fact.projectId, {
      subjectId: fact.subjectId,
      includeCandidates: false,
    });
    const explicitTarget = fact.supersedesFactId
      ? this.canon.getFact(fact.projectId, fact.supersedesFactId)
      : null;
    if (fact.supersedesFactId) {
      if (!explicitTarget || !this.isEffectiveFact(explicitTarget)) {
        this.addConflict(
          result,
          path,
          fact.supersedesFactId,
          "target_not_current",
        );
        return null;
      }
      if (
        explicitTarget.subjectId !== fact.subjectId ||
        explicitTarget.predicate !== fact.predicate
      ) {
        this.addConflict(
          result,
          path,
          explicitTarget.id,
          "target_slot_mismatch",
        );
        return null;
      }
      if (explicitTarget.authority === "locked" && conflictPolicy !== "force") {
        this.addConflict(result, path, explicitTarget.id, "target_locked");
        return null;
      }
    } else {
      const existing = currentFacts.find((candidate) =>
        sameProposition(candidate, fact),
      );
      if (existing) return { factId: existing.id, inserted: false };
    }
    this.canon.insertFact({
      ...fact,
      supersedesFactId: explicitTarget?.id ?? null,
    });
    result.applied.factIds.push(fact.id);
    return { factId: fact.id, inserted: true };
  }

  private isEffectiveFact(fact: CanonFact): boolean {
    return this.canon
      .listEffectiveFacts(fact.projectId, {
        subjectId: fact.subjectId,
        includeCandidates: true,
      })
      .some((candidate) => candidate.id === fact.id);
  }

  private addConflict(
    result: MutableApplicationResult,
    path: string,
    existingId: string | null,
    reason: string,
  ): void {
    result.conflicts.push({
      path,
      existingIds: existingId ? [existingId] : [],
      reason,
    });
  }
}

type MutableApplicationResult = SettlementApplicationResult;

function emptyResult(changeSet: CanonChangeSetView): MutableApplicationResult {
  return {
    changeSet,
    applied: {
      factIds: [],
      timelineEventIds: [],
      relationshipEventIds: [],
      foreshadowIds: [],
    },
    conflicts: [],
  };
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sameProposition(left: CanonFact, right: CanonFact): boolean {
  return (
    left.subjectId === right.subjectId &&
    left.predicate === right.predicate &&
    left.objectEntityId === right.objectEntityId &&
    stableValue(left.value) === stableValue(right.value)
  );
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
}

export class SettlementApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SettlementApplicationError";
  }
}

export class SettlementConflictError extends SettlementApplicationError {
  constructor(readonly conflicts: SettlementApplicationResult["conflicts"]) {
    super(
      "settlement.conflict",
      `Settlement conflicts with ${conflicts.length} existing canon fact(s)`,
    );
    this.name = "SettlementConflictError";
  }
}
