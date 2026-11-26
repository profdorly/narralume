/** What the open chapter needs from the story bible. Pure: no fetch, no model call. */

export interface DeskOutlineNode {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  goal: string | null;
  status: string;
  ordinal: number;
  povEntityId: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface DeskEntity {
  id: string;
  type: string;
  name: string;
  aliases: string[];
  description: string | null;
  attributes: Record<string, unknown>;
  status: string;
  updatedAt: string;
}

export interface DeskFact {
  id: string;
  subjectId: string;
  predicate: string;
  objectEntityId: string | null;
  value: string | null;
  authority: string;
  supersedesFactId: string | null;
}

export interface DeskRelation {
  id?: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  createdAt?: string;
  outlineNodeId?: string | null;
}

export interface DeskThread {
  id: string;
  title: string;
  description: string;
  status: string;
  evidenceNodeIds: string[];
  targetFromNodeId: string | null;
  targetToNodeId: string | null;
}

export interface NamedFact extends DeskFact {
  subjectName: string;
  objectName: string | null;
}

export interface NamedRelation extends DeskRelation {
  fromName: string;
  toName: string;
}

export interface ProseContradiction {
  entityName: string;
  accepted: string;
  found: string;
}

export interface ChapterCompanionModel {
  chapter: DeskOutlineNode | null;
  previous: { title: string; summary: string | null } | null;
  cast: DeskEntity[];
  facts: NamedFact[];
  relations: NamedRelation[];
  threads: DeskThread[];
  contradictions: ProseContradiction[];
  registered: boolean;
}

const ACCEPTED = new Set(["confirmed", "locked"]);
const OPEN_THREAD = new Set(["planned", "planted", "developing"]);
const WORLD_TYPES = ["location", "organization", "item", "rule", "concept"] as const;
export type WorldType = (typeof WORLD_TYPES)[number];

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function mentions(prose: string, term: string): boolean {
  const needle = fold(term).trim();
  if (needle.length < 3) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "u",
  ).test(fold(prose));
}

