import { sha256Hex, type Document } from "@narralume/domain";

import { SqliteCanonRepository } from "./canon-repository.js";
import type { NarrativeDatabase } from "./database.js";
import { SqliteDocumentRepository } from "./document-repository.js";
import { buildEntityMentionMatcher } from "./entity-mentions.js";
import { chunkManuscript } from "./passage-chunker.js";
import {
  SqliteRetrievalRepository,
  segmentContentHash,
  type DocumentSegmentState,
  type SegmentEmbeddingCounts,
} from "./retrieval-repository.js";

/** One retrieval segment per passage of a manuscript document. */
export const DOCUMENT_PASSAGE_SOURCE = "document_passage";
/** Pre-passage index: one segment holding the whole chapter. */
export const LEGACY_DOCUMENT_SOURCE = "document_current";
/** Bump to re-chunk every manuscript on the next sync. */
export const PASSAGE_INDEX_VERSION = 1;
/* Entities a settlement attributes to the chapter but no passage names. */
const SETTLEMENT_LINK_WEIGHT = 0.5;

export interface PlannedPassage {
  segmentId: string;
  sourceId: string;
  ordinal: number;
  text: string;
  start: number;
  end: number;
  /** segmentContentHash(title, text): what a stored vector is checked against. */
  contentHash: string;
}

export interface IndexDocumentInput {
  projectId: string;
  documentId: string;
  /** Defaults to the document's current version. */
  versionId?: string;
  /**
   * Chapter-level entities from a settlement of this version; linked to the
   * passages that do not name them, at a reduced weight.
   */
  settlementEntityIds?: readonly string[];
  /** Extra provenance stored with each passage (runId, proposal id...). */
  provenance?: Readonly<Record<string, unknown>>;
  now: string;
}

export interface IndexDocumentResult {
  passages: PlannedPassage[];
  removed: number;
}

export interface ManuscriptSyncResult {
  indexed: number;
  relinked: number;
  removed: number;
}

export interface ManuscriptIndexStatus {
  /** Manuscript documents bound to the outline, not in the trash. */
  documents: number;
  /** Documents whose passages match the current version. */
  indexedDocuments: number;
  passages: number;
  /** Whole-chapter segments from the previous index, replaced on sync. */
  legacySegments: number;
  embeddings: SegmentEmbeddingCounts;
}

/**
 * Keeps the retrieval index of the manuscript in step with document
 * versions: each chapter or scene is cut into passages (see
 * chunkManuscript), linked to the canon entities it names, and written as
 * content-addressed segments so passages that did not change keep their
 * vectors across edits. Embedding itself happens in the narrative workers,
 * which own the model client.
 */
export class SqliteManuscriptIndexer {
  private readonly documents: SqliteDocumentRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly retrieval: SqliteRetrievalRepository;

  constructor(private readonly database: NarrativeDatabase) {
    this.documents = new SqliteDocumentRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.retrieval = new SqliteRetrievalRepository(database);
  }

  /** Deterministic passages for a version, before anything is written. */
  planPassages(
    documentId: string,
    title: string,
    content: string,
  ): PlannedPassage[] {
    const seen = new Map<string, number>();
    return chunkManuscript(content).map((passage) => {
      const digest = sha256Hex(passage.text).slice(0, 16);
      const duplicate = seen.get(digest) ?? 0;
      seen.set(digest, duplicate + 1);
      const key = duplicate === 0 ? digest : `${digest}-${duplicate}`;
      return {
        segmentId: `document:${documentId}:passage:${key}`,
        sourceId: `${documentId}#${key}`,
        ordinal: passage.ordinal,
        text: passage.text,
        start: passage.start,
        end: passage.end,
        contentHash: segmentContentHash(title, passage.text),
      };
    });
  }

