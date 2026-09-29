import type {
  BibleBackfillSectionPendingItemDto,
  CanonCandidateItemDto,
  CanonSpread,
} from "@narralume/contracts";
import type { ImportCandidate, RunSnapshot } from "@narralume/domain";
import { instructionsFor } from "@narralume/narrative";
import {
  SqliteBibleBackfillRepository,
  SqliteDeliveryRepository,
  SqliteReviewRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { isImportDerivedSource } from "./import-provenance.js";
import { deterministicUuid } from "./request-idempotency.js";

/**
 * Deterministic requestId of a section's candidate run: one run per
 * (job, section, attempt), so a replayed transition never starts a second one.
 */
export function bibleBackfillSectionRequestId(
  jobId: string,
  spread: CanonSpread,
  attempt: number,
): string {
  return deterministicUuid(
    `bible-backfill-section\0${jobId}\0${spread}\0${attempt}`,
  );
}

/** The candidate set a finished Canon Spread candidate run staged, if any. */
export function stagedCandidateSetId(snapshot: RunSnapshot): string | null {
  const stage = [...snapshot.steps]
    .reverse()
    .find(
      (step) => step.kind === "canon.stage" && step.status === "succeeded",
    );
  const id = stage?.outputArtifact?.candidateSetId;
  return typeof id === "string" && id ? id : null;
}

const SECTION_PREAMBLE = {
  "zh-CN":
    "这是「从正文补全故事圣经」的分部阶段：全书已按阅读顺序逐章读完，各章结果已写入故事圣经；supportingIndex.chapterSummaries 覆盖整部已完成的作品。请以全书为依据整合本分部，而不是只看最近几章。",
  en: "This is the section phase of completing the Story Bible from the finished manuscript: every chapter was read in reading order and its results are already in the Story Bible; supportingIndex.chapterSummaries covers the whole finished book. Consolidate this section from the whole book, not only the latest chapters.",
} as const;

const SECTION_INSTRUCTIONS: Record<
  CanonSpread,
  Record<"zh-CN" | "en", readonly string[]>
> = {
  intent: {
    "zh-CN": [
      "根据已完成的全书综合作者意图，只提出一项 update（targetId 为 intent）：promise（作品的前提与它向读者承诺的体验）、themes（主题）、audience（读者对象）、tone（基调）和 endingDirection（故事最终走向）。",
      "空着的字段请补上；已有内容与全书相符时保留原样，只有正文明确支持更准确的表述时才修改。除非正文明确体现，不要改 boundaries 与 currentFocus。每个值都要来自各章实际写了什么，而不是题材的惯例。",
    ],
    en: [
      "Synthesize the author intent from the finished book in a single update (targetId intent): promise (the premise and the experience the book promises its reader), themes, audience, tone, and endingDirection (where the story ends up).",
      "Fill the fields that are empty; keep what is already written when the book agrees with it and change it only when the manuscript clearly supports a more accurate wording. Leave boundaries and currentFocus alone unless the manuscript makes them explicit. Base every value on what the chapters actually show, not on genre conventions.",
    ],
  },
  entities: {
    "zh-CN": [
      "整合全书反复出现的人物、地点、组织及其他重要实体。",
      "对 currentSpread 中已有的实体，只在全书补充了新信息时 update：更完整地写清他是谁 / 它是什么、在整个故事中的作用（description），正文使用的别名与称呼（aliases），以及稳定的属性（attributes）。不要改名、不要改 type、不要 retired。",
      "只有在章节摘要里反复出现、且明显缺失的主要人物、地点或组织才 create；create 前先核对 currentSpread 的名称与别名，绝不重复创建同一实体或它的另一种写法。按重要性从高到低安排条目。",
    ],
    en: [
      "Consolidate the characters, locations, organizations and other important entities that recur across the whole book.",
      "For entities already in currentSpread, update only where the book adds something: a fuller description of who or what they are and their role across the story, the aliases and epithets the prose uses, and stable attributes. Never rename them, change their type or retire them.",
      "Create an entity only for a major character, place or organization that recurs in the chapter summaries and is clearly missing; check the names and aliases in currentSpread first and never create a duplicate or a variant spelling of an existing entity. Order the items from most to least important.",
    ],
  },
  outline: {
    "zh-CN": [
      "依据已完成的正文补全大纲：对已有的章节节点，根据该章的章节摘要补上或完善 summary、goal、conflict、outcome；正文明确时也可填 povEntityId（只用真实实体 ID）与 storyTime。",
      "只 update 已有节点：不要 create 节点，也不要修改 parentId、kind、ordinal、title、status 或 metadata。已有章节不能移动，因此不要新增它们无法归入的部、卷或幕。书节点没有 summary 时，可以为它写一段覆盖全书的概要。优先处理字段为空的章节，按阅读顺序排列。",
    ],
    en: [
      "Complete the outline from the finished manuscript: for each existing chapter node, fill or refine summary, goal, conflict and outcome from that chapter's summary; when the prose makes them clear, also povEntityId (real entity IDs only) and storyTime.",
      "Update existing nodes only: do not create nodes, and never change parentId, kind, ordinal, title, status or metadata. Existing chapters cannot be moved, so do not add parts, volumes or acts they could not belong to. When the book node has no summary, you may give it one that covers the whole book. Prioritize chapters whose fields are empty, in reading order.",
    ],
  },
  facts: {
    "zh-CN": [
      "记录全书确立、而故事圣经仍缺少的稳定事实：身份、特征、能力、归属、所有物、世界规则。subjectId 与 objectEntityId 只用 supportingIndex.entities 中的 ID。",
      "先核对 currentSpread 中的事实，绝不换一种说法重复断言已有事实。只有全书明确确立了不同的值时才 update（取代）已有事实；只有全书明确否定时才 withdraw。能确定时把 validFromNodeId 设为该事实开始成立的章节。",
    ],
    en: [
      "Record the stable facts the finished book establishes that the Story Bible still lacks: identities, traits, abilities, affiliations, possessions and world rules. Use only entity IDs from supportingIndex.entities for subjectId and objectEntityId.",
      "Check the facts in currentSpread first and never assert one that already exists in other words. Update (supersede) an existing fact only when the book clearly establishes a different value, and withdraw one only when the book contradicts it. When it is clear, set validFromNodeId to the chapter where the fact becomes true.",
    ],
  },
  relations: {
    "zh-CN": [
      "整合全书中已有实体之间的关系：create 缺失的重要当前关系，并把已有关系 update 到故事结束时的状态（relation、intensity、state、outlineNodeId、storyTime）。",
      "只用 supportingIndex 中的实体 ID；同一对实体已有同一关系时不要再 create 一条。",
    ],
    en: [
      "Consolidate the relationships between existing entities across the whole book: create the important current relationships that are missing and update existing ones (relation, intensity, state, outlineNodeId, storyTime) to where the story leaves them.",
      "Use only entity IDs from supportingIndex; never create a second relationship for a pair that already has that relationship in currentSpread.",
    ],
  },
  timeline: {
    "zh-CN": [
      "用全书缺失的关键事件补全时间线：title、简短 description、事件发生章节的 outlineNodeId、participants（实体 ID）、causes（已有事件 ID），以及按故事顺序插在已有事件序号之间的 sequence。",
      "不要用另一种说法重复已有事件；只有为了纠正或补全时才 update 已有事件。",
    ],
    en: [
      "Complete the timeline with the key events of the whole book that are missing from currentSpread: title, a short description, the outlineNodeId of the chapter where it happens, participants (entity IDs), causes (existing event IDs), and a sequence that fits between the existing events in story order.",
      "Do not duplicate an existing event under another wording; update an existing event only to correct or complete it.",
    ],
  },
  foreshadows: {
    "zh-CN": [
      "整合全书的铺垫与回收：create 缺失的重要伏笔（title、description、按全书结束时的状态填 planted / developing / resolved、importance、targetFromNodeId / targetToNodeId、evidenceNodeIds、resolutionNodeId），并为已有伏笔 update 证据章节与回收章节。",
      "不要重复已有伏笔，也不要把已回收（resolved）或已放弃（abandoned）的伏笔重新打开。",
    ],
    en: [
      "Consolidate the setups and payoffs of the whole book: create the important foreshadows that are missing (title, description, status planted/developing/resolved as the finished book leaves them, importance, targetFromNodeId/targetToNodeId, evidenceNodeIds, resolutionNodeId), and update existing ones with their evidence chapters and the chapter that resolves them.",
      "Do not duplicate an existing foreshadow, and do not reopen one that is resolved or abandoned.",
    ],
  },
};

/**
 * The server-side instruction a job gives a section's candidate run, in the
 * project's prompt language (zh-CN unless the project is English). The
 * candidate worker adds the manuscript-language invariant itself.
 */
export function bibleBackfillSectionInstruction(
  spread: CanonSpread,
  language: string | null | undefined,
): string {
  return instructionsFor(language, {
    "zh-CN": [SECTION_PREAMBLE["zh-CN"], ...SECTION_INSTRUCTIONS[spread]["zh-CN"]],
    en: [SECTION_PREAMBLE.en, ...SECTION_INSTRUCTIONS[spread].en],
  });
}

/** Why an item stays pending; the item's identity is added by the caller. */
export type SectionReviewReason = Omit<
  BibleBackfillSectionPendingItemDto,
  "itemId" | "title" | "operation" | "targetId"
>;

/**
 * Decides which items of a section's candidate set auto mode may apply.
 * Creating records is always allowed. An update or withdrawal is applied only
 * when it touches no locked content, the target record was created by
 * automation — the manuscript import, a chapter settlement a Story Bible
 * completion of this project applied, or a completion section's candidate
 * set — and, for the records the author edits in place (author intent,
 * outline nodes, entities), every field it changes still holds a value
 * nobody wrote by hand: empty, the import's value, or the value a completion
 * section last wrote. Anything else, including records of unknown origin,
 * is left for the author. Reopening a resolved or abandoned foreshadow is
 * always left for the author.
 */
export class BibleBackfillSectionGate {
  private readonly deliveries: SqliteDeliveryRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly chapterChangeSets: ReadonlySet<string>;
  private readonly sectionSets: ReadonlySet<string>;
  readonly #importCandidates = new Map<string, ImportCandidate[]>();
  #completionWrites: Map<string, Record<string, unknown>> | null = null;

  constructor(
    database: NarrativeDatabase,
    private readonly projectId: string,
  ) {
    const backfills = new SqliteBibleBackfillRepository(database);
    this.deliveries = new SqliteDeliveryRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.chapterChangeSets = new Set(
      backfills.listAppliedChapterChangeSetIds(projectId),
    );
    this.sectionSets = new Set(backfills.listSectionCandidateSetIds(projectId));
  }

  reviewReason(
    spread: CanonSpread,
    item: CanonCandidateItemDto,
  ): SectionReviewReason | null {
    if (item.requiresLockedConfirmation) return { reason: "locked" };
    if (item.operation === "create") return null;
    const before = item.before;
    if (!before) return { reason: "author_record" };
    switch (spread) {
      case "intent":
        return this.fieldsReason(spread, "intent", before, item.after, [
          this.importedIntentValues(),
        ]);
      case "outline":
        return this.outlineOwned(before)
          ? this.fieldsReason(
              spread,
              String(before.id),
              before,
              item.after,
              [this.importedOutlineValues(before)],
            )
          : { reason: "author_record" };
      case "entities": {
        const imported = this.importedEntityValues(before);
        return this.createdBySectionSet(before.id, "entity") || imported
          ? this.fieldsReason(spread, String(before.id), before, item.after, [
              imported,
            ])
          : { reason: "author_record" };
      }
      case "facts":
        return this.factOwned(before) ? null : { reason: "author_record" };
      case "relations":
        return this.stateRecordOwned(before, "relationship", "relationship")
          ? null
          : { reason: "author_record" };
      case "timeline":
        return this.stateRecordOwned(before, "timeline", "timeline")
          ? null
          : { reason: "author_record" };
      case "foreshadows": {
        const status = before.status;
        const next = item.after?.status;
        if (
          (status === "resolved" || status === "abandoned") &&
          next !== undefined &&
          next !== status
        ) {
          return { reason: "reopens" };
        }
        return this.stateRecordOwned(before, "foreshadow", "foreshadow") ||
          (typeof before.sourceId === "string" &&
            this.chapterChangeSets.has(before.sourceId))
          ? null
          : { reason: "author_record" };
      }
    }
  }

  /** Changed fields whose current value somebody wrote by hand. */
  private fieldsReason(
    spread: CanonSpread,
    targetId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown> | null,
    importedValues: readonly (Record<string, unknown> | null)[],
  ): SectionReviewReason | null {
    const written = this.completionWrites().get(`${spread}\0${targetId}`);
    const sources = [written ?? null, ...importedValues].filter(
      (source): source is Record<string, unknown> => source !== null,
    );
    const fields = Object.keys(after ?? {}).filter((field) => {
      const current = before[field];
      if (sameValue(current, after![field]) || isEmptyValue(current)) {
        return false;
      }
      return !sources.some(
        (source) => field in source && sameValue(source[field], current),
      );
    });
    return fields.length > 0 ? { reason: "author_edited", fields } : null;
  }

  private outlineOwned(node: Record<string, unknown>): boolean {
    if (node.parentId === null && node.kind === "book") return true;
    if (this.createdBySectionSet(node.id, "outline")) return true;
    const candidateId = importCandidateIdOf(node);
    return (
      candidateId !== null &&
      isImportDerivedSource(
        this.deliveries,
        this.projectId,
        "document",
        candidateId,
      )
    );
  }

  private factOwned(fact: Record<string, unknown>): boolean {
    const id = typeof fact.id === "string" ? fact.id : "";
    const sourceId = typeof fact.sourceId === "string" ? fact.sourceId : null;
    if (!sourceId) return false;
    if (fact.sourceType === "canon_change_set") {
      return (
        this.chapterChangeSets.has(sourceId) &&
        id.startsWith(`${sourceId}:fact:`)
      );
    }
    return fact.sourceType === "canon-candidate" && this.sectionSets.has(sourceId);
  }

  /**
   * A relationship, timeline event or foreshadow the import created (its
   * source id names the import candidate), a completion-applied chapter
   * settlement created (`${changeSetId}:${kind}:${index}`), or a completion
   * section's candidate set created or last updated (source id = set id).
   */
  private stateRecordOwned(
    record: Record<string, unknown>,
    importKind: string,
    rowKind: "relationship" | "timeline" | "foreshadow",
  ): boolean {
    const id = typeof record.id === "string" ? record.id : "";
    const sourceId =
      typeof record.sourceId === "string" ? record.sourceId : null;
    if (
      isImportDerivedSource(
        this.deliveries,
        this.projectId,
        importKind,
        sourceId,
      )
    ) {
      return true;
    }
    const creator = new RegExp(`^(.+):${rowKind}:\\d+$`, "u").exec(id)?.[1];
    if (creator && this.chapterChangeSets.has(creator)) return true;
    return sourceId !== null && this.sectionSets.has(sourceId);
  }

  private createdBySectionSet(id: unknown, kind: string): boolean {
    if (typeof id !== "string") return false;
    const set = new RegExp(`^(.+):item-\\d+:${kind}$`, "u").exec(id)?.[1];
    return set !== undefined && this.sectionSets.has(set);
  }

  private importedIntentValues(): Record<string, unknown> | null {
    const candidate = this.appliedImportCandidates("intent").at(-1);
    return candidate ? { ...candidate.payload } : null;
  }

  private importedOutlineValues(
    node: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const candidateId = importCandidateIdOf(node);
    const candidate = candidateId
      ? this.deliveries.getImportCandidate(candidateId)
      : null;
    if (candidate?.kind !== "document") return null;
    return {
      title: textOf(candidate.payload.title) ?? candidate.title,
      summary: textOf(candidate.payload.summary),
    };
  }

  /**
   * The import entity candidate that created this entity: same name, and
   * created by that import's application (the entity's creation time is the
   * candidate's application time). An author's entity of the same name the
   * import skipped does not match.
   */
  private importedEntityValues(
    entity: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const candidate = this.appliedImportCandidates("entity").find(
      (entry) =>
        (textOf(entry.payload.name) ?? entry.title) === entity.name &&
        entry.updatedAt === entity.createdAt,
    );
    if (!candidate) return null;
    return {
      name: textOf(candidate.payload.name) ?? candidate.title,
      description: textOf(candidate.payload.description),
      aliases: Array.isArray(candidate.payload.aliases)
        ? candidate.payload.aliases
        : [],
      attributes: candidate.payload.attributes ?? {},
    };
  }

  private appliedImportCandidates(kind: string): ImportCandidate[] {
    let candidates = this.#importCandidates.get(kind);
    if (!candidates) {
      candidates = this.deliveries.listAppliedImportCandidates(
        this.projectId,
        kind as ImportCandidate["kind"],
      );
      this.#importCandidates.set(kind, candidates);
    }
    return candidates;
  }

  /**
   * The record each completion section last wrote, keyed by spread and
   * target id (`intent` for the author intent): the stored value of the
   * newest applied item of a completion candidate set that targets it.
   */
  private completionWrites(): Map<string, Record<string, unknown>> {
    if (this.#completionWrites) return this.#completionWrites;
    const latest = new Map<
      string,
      { createdAt: string; value: Record<string, unknown> }
    >();
    for (const setId of this.sectionSets) {
      for (const decision of this.reviews.listCanonItemDecisions(setId)) {
        if (decision.action !== "apply" || !decision.result) continue;
        const spread = decision.result.spread;
        const value = decision.result.value;
        if (
          typeof spread !== "string" ||
          !value ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          continue;
        }
        const record = value as Record<string, unknown>;
        const targetId =
          spread === "intent"
            ? "intent"
            : typeof record.id === "string"
              ? record.id
              : null;
        if (!targetId) continue;
        const key = `${spread}\0${targetId}`;
        const previous = latest.get(key);
        if (!previous || previous.createdAt <= decision.createdAt) {
          latest.set(key, { createdAt: decision.createdAt, value: record });
        }
      }
    }
    this.#completionWrites = new Map(
      [...latest].map(([key, entry]) => [key, entry.value]),
    );
    return this.#completionWrites;
  }
}

function importCandidateIdOf(node: Record<string, unknown>): string | null {
  const metadata = node.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const id = (metadata as Record<string, unknown>).importCandidateId;
  return typeof id === "string" && id ? id : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(normalized(left)) === stableJson(normalized(right));
}

function normalized(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "string") return value.trim();
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
