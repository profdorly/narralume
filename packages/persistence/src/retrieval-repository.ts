import { sha256Hex } from "@lapis/domain";

import type { NarrativeDatabase } from "./database.js";
import { buildLexicalQuery } from "./lexical-query.js";
import { decodeVector, dot, encodeVector } from "./vector.js";

export type SegmentAuthority =
  "reference" | "draft" | "candidate" | "confirmed" | "locked";

/*
 * A segment is retrievable unless it belongs to an inactive narrative memory
 * or to a manuscript document that is archived (in the manuscript trash) or
 * gone. Segments without a documentId (memories, rules) are not affected.
 */
const ACTIVE_SEGMENT_PREDICATE = `(segment.source_type != 'narrative_memory'
  OR EXISTS (
    SELECT 1 FROM narrative_memories memory
    WHERE memory.id = segment.source_id
      AND memory.project_id = segment.project_id
      AND memory.status = 'active'
  ))
  AND (json_extract(segment.metadata_json, '$.documentId') IS NULL
    OR EXISTS (
      SELECT 1 FROM documents document
      WHERE document.id = json_extract(segment.metadata_json, '$.documentId')
        AND document.project_id = segment.project_id
        AND document.archived_at IS NULL
    ))`;

export interface TextSegment {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  title: string;
  content: string;
  authority: SegmentAuthority;
  metadata: Readonly<Record<string, unknown>>;
  entityIds: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface TextSegmentInput extends TextSegment {
  /** Link weight per entity id (default 1); used to rank entity matches. */
  entityWeights?: Readonly<Record<string, number>>;
}

export interface RetrievalHit extends TextSegment {
  lexicalRank: number | null;
  vectorRank: number | null;
  entityScore: number;
  vectorScore: number;
  rerankScore: number | null;
  score: number;
  reasons: readonly ("fts" | "entity" | "vector" | "rerank")[];
}

export interface SegmentEmbeddingInput {
  segmentId: string;
  model: string;
  embedding: readonly number[];
  updatedAt: string;
  /**
   * When set, the vector is only stored if the segment still has this
   * content hash (see segmentContentHash); protects a vector computed from
   * text that changed while the embedding call was in flight.
   */
  expectedContentHash?: string;
}

export interface RetrievalSearchOptions {
  entityIds?: readonly string[];
  limit?: number;
  rerank?: boolean;
  queryEmbedding?: readonly number[];
  embeddingModel?: string;
  rerankScores?: Readonly<Record<string, number>>;
  /** Manuscript documents whose segments must not be returned. */
  excludeDocumentIds?: readonly string[];
  /** Keep at most this many segments per manuscript document. */
  maxPerDocument?: number;
}

export interface SegmentForEmbedding {
  segmentId: string;
  title: string;
  content: string;
  contentHash: string;
}

export interface SegmentEmbeddingCounts {
  segments: number;
  embedded: number;
  models: { model: string; dimensions: number; segments: number }[];
}

export interface DocumentSegmentState {
  segmentId: string;
  sourceType: string;
  title: string;
  documentId: string | null;
  documentVersionId: string | null;
  indexVersion: number | null;
  entityFingerprint: string | null;
}

interface SegmentRow {
  id: string;
  project_id: string;
  source_type: string;
  source_id: string;
  title: string;
  content: string;
  authority: SegmentAuthority;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  lexical_rank?: number;
  entity_score?: number;
}

/* Vectors below this cosine similarity never count as a semantic match. */
const MIN_VECTOR_SIMILARITY = 0.05;
/* Keep vector matches within this distance of the best match... */
const VECTOR_TOP_MARGIN = 0.2;
/* ...and above mean + k·stddev of all candidates when there are enough. */
const VECTOR_SPREAD_FACTOR = 0.5;
const VECTOR_SPREAD_MIN_CANDIDATES = 8;

export class SqliteRetrievalRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  upsertSegment(segment: TextSegmentInput): TextSegment {
    return this.database.transaction(() => {
      this.database.raw
        .prepare(
          `
          INSERT INTO text_segments(
            id, project_id, source_type, source_id, title, content, authority,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, source_type, source_id) DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            authority = excluded.authority,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `,
        )
        .run(
          segment.id,
          segment.projectId,
          segment.sourceType,
          segment.sourceId,
          segment.title,
          segment.content,
          segment.authority,
          JSON.stringify(segment.metadata),
          segment.createdAt,
          segment.updatedAt,
        );
      const stored = this.database.raw
        .prepare(
          "SELECT id FROM text_segments WHERE project_id = ? AND source_type = ? AND source_id = ?",
        )
        .get(segment.projectId, segment.sourceType, segment.sourceId) as {
        id: string;
      };
      this.database.raw
        .prepare("DELETE FROM segment_entities WHERE segment_id = ?")
        .run(stored.id);
      const link = this.database.raw.prepare(
        "INSERT INTO segment_entities(segment_id, entity_id, weight) VALUES (?, ?, ?)",
      );
      for (const entityId of new Set(segment.entityIds)) {
        const weight = segment.entityWeights?.[entityId];
        link.run(
          stored.id,
          entityId,
          typeof weight === "number" && Number.isFinite(weight) && weight >= 0
            ? weight
            : 1,
        );
      }
      const contentHash = segmentContentHash(segment.title, segment.content);
      this.database.raw
        .prepare(
          `DELETE FROM segment_vectors
           WHERE segment_id = ? AND content_hash != ?`,
        )
        .run(stored.id, contentHash);
      return { ...segment, id: stored.id };
    });
  }