  indexDocument(input: IndexDocumentInput): IndexDocumentResult {
    return this.database.transaction(() => {
      const document = this.documents.get(input.projectId, input.documentId);
      const versionId = input.versionId ?? document?.currentVersionId ?? null;
      const version =
        document && document.outlineNodeId && versionId
          ? this.documents.getVersion(input.projectId, document.id, versionId)
          : null;
      if (!document || !document.outlineNodeId || !version) {
        return {
          passages: [],
          removed: this.removeDocument(input.projectId, input.documentId),
        };
      }
      const existing = this.retrieval.listDocumentSegmentStates(
        input.projectId,
        [DOCUMENT_PASSAGE_SOURCE, LEGACY_DOCUMENT_SOURCE],
      );
      const own = existing.filter((state) => state.documentId === document.id);
      const settlementEntityIds =
        input.settlementEntityIds ??
        this.carriedSettlementEntityIds(
          input.projectId,
          document.id,
          version.id,
        );
      const entities = this.canon.listEntities(input.projectId);
      const fingerprint = entityFingerprint(entities);
      const mentions = buildEntityMentionMatcher(entities);
      const knownEntityIds = new Set(entities.map((entity) => entity.id));
      const settlementLinks = [...new Set(settlementEntityIds)].filter((id) =>
        knownEntityIds.has(id),
      );
      const planned = this.planPassages(
        document.id,
        document.title,
        version.content,
      );
      for (const passage of planned) {
        const counts = mentions(passage.text);
        const entityWeights: Record<string, number> = {};
        for (const id of counts.keys()) entityWeights[id] = 1;
        for (const id of settlementLinks)
          entityWeights[id] ??= SETTLEMENT_LINK_WEIGHT;
        this.retrieval.upsertSegment({
          id: passage.segmentId,
          projectId: input.projectId,
          sourceType: DOCUMENT_PASSAGE_SOURCE,
          sourceId: passage.sourceId,
          title: document.title,
          content: passage.text,
          authority: "confirmed",
          metadata: {
            ...input.provenance,
            documentId: document.id,
            documentVersionId: version.id,
            outlineNodeId: document.outlineNodeId,
            passageIndex: passage.ordinal,
            passageCount: planned.length,
            charStart: passage.start,
            charEnd: passage.end,
            indexVersion: PASSAGE_INDEX_VERSION,
            entityFingerprint: fingerprint,
            settlementEntityIds: settlementLinks,
          },
          entityIds: Object.keys(entityWeights),
          entityWeights,
          createdAt: input.now,
          updatedAt: input.now,
        });
      }
      const keep = new Set(planned.map((passage) => passage.segmentId));
      const removed = this.retrieval.deleteSegments(
        input.projectId,
        own
          .filter((state) => !keep.has(state.segmentId))
          .map((state) => state.segmentId),
      );
      return { passages: planned, removed };
    });
  }

  removeDocument(projectId: string, documentId: string): number {
    return this.retrieval.deleteSegments(
      projectId,
      this.retrieval
        .listDocumentSegmentStates(projectId, [
          DOCUMENT_PASSAGE_SOURCE,
          LEGACY_DOCUMENT_SOURCE,
        ])
        .filter((state) => state.documentId === documentId)
        .map((state) => state.segmentId),
    );
  }

  /**
   * Brings the whole project index up to date: documents edited, restored or
   * imported without indexing, legacy whole-chapter segments, renamed
   * chapters and canon entity changes (relinking only). Cheap when nothing
   * changed: it compares stored version ids and fingerprints, not text.
   */
  syncProject(projectId: string, now: string): ManuscriptSyncResult {
    const plan = this.syncPlan(projectId);
    let indexed = 0;
    let relinked = 0;
    let removed = 0;
    this.database.transaction(() => {
      for (const document of plan.reindex) {
        removed += this.indexDocument({
          projectId,
          documentId: document.id,
          now,
        }).removed;
        indexed += 1;
      }
      for (const document of plan.relink) {
        this.indexDocument({ projectId, documentId: document.id, now });
        relinked += 1;
      }
      removed += this.retrieval.deleteSegments(projectId, plan.orphans);
    });
    return { indexed, relinked, removed };
  }