function plannedIds(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const raw = metadata.plannedEntityIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

export function acceptedFacts(facts: readonly DeskFact[]): DeskFact[] {
  const replaced = new Set(
    facts.flatMap((fact) =>
      fact.supersedesFactId ? [fact.supersedesFactId] : [],
    ),
  );
  return facts.filter(
    (fact) => ACCEPTED.has(fact.authority) && !replaced.has(fact.id),
  );
}

function nodePositions(outline: readonly DeskOutlineNode[]): Map<string, number> {
  const index = new Map<string, number>();
  let chapterAt = -1;
  let insideChapter = false;
  for (const node of outline) {
    if (node.kind === "chapter") {
      if (node.status === "abandoned") {
        insideChapter = false;
        continue;
      }
      chapterAt += 1;
      insideChapter = true;
      index.set(node.id, chapterAt);
    } else if (insideChapter && (node.kind === "scene" || node.kind === "beat")) {
      index.set(node.id, chapterAt);
    }
  }
  return index;
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

function relationPosition(
  relation: DeskRelation,
  chapterIndex: ReadonlyMap<string, number>,
): number | null {
  if (!relation.outlineNodeId) return -1;
  const position = chapterIndex.get(relation.outlineNodeId);
  return position === undefined ? null : position;
}

export function currentRelations(
  relations: readonly DeskRelation[],
  castIds: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
  chapterIndex: ReadonlyMap<string, number>,
  here: number,
): NamedRelation[] {
  const chosen = new Map<string, DeskRelation>();
  for (const relation of relations) {
    if (!castIds.has(relation.fromEntityId) || !castIds.has(relation.toEntityId)) continue;
    const position = relationPosition(relation, chapterIndex);
    if (position === null || position > here) continue;
    const key = pairKey(relation.fromEntityId, relation.toEntityId);
    const current = chosen.get(key);
    if (!current || relationIsLater(relation, current, chapterIndex)) chosen.set(key, relation);
  }
  return [...chosen.values()].map((relation) => ({
    ...relation,
    fromName: names.get(relation.fromEntityId) ?? relation.fromEntityId,
    toName: names.get(relation.toEntityId) ?? relation.toEntityId,
  }));
}

function relationIsLater(
  candidate: DeskRelation,
  current: DeskRelation,
  chapterIndex: ReadonlyMap<string, number>,
): boolean {
  const candidateAt = relationPosition(candidate, chapterIndex) ?? -1;
  const currentAt = relationPosition(current, chapterIndex) ?? -1;
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  return (candidate.createdAt ?? "") > (current.createdAt ?? "");
}

function threadsForChapter(
  threads: readonly DeskThread[],
  chapterId: string | null,
  chapterIndex: ReadonlyMap<string, number>,
  here: number,
): DeskThread[] {
  const last = Math.max(-1, ...chapterIndex.values());
  return threads.filter((thread) => {
    if (!OPEN_THREAD.has(thread.status)) return false;
    if (chapterId && (thread.evidenceNodeIds ?? []).includes(chapterId)) return true;
    const from = thread.targetFromNodeId
      ? chapterIndex.get(thread.targetFromNodeId)
      : undefined;
    const to = thread.targetToNodeId
      ? chapterIndex.get(thread.targetToNodeId)
      : undefined;
    if (from === undefined && to === undefined) return false;
    const start = from ?? 0;
    const end = to ?? last;
    return here >= Math.min(start, end) && here <= Math.max(start, end);
  });
}

export function relationsForPerson(
  outline: readonly DeskOutlineNode[],
  relations: readonly DeskRelation[],
  entities: readonly DeskEntity[],
  personId: string,
): NamedRelation[] {
  const positions = nodePositions(outline);
  const values = [...positions.values()];
  const here = values.length > 0 ? Math.max(...values) : -1;
  const names = new Map(entities.map((entity) => [entity.id, entity.name]));
  return currentRelations(
    relations,
    new Set(entities.map((entity) => entity.id)),
    names,
    positions,
    here,
  ).filter(
    (relation) =>
      relation.fromEntityId === personId || relation.toEntityId === personId,
  );
}

function factText(fact: DeskFact, names: Map<string, string>): string {
  if (fact.value && fact.value.trim()) return fact.value.trim();
  if (fact.objectEntityId) return names.get(fact.objectEntityId) ?? fact.predicate;
  return fact.predicate;
}

function currentFactText(
  replacedId: string,
  facts: readonly DeskFact[],
  replaced: ReadonlySet<string>,
  names: Map<string, string>,
): string | null {
  const seen = new Set<string>();
  let currentId = replacedId;
  while (!seen.has(currentId)) {
    seen.add(currentId);
    const next = facts.find((fact) => fact.supersedesFactId === currentId);
    if (!next) return null;
    if (!replaced.has(next.id)) return factText(next, names);
    currentId = next.id;
  }
  return null;
}

export function buildChapterCompanion(input: {
  outlineNodeId: string | null;
  prose: string;
  outline: readonly DeskOutlineNode[];
  entities: readonly DeskEntity[];
  facts: readonly DeskFact[];
  relations: readonly DeskRelation[];
  threads: readonly DeskThread[];
}): ChapterCompanionModel {
  const sourceEntities = input.entities ?? [];
  const sourceFacts = input.facts ?? [];
  const sourceRelations = input.relations ?? [];
  const sourceThreads = input.threads ?? [];
  const chapters = (input.outline ?? []).filter(
    (node) => node.kind === "chapter" && node.status !== "abandoned",
  );
  const chapter =
    chapters.find((node) => node.id === input.outlineNodeId) ?? null;
  const index = chapter ? chapters.indexOf(chapter) : -1;
  const previousNode = index > 0 ? chapters[index - 1] : undefined;
  const names = new Map(sourceEntities.map((entity) => [entity.id, entity.name]));
  const active = sourceEntities.filter((entity) => entity.status !== "retired");
  const wanted = new Set<string>();
  if (chapter?.povEntityId) wanted.add(chapter.povEntityId);
  if (chapter) {
    for (const id of plannedIds(chapter.metadata)) wanted.add(id);
  }
  let cast = active.filter((entity) => wanted.has(entity.id));
  if (cast.length === 0) {
    cast = active
      .filter(
        (entity) =>
          entity.type === "character" &&
          [entity.name, ...(entity.aliases ?? [])].some((name) =>
            mentions(input.prose, name),
          ),
      )
      .slice(0, 8);
  }
  const castIds = new Set(cast.map((entity) => entity.id));
  const live = acceptedFacts(sourceFacts);
  const facts: NamedFact[] = live
    .filter((fact) => castIds.has(fact.subjectId))
    .map((fact) => ({
      ...fact,
      subjectName: names.get(fact.subjectId) ?? fact.subjectId,
      objectName: fact.objectEntityId
        ? (names.get(fact.objectEntityId) ?? null)
        : null,
    }));
  const chapterIndex = nodePositions(input.outline ?? []);
  const here = chapter ? (chapterIndex.get(chapter.id) ?? -1) : -1;
  const relations = currentRelations(sourceRelations, castIds, names, chapterIndex, here);
  const openThreads = threadsForChapter(sourceThreads, chapter?.id ?? null, chapterIndex, here);
  const replaced = new Set(
    sourceFacts.flatMap((fact) =>
      fact.supersedesFactId ? [fact.supersedesFactId] : [],
    ),
  );
  const contradictions: ProseContradiction[] = [];
  for (const entity of active) {
    const namesOfEntity = [entity.name, ...(entity.aliases ?? [])];
    if (!namesOfEntity.some((name) => mentions(input.prose, name))) continue;
    const currentValues = new Set(
      live
        .filter((fact) => fact.subjectId === entity.id)
        .map((fact) => fold(factText(fact, names))),
    );
    for (const old of sourceFacts) {
      if (old.subjectId !== entity.id || !replaced.has(old.id)) continue;
      const found = factText(old, names);
      if (found.length < 4 || currentValues.has(fold(found))) continue;
      if (!mentions(input.prose, found)) continue;
      const accepted = currentFactText(old.id, sourceFacts, replaced, names);
      contradictions.push({
        entityName: entity.name,
        found,
        accepted: accepted ?? old.predicate,
      });
    }
  }
  return {
    chapter,
    previous: previousNode
      ? { title: previousNode.title, summary: previousNode.summary }
      : null,
    cast,
    facts,
    relations,
    threads: openThreads,
    contradictions,
    registered: chapter?.status === "committed",
  };
}

export function worldSections(
  entities: readonly DeskEntity[],
  facts: readonly DeskFact[],
): Array<{ type: WorldType; entries: Array<{ entity: DeskEntity; facts: DeskFact[] }> }> {
  const live = acceptedFacts(facts);
  return WORLD_TYPES.map((type) => ({
    type,
    entries: entities
      .filter((entity) => entity.type === type && entity.status !== "retired")
      .map((entity) => ({
        entity,
        facts: live.filter((fact) => fact.subjectId === entity.id),
      })),
  })).filter((group) => group.entries.length > 0);
}

export function attributeText(
  attributes: Record<string, unknown>,
  key: string,
): string | null {
  const value = attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