  /** Returns false when expectedContentHash no longer matches the segment. */
  upsertEmbedding(input: SegmentEmbeddingInput): boolean {
    const row = this.database.raw
      .prepare("SELECT title, content FROM text_segments WHERE id = ?")
      .get(input.segmentId) as { title: string; content: string } | undefined;
    if (!row) throw new Error(`Text segment not found: ${input.segmentId}`);
    const model = input.model.trim();
    if (!model) throw new Error("Embedding model cannot be empty");
    const contentHash = segmentContentHash(row.title, row.content);
    if (
      input.expectedContentHash !== undefined &&
      input.expectedContentHash !== contentHash
    )
      return false;
    const embedding = normalizeEmbedding(input.embedding);
    this.database.raw
      .prepare(
        `INSERT INTO segment_vectors(
           segment_id, model, dimensions, vector, content_hash, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(segment_id) DO UPDATE SET
           model = excluded.model,
           dimensions = excluded.dimensions,
           vector = excluded.vector,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.segmentId,
        model,
        embedding.length,
        encodeVector(embedding),
        contentHash,
        input.updatedAt,
      );
    return true;
  }

  /** Segments of the project, optionally filtered by source type. */
  listSegments(
    projectId: string,
    options: { sourceTypes?: readonly string[]; documentId?: string } = {},
  ): TextSegment[] {
    const where = ["segment.project_id = ?"];
    const parameters: string[] = [projectId];
    if (options.sourceTypes && options.sourceTypes.length > 0) {
      where.push(
        `segment.source_type IN (${options.sourceTypes.map(() => "?").join(",")})`,
      );
      parameters.push(...options.sourceTypes);
    }
    if (options.documentId) {
      where.push("json_extract(segment.metadata_json, '$.documentId') = ?");
      parameters.push(options.documentId);
    }
    const rows = this.database.raw
      .prepare(
        `SELECT segment.* FROM text_segments segment
         WHERE ${where.join(" AND ")}
         ORDER BY segment.source_type, segment.source_id`,
      )
      .all(...parameters) as unknown as SegmentRow[];
    return rows.map((row) => mapSegment(row, this.entityIds(row.id)));
  }

  deleteSegments(projectId: string, segmentIds: readonly string[]): number {
    if (segmentIds.length === 0) return 0;
    const remove = this.database.raw.prepare(
      "DELETE FROM text_segments WHERE project_id = ? AND id = ?",
    );
    let removed = 0;
    this.database.transaction(() => {
      for (const id of new Set(segmentIds))
        removed += Number(remove.run(projectId, id).changes);
    });
    return removed;
  }

  /**
   * Active segments whose vector is missing, stale (content changed) or
   * produced by another model. Ordered so the manuscript comes first.
   */
  listSegmentsMissingEmbedding(
    projectId: string,
    model: string,
    limit: number,
  ): SegmentForEmbedding[] {
    const rows = this.database.raw
      .prepare(
        `SELECT segment.id, segment.title, segment.content
         FROM text_segments segment
         LEFT JOIN segment_vectors embedding
           ON embedding.segment_id = segment.id
         WHERE segment.project_id = ?
           AND ${ACTIVE_SEGMENT_PREDICATE}
           AND (embedding.segment_id IS NULL OR embedding.model != ?)
         ORDER BY CASE segment.source_type
                    WHEN 'document_passage' THEN 0
                    WHEN 'document_current' THEN 1
                    ELSE 2 END,
                  segment.row_id
         LIMIT ?`,
      )
      .all(projectId, model, Math.max(1, limit)) as unknown as {
      id: string;
      title: string;
      content: string;
    }[];
    return rows.map((row) => ({
      segmentId: row.id,
      title: row.title,
      content: row.content,
      contentHash: segmentContentHash(row.title, row.content),
    }));
  }

  /** How many active segments lack a vector of `model`. */
  countSegmentsMissingEmbedding(projectId: string, model: string): number {
    const row = this.database.raw
      .prepare(
        `SELECT COUNT(*) AS count
         FROM text_segments segment
         LEFT JOIN segment_vectors embedding
           ON embedding.segment_id = segment.id
         WHERE segment.project_id = ?
           AND ${ACTIVE_SEGMENT_PREDICATE}
           AND (embedding.segment_id IS NULL OR embedding.model != ?)`,
      )
      .get(projectId, model) as { count: number };
    return Number(row.count);
  }

  /** Segment ids (of the given ones) that already hold a vector of `model`. */
  embeddedSegmentIds(
    segments: readonly { segmentId: string; contentHash?: string }[],
    model: string,
  ): Set<string> {
    const embedded = new Set<string>();
    const lookup = this.database.raw.prepare(
      "SELECT content_hash FROM segment_vectors WHERE segment_id = ? AND model = ?",
    );
    for (const segment of segments) {
      const row = lookup.get(segment.segmentId, model) as
        { content_hash: string } | undefined;
      if (
        row &&
        (segment.contentHash === undefined ||
          row.content_hash === segment.contentHash)
      )
        embedded.add(segment.segmentId);
    }
    return embedded;
  }

  /**
   * Index bookkeeping for manuscript segments without loading their text:
   * which document and version each segment was cut from.
   */
  listDocumentSegmentStates(
    projectId: string,
    sourceTypes: readonly string[],
  ): DocumentSegmentState[] {
    if (sourceTypes.length === 0) return [];
    const rows = this.database.raw
      .prepare(
        `SELECT segment.id AS id, segment.source_type AS source_type,
                segment.title AS title,
                json_extract(segment.metadata_json, '$.documentId') AS document_id,
                json_extract(segment.metadata_json, '$.documentVersionId') AS version_id,
                json_extract(segment.metadata_json, '$.indexVersion') AS index_version,
                json_extract(segment.metadata_json, '$.entityFingerprint') AS entity_fingerprint
         FROM text_segments segment
         WHERE segment.project_id = ?
           AND segment.source_type IN (${sourceTypes.map(() => "?").join(",")})`,
      )
      .all(projectId, ...sourceTypes) as unknown as {
      id: string;
      source_type: string;
      title: string;
      document_id: unknown;
      version_id: unknown;
      index_version: unknown;
      entity_fingerprint: unknown;
    }[];
    return rows.map((row) => ({
      segmentId: row.id,
      sourceType: row.source_type,
      title: row.title,
      documentId: typeof row.document_id === "string" ? row.document_id : null,
      documentVersionId:
        typeof row.version_id === "string" ? row.version_id : null,
      indexVersion:
        typeof row.index_version === "number" ? row.index_version : null,
      entityFingerprint:
        typeof row.entity_fingerprint === "string"
          ? row.entity_fingerprint
          : null,
    }));
  }

  embeddingCounts(
    projectId: string,
    sourceTypes?: readonly string[],
  ): SegmentEmbeddingCounts {
    const sourceFilter =
      sourceTypes && sourceTypes.length > 0
        ? `AND segment.source_type IN (${sourceTypes.map(() => "?").join(",")})`
        : "";
    const parameters = [projectId, ...(sourceTypes ?? [])];
    const totals = this.database.raw
      .prepare(
        `SELECT COUNT(*) AS segments, COUNT(embedding.segment_id) AS embedded
         FROM text_segments segment
         LEFT JOIN segment_vectors embedding
           ON embedding.segment_id = segment.id
         WHERE segment.project_id = ? ${sourceFilter}
           AND ${ACTIVE_SEGMENT_PREDICATE}`,
      )
      .get(...parameters) as { segments: number; embedded: number };
    const models = this.database.raw
      .prepare(
        `SELECT embedding.model AS model, embedding.dimensions AS dimensions,
                COUNT(*) AS segments
         FROM text_segments segment
         JOIN segment_vectors embedding ON embedding.segment_id = segment.id
         WHERE segment.project_id = ? ${sourceFilter}
           AND ${ACTIVE_SEGMENT_PREDICATE}
         GROUP BY embedding.model, embedding.dimensions
         ORDER BY segments DESC, embedding.model`,
      )
      .all(...parameters) as unknown as {
      model: string;
      dimensions: number;
      segments: number;
    }[];
    return {
      segments: Number(totals.segments),
      embedded: Number(totals.embedded),
      models: models.map((row) => ({
        model: row.model,
        dimensions: Number(row.dimensions),
        segments: Number(row.segments),
      })),
    };
  }

  search(
    projectId: string,
    query: string,
    options: RetrievalSearchOptions = {},
  ): RetrievalHit[] {
    const limit = Math.max(1, Math.min(options.limit ?? 12, 100));
    const maxPerDocument =
      options.maxPerDocument && options.maxPerDocument > 0
        ? Math.floor(options.maxPerDocument)
        : null;
    // Diversity filtering discards candidates, so ask each signal for more.
    const candidateLimit = Math.min(limit * (maxPerDocument ? 4 : 2), 200);
    const excluded = [...new Set(options.excludeDocumentIds ?? [])];
    const filter = `${ACTIVE_SEGMENT_PREDICATE}${
      excluded.length > 0
        ? ` AND (json_extract(segment.metadata_json, '$.documentId') IS NULL
             OR json_extract(segment.metadata_json, '$.documentId') NOT IN (${excluded
               .map(() => "?")
               .join(",")}))`
        : ""
    }`;
    const normalized = query.trim();
    const merged = new Map<string, RetrievalHit>();
    if (normalized) {
      const rows = this.lexicalCandidates(
        projectId,
        normalized,
        filter,
        excluded,
        candidateLimit,
      );
      rows.forEach((row, index) => {
        const segment = mapSegment(row, this.entityIds(row.id));
        merged.set(row.id, {
          ...segment,
          lexicalRank: row.lexical_rank ?? index,
          vectorRank: null,
          entityScore: 0,
          vectorScore: 0,
          rerankScore: null,
          score: reciprocalRank(index),
          reasons: ["fts"],
        });
      });
    }

    const entityIds = [...new Set(options.entityIds ?? [])];
    if (entityIds.length > 0) {
      const placeholders = entityIds.map(() => "?").join(",");
      const rows = this.database.raw
        .prepare(
          `
          SELECT segment.*, SUM(link.weight) AS entity_score
          FROM segment_entities link
          JOIN text_segments segment ON segment.id = link.segment_id
          WHERE segment.project_id = ? AND link.entity_id IN (${placeholders})
            AND ${filter}
          GROUP BY segment.id
          ORDER BY entity_score DESC, segment.updated_at DESC
          LIMIT ?
        `,
        )
        .all(
          projectId,
          ...entityIds,
          ...excluded,
          candidateLimit,
        ) as unknown as SegmentRow[];
      rows.forEach((row, index) => {
        const current = merged.get(row.id);
        const entityScore = row.entity_score ?? 0;
        if (current) {
          current.entityScore = entityScore;
          current.score += reciprocalRank(index);
          current.reasons = addReason(current.reasons, "entity");
        } else {
          const segment = mapSegment(row, this.entityIds(row.id));
          merged.set(row.id, {
            ...segment,
            lexicalRank: null,
            vectorRank: null,
            entityScore,
            vectorScore: 0,
            rerankScore: null,
            score: reciprocalRank(index),
            reasons: ["entity"],
          });
        }
      });
    }

    if (options.queryEmbedding && options.queryEmbedding.length > 0) {
      const queryEmbedding = normalizeEmbedding(options.queryEmbedding);
      // Scan only ids and vectors; segment text is read for the matches.
      const vectorRows = this.database.raw
        .prepare(
          `SELECT segment.id, embedding.vector
           FROM text_segments segment
           JOIN segment_vectors embedding ON embedding.segment_id = segment.id
           WHERE segment.project_id = ? AND embedding.dimensions = ?
             AND (? IS NULL OR embedding.model = ?)
             AND ${filter}`,
        )
        .all(
          projectId,
          queryEmbedding.length,
          options.embeddingModel ?? null,
          options.embeddingModel ?? null,
          ...excluded,
        ) as unknown as { id: string; vector: Uint8Array }[];
      const matches = selectVectorMatches(
        vectorRows.map(({ id, vector }) => ({
          id,
          similarity: dot(queryEmbedding, decodeVector(vector)),
        })),
      ).slice(0, candidateLimit);
      const readSegment = this.database.raw.prepare(
        "SELECT segment.* FROM text_segments segment WHERE segment.id = ?",
      );
      matches
        .map(({ id, similarity }) => ({
          row: (merged.has(id)
            ? { id }
            : readSegment.get(id)) as unknown as SegmentRow,
          similarity,
        }))
        .forEach(({ row, similarity }, index) => {
          const current = merged.get(row.id);
          if (current) {
            current.vectorRank = index;
            current.vectorScore = similarity;
            current.score += reciprocalRank(index);
            current.reasons = addReason(current.reasons, "vector");
          } else {
            const segment = mapSegment(row, this.entityIds(row.id));
            merged.set(row.id, {
              ...segment,
              lexicalRank: null,
              vectorRank: index,
              entityScore: 0,
              vectorScore: similarity,
              rerankScore: null,
              score: reciprocalRank(index),
              reasons: ["vector"],
            });
          }
        });
    }

    const fused = diversify(
      [...merged.values()].sort(
        (left, right) =>
          right.score - left.score ||
          right.entityScore - left.entityScore ||
          right.vectorScore - left.vectorScore,
      ),
      maxPerDocument,
    );
    const ranked = fused.slice(0, options.rerank ? limit * 2 : limit);
    if (!options.rerank) return ranked;
    return ranked
      .map((hit) => {
        const suppliedScore = options.rerankScores?.[hit.id];
        const rerankScore =
          typeof suppliedScore === "number" && Number.isFinite(suppliedScore)
            ? suppliedScore
            : deterministicRerank(hit, normalized, entityIds);
        return {
          ...hit,
          rerankScore,
          score: hit.score + rerankScore / 100,
          reasons: addReason(hit.reasons, "rerank"),
        };
      })
      .sort(
        (left, right) =>
          (right.rerankScore ?? 0) - (left.rerankScore ?? 0) ||
          right.score - left.score,
      )
      .slice(0, limit);
  }

  private lexicalCandidates(
    projectId: string,
    query: string,
    filter: string,
    excluded: readonly string[],
    limit: number,
  ): SegmentRow[] {
    if ([...query].length < 3) {
      return this.database.raw
        .prepare(
          `SELECT segment.*, 0.0 AS lexical_rank FROM text_segments segment
           WHERE segment.project_id = ?
             AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
             AND ${filter}
           ORDER BY segment.updated_at DESC LIMIT ?`,
        )
        .all(
          projectId,
          `%${escapeLike(query)}%`,
          `%${escapeLike(query)}%`,
          ...excluded,
          limit,
        ) as unknown as SegmentRow[];
    }
    const plan = buildLexicalQuery(query);
    const ranked =
      (index: "text_segments_words" | "text_segments_fts") =>
      (expression: string) =>
        this.database.raw
          .prepare(
            `SELECT segment.*, bm25(${index}, ${index === "text_segments_words" ? "2.0" : "4.0"}, 1.0) AS lexical_rank
           FROM ${index}
           JOIN text_segments segment ON segment.row_id = ${index}.rowid
           WHERE ${index} MATCH ? AND segment.project_id = ?
             AND ${filter}
           ORDER BY lexical_rank LIMIT ?`,
          )
          .all(
            expression,
            projectId,
            ...excluded,
            limit,
          ) as unknown as SegmentRow[];
    const lists = [
      plan.words ? ranked("text_segments_words")(plan.words) : [],
      plan.trigrams ? ranked("text_segments_fts")(plan.trigrams) : [],
    ].filter((rows) => rows.length > 0);
    if (lists.length === 1) return lists[0]!;
    if (lists.length > 1) {
      const fused = new Map<string, { row: SegmentRow; score: number }>();
      for (const rows of lists) {
        rows.forEach((row, index) => {
          const current = fused.get(row.id);
          if (current) current.score += reciprocalRank(index);
          else fused.set(row.id, { row, score: reciprocalRank(index) });
        });
      }
      return [...fused.values()]
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((entry) => entry.row);
    }
    return plan.likeTerms.length > 0
      ? this.likeFallback(projectId, plan.likeTerms, filter, excluded, limit)
      : [];
  }

  private entityIds(segmentId: string): string[] {
    return (
      this.database.raw
        .prepare(
          "SELECT entity_id FROM segment_entities WHERE segment_id = ? ORDER BY entity_id",
        )
        .all(segmentId) as unknown as { entity_id: string }[]
    ).map((row) => row.entity_id);
  }

  /** CJK two-character terms cannot match the trigram index. */
  private likeFallback(
    projectId: string,
    terms: readonly string[],
    filter: string,
    excluded: readonly string[],
    limit: number,
  ): SegmentRow[] {
    const where = terms
      .map(() => "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const parameters = terms.flatMap((term) => {
      const pattern = `%${escapeLike(term)}%`;
      return [pattern, pattern];
    });
    const rows = this.database.raw
      .prepare(
        `SELECT segment.* FROM text_segments segment
         WHERE segment.project_id = ? AND (${where})
           AND ${filter}
         ORDER BY segment.updated_at DESC LIMIT ?`,
      )
      .all(
        projectId,
        ...parameters,
        ...excluded,
        Math.max(limit * 4, 20),
      ) as unknown as SegmentRow[];
    const normalizedTerms = terms.map((term) => term.toLocaleLowerCase());
    return rows
      .map((row) => {
        const haystack = `${row.title}\n${row.content}`.toLocaleLowerCase();
        const matches = normalizedTerms.filter((term) =>
          haystack.includes(term),
        ).length;
        return { ...row, lexical_rank: -matches };
      })
      .sort(
        (left, right) =>
          (left.lexical_rank ?? 0) - (right.lexical_rank ?? 0) ||
          right.updated_at.localeCompare(left.updated_at),
      )
      .slice(0, limit);
  }
}

export function segmentContentHash(title: string, content: string): string {
  return sha256Hex(`${title}\n${content}`);
}

/** Manuscript document a segment belongs to, when it has one. */
export function segmentDocumentId(
  segment: Pick<TextSegment, "metadata">,
): string | null {
  const value = segment.metadata.documentId;
  return typeof value === "string" && value ? value : null;
}

function diversify(
  hits: readonly RetrievalHit[],
  maxPerDocument: number | null,
): RetrievalHit[] {
  if (!maxPerDocument) return [...hits];
  const perDocument = new Map<string, number>();
  return hits.filter((hit) => {
    const documentId = segmentDocumentId(hit);
    if (!documentId) return true;
    const count = perDocument.get(documentId) ?? 0;
    if (count >= maxPerDocument) return false;
    perDocument.set(documentId, count + 1);
    return true;
  });
}

/**
 * Cosine similarity is relative: every passage of the same book is somewhat
 * similar to any query, so a fixed low floor kept everything. Keep matches
 * close to the best one and, with enough candidates, above the spread of
 * the rest.
 */
function selectVectorMatches<T extends { similarity: number }>(
  candidates: readonly T[],
): T[] {
  const sorted = candidates
    .filter(({ similarity }) => similarity > MIN_VECTOR_SIMILARITY)
    .sort((left, right) => right.similarity - left.similarity);
  const top = sorted[0]?.similarity;
  if (top === undefined) return [];
  let floor = top - VECTOR_TOP_MARGIN;
  if (candidates.length >= VECTOR_SPREAD_MIN_CANDIDATES) {
    const values = candidates.map(({ similarity }) => similarity);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance =
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      values.length;
    floor = Math.max(floor, mean + VECTOR_SPREAD_FACTOR * Math.sqrt(variance));
  }
  return sorted.filter(
    ({ similarity }, index) => index === 0 || similarity >= floor,
  );
}

function mapSegment(
  row: SegmentRow,
  entityIds: readonly string[],
): TextSegment {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    content: row.content,
    authority: row.authority,
    metadata: parseObject(row.metadata_json),
    entityIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function reciprocalRank(index: number): number {
  return 1 / (60 + index + 1);
}

function normalizeEmbedding(embedding: readonly number[]): number[] {
  if (embedding.length === 0 || embedding.length > 16_384)
    throw new Error("Embedding dimensions must be between 1 and 16384");
  if (embedding.some((value) => !Number.isFinite(value)))
    throw new Error("Embedding contains a non-finite value");
  const magnitude = Math.sqrt(
    embedding.reduce((sum, value) => sum + value ** 2, 0),
  );
  if (magnitude === 0) throw new Error("Embedding cannot be a zero vector");
  return embedding.map((value) => value / magnitude);
}

function addReason<T extends RetrievalHit["reasons"][number]>(
  reasons: readonly T[],
  reason: RetrievalHit["reasons"][number],
): RetrievalHit["reasons"] {
  return reasons.includes(reason as T) ? reasons : [...reasons, reason];
}

function deterministicRerank(
  hit: RetrievalHit,
  query: string,
  entityIds: readonly string[],
): number {
  const haystack = `${hit.title}\n${hit.content}`
    .normalize("NFKC")
    .toLocaleLowerCase();
  const terms = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const exact = terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0,
  );
  const entityOverlap = entityIds.filter((id) =>
    hit.entityIds.includes(id),
  ).length;
  const authority = {
    locked: 1,
    confirmed: 0.8,
    reference: 0.5,
    candidate: 0.25,
    draft: 0.1,
  }[hit.authority];
  return exact * 3 + entityOverlap * 2 + hit.vectorScore * 2 + authority;
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