  status(projectId: string): ManuscriptIndexStatus {
    const plan = this.syncPlan(projectId);
    const states = plan.states;
    return {
      documents: plan.eligible.length,
      indexedDocuments: plan.eligible.length - plan.reindex.length,
      passages: states.filter(
        (state) => state.sourceType === DOCUMENT_PASSAGE_SOURCE,
      ).length,
      legacySegments: states.filter(
        (state) => state.sourceType === LEGACY_DOCUMENT_SOURCE,
      ).length,
      embeddings: this.retrieval.embeddingCounts(projectId, [
        DOCUMENT_PASSAGE_SOURCE,
        LEGACY_DOCUMENT_SOURCE,
      ]),
    };
  }

  private syncPlan(projectId: string): {
    eligible: Document[];
    reindex: Document[];
    relink: Document[];
    orphans: string[];
    states: DocumentSegmentState[];
  } {
    const all = this.documents.list(projectId, undefined, true);
    const eligible = all.filter(
      (document) =>
        document.outlineNodeId !== null &&
        document.archivedAt === null &&
        document.currentVersionId !== null,
    );
    const states = this.retrieval.listDocumentSegmentStates(projectId, [
      DOCUMENT_PASSAGE_SOURCE,
      LEGACY_DOCUMENT_SOURCE,
    ]);
    const byDocument = new Map<string, DocumentSegmentState[]>();
    for (const state of states) {
      if (!state.documentId) continue;
      const list = byDocument.get(state.documentId) ?? [];
      list.push(state);
      byDocument.set(state.documentId, list);
    }
    const fingerprint = entityFingerprint(this.canon.listEntities(projectId));
    const reindex: Document[] = [];
    const relink: Document[] = [];
    for (const document of eligible) {
      const own = byDocument.get(document.id) ?? [];
      const passages = own.filter(
        (state) => state.sourceType === DOCUMENT_PASSAGE_SOURCE,
      );
      const hasLegacy = own.some(
        (state) => state.sourceType === LEGACY_DOCUMENT_SOURCE,
      );
      if (passages.length === 0 && !hasLegacy) {
        const version = this.documents.getVersion(
          projectId,
          document.id,
          document.currentVersionId!,
        );
        if (version && version.content.trim()) reindex.push(document);
        continue;
      }
      const current =
        !hasLegacy &&
        passages.every(
          (state) =>
            state.documentVersionId === document.currentVersionId &&
            state.indexVersion === PASSAGE_INDEX_VERSION &&
            state.title === document.title,
        );
      if (!current) reindex.push(document);
      else if (
        passages.some((state) => state.entityFingerprint !== fingerprint)
      )
        relink.push(document);
    }
    // Segments of documents that no longer exist or lost their outline node.
    const keepDocuments = new Set(
      all
        .filter((document) => document.outlineNodeId !== null)
        .map((document) => document.id),
    );
    const orphans = states
      .filter(
        (state) => state.documentId && !keepDocuments.has(state.documentId),
      )
      .map((state) => state.segmentId);
    return { eligible, reindex, relink, orphans, states };
  }

  /** Settlement links survive a re-index of the same version (relinking). */
  private carriedSettlementEntityIds(
    projectId: string,
    documentId: string,
    versionId: string,
  ): string[] {
    const carried = new Set<string>();
    for (const segment of this.retrieval.listSegments(projectId, {
      sourceTypes: [DOCUMENT_PASSAGE_SOURCE],
      documentId,
    })) {
      if (segment.metadata.documentVersionId !== versionId) continue;
      const ids = segment.metadata.settlementEntityIds;
      if (Array.isArray(ids))
        for (const id of ids) if (typeof id === "string") carried.add(id);
    }
    return [...carried];
  }
}

function entityFingerprint(
  entities: readonly { id: string; name: string; aliases: readonly string[] }[],
): string {
  return sha256Hex(
    JSON.stringify(
      [...entities]
        .map((entity) => [entity.id, entity.name, [...entity.aliases].sort()])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    ),
  ).slice(0, 16);
}
