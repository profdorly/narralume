import { randomUuid } from "@lapis/domain";
import {
  createCanonEntity,
  createDocument,
  createOutlineNode,
  createProject,
  type ImportBatch,
  type ImportBatchDetail,
  type ImportCandidate,
  type ImportFormat,
  type CanonEntity,
  type StyleProfile,
  type WritingSkill,
} from "@lapis/domain";
import {
  docxDocumentText,
  htmlToText,
  inferStylePayload,
  splitManuscriptSections,
  trimLineEnds,
} from "../manuscript-import.js";
import { bytesToText, concatBytes, encodeBase64 } from "../internal/bytes.js";
import { declaredUncompressedSize } from "../internal/zip.js";
import type { ImportUploadSession } from "@lapis/persistence";
import JSZip from "jszip";

import {
  BundleSchema,
  DeliveryServiceError,
  boundedNumber,
  canonType,
  decodeBase64,
  hash,
  numberField,
  objectField,
  required,
  restoreBundle,
  skillScopes,
  stringArray,
  stringField,
  type DeliveryContext,
  type NarrativeBundle,
} from "./bundle.js";

export function createUpload(
  ctx: DeliveryContext,
  input: {
    id: string;
    targetProjectId: string | null;
    filename: string;
    format: ImportFormat;
    totalBytes: number;
    chunkSize: number;
    expectedHash: string | null;
    now: string;
  },
) {
  if (input.targetProjectId && !ctx.projects.get(input.targetProjectId))
    throw new DeliveryServiceError(
      "import.target.not_found",
      "Target project not found",
    );
  ctx.uploads.expire(input.now);
  return ctx.uploads.create({
    ...input,
    status: "uploading",
    expiresAt: new Date(
      Date.parse(input.now) + 24 * 60 * 60 * 1_000,
    ).toISOString(),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function putUploadChunk(
  ctx: DeliveryContext,
  input: {
    sessionId: string;
    chunkIndex: number;
    contentBase64: string;
    chunkHash: string;
    now: string;
  },
) {
  const session = ctx.uploads.require(input.sessionId);
  if (session.status !== "uploading")
    throw new DeliveryServiceError(
      "import.upload.not_open",
      "The upload session has ended",
    );
  if (session.expiresAt <= input.now) {
    ctx.uploads.expire(input.now);
    throw new DeliveryServiceError(
      "import.upload.expired",
      "The upload session has expired",
    );
  }
  const bytes = decodeBase64(input.contentBase64);
  if (bytes.length === 0 || bytes.length > session.chunkSize)
    throw new DeliveryServiceError(
      "import.upload.chunk_size",
      "The chunk is empty or larger than the chunk size declared by the session",
    );
  if (hash(bytes) !== input.chunkHash)
    throw new DeliveryServiceError(
      "import.upload.chunk_hash",
      "Chunk hash verification failed",
    );
  const expectedIndex = Math.floor(
    Math.max(0, session.totalBytes - 1) / session.chunkSize,
  );
  if (input.chunkIndex > expectedIndex)
    throw new DeliveryServiceError(
      "import.upload.chunk_index",
      "The chunk index is outside the file range",
    );
  const expectedSize = Math.min(
    session.chunkSize,
    session.totalBytes - input.chunkIndex * session.chunkSize,
  );
  if (bytes.length !== expectedSize)
    throw new DeliveryServiceError(
      "import.upload.chunk_size",
      "The chunk size does not match the declared file span",
    );
  const next = ctx.uploads.putChunk(
    session.id,
    input.chunkIndex,
    input.contentBase64,
    bytes.length,
    input.chunkHash,
    input.now,
  );
  return next;
}

export async function completeUpload(
  ctx: DeliveryContext,
  sessionId: string,
  now: string,
) {
  const session = ctx.uploads.require(sessionId);
  if (session.status === "completed") {
    return completedUploadResult(ctx, session);
  }
  if (session.status !== "uploading")
    throw new DeliveryServiceError(
      "import.upload.not_open",
      "The upload session is not usable",
    );
  const chunks = ctx.uploads.chunks(sessionId);
  const expectedChunks = Math.ceil(session.totalBytes / session.chunkSize);
  if (
    session.receivedBytes !== session.totalBytes ||
    chunks.length !== expectedChunks ||
    chunks.some((chunk, index) => chunk.chunkIndex !== index)
  )
    throw new DeliveryServiceError(
      "import.upload.incomplete",
      "The file chunks have not all been uploaded yet",
    );
  const bytes = concatBytes(
    chunks.map((chunk) => decodeBase64(chunk.contentBase64)),
  );
  if (session.expectedHash && hash(bytes) !== session.expectedHash)
    throw new DeliveryServiceError(
      "import.upload.file_hash",
      "Whole-file hash verification failed",
    );
  const prepared = await prepareImportPreview(ctx, {
    targetProjectId: session.targetProjectId,
    filename: session.filename,
    format: session.format,
    contentBase64: encodeBase64(bytes),
    now,
  });
  return ctx.database.transaction(() => {
    const current = ctx.uploads.require(sessionId);
    if (current.status === "completed") {
      return completedUploadResult(ctx, current);
    }
    if (current.status !== "uploading") {
      throw new DeliveryServiceError(
        "import.upload.not_open",
        "The upload session is not usable",
      );
    }
    if (
      prepared.batch.targetProjectId &&
      !ctx.projects.get(prepared.batch.targetProjectId)
    ) {
      throw new DeliveryServiceError(
        "import.target.not_found",
        "Target project not found",
      );
    }
    persistImportPreview(ctx, prepared);
    ctx.uploads.complete(sessionId, prepared.batch.id, now);
    ctx.uploads.clearChunks(sessionId);
    return completedUploadResult(ctx, ctx.uploads.require(sessionId));
  });
}

export async function previewImport(
  ctx: DeliveryContext,
  input: {
    targetProjectId: string | null;
    filename: string;
    format: ImportFormat;
    contentBase64: string;
    now: string;
  },
): Promise<ImportBatchDetail> {
  const prepared = await prepareImportPreview(ctx, input);
  return ctx.database.transaction(() => {
    persistImportPreview(ctx, prepared);
    return ctx.delivery.getImportBatchDetail(prepared.batch.id)!;
  });
}

async function prepareImportPreview(
  ctx: DeliveryContext,
  input: {
    targetProjectId: string | null;
    filename: string;
    format: ImportFormat;
    contentBase64: string;
    now: string;
  },
): Promise<{ batch: ImportBatch; candidates: ImportCandidate[] }> {
  if (input.targetProjectId && !ctx.projects.get(input.targetProjectId)) {
    throw new DeliveryServiceError(
      "import.target.not_found",
      "Target project not found",
    );
  }
  const bytes = decodeBase64(input.contentBase64);
  if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024) {
    throw new DeliveryServiceError(
      "import.size.invalid",
      "The imported file must be between 1 byte and 50 MB",
    );
  }
  const batchId = randomUuid();
  const sourceHash = hash(bytes);
  let sourceText: string;
  let bundle: NarrativeBundle | null = null;
  if (input.format === "epub") sourceText = await extractEpub(bytes);
  else if (input.format === "docx") sourceText = await extractDocx(bytes);
  else if (input.format === "html")
    sourceText = normalizeImportedText(htmlToText(bytesToText(bytes)));
  else if (input.format === "narrative-bundle") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytesToText(bytes));
    } catch {
      throw new DeliveryServiceError(
        "import.bundle.invalid_json",
        "The project bundle is not valid JSON",
      );
    }
    const checked = BundleSchema.safeParse(parsed);
    if (!checked.success) {
      throw new DeliveryServiceError(
        "import.bundle.invalid_schema",
        "The project bundle structure or version is not supported",
      );
    }
    bundle = checked.data;
    sourceText = bundle.documents
      .flatMap((item) => item.versions)
      .map((version) => stringField(version, "content") ?? "")
      .join("\n\n");
  } else sourceText = normalizeImportedText(bytesToText(bytes));

  const title = bundle?.project.title ?? titleFromFilename(input.filename);
  const candidates = bundle
    ? candidatesFromBundle(batchId, bundle, input.now)
    : candidatesFromText(batchId, title, sourceText, input.now);
  return {
    batch: {
      id: batchId,
      targetProjectId: input.targetProjectId,
      filename: input.filename,
      format: input.format,
      sourceHash,
      sourceCharacters: [...sourceText].length,
      status: "previewed",
      metadata: {
        title,
        candidateCount: candidates.length,
        ...(bundle ? { bundleVersion: 1 } : {}),
      },
      analysisRunId: null,
      appliedProjectId: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
    candidates,
  };
}

function persistImportPreview(
  ctx: DeliveryContext,
  prepared: {
    batch: ImportBatch;
    candidates: readonly ImportCandidate[];
  },
): void {
  ctx.delivery.insertImportBatch(prepared.batch);
  for (const candidate of prepared.candidates) {
    ctx.delivery.upsertImportCandidate(candidate);
  }
}

function completedUploadResult(
  ctx: DeliveryContext,
  session: ImportUploadSession,
) {
  if (!session.batchId) {
    throw new DeliveryServiceError(
      "import.upload.batch_missing",
      "The completed upload session has no import batch linked",
    );
  }
  const detail = ctx.delivery.getImportBatchDetail(session.batchId);
  if (!detail) {
    throw new DeliveryServiceError(
      "import.upload.batch_missing",
      "The import batch linked to the upload session does not exist",
    );
  }
  return { session, detail };
}

export function applyImport(
  ctx: DeliveryContext,
  input: {
    batchId: string;
    selectedCandidateIds: readonly string[];
    projectTitle?: string;
    now: string;
  },
): { projectId: string; detail: ImportBatchDetail } {
  const batch = ctx.delivery.requireImportBatch(input.batchId);
  if (batch.status === "applied") {
    return {
      projectId: required(batch.appliedProjectId, "applied project"),
      detail: ctx.delivery.getImportBatchDetail(batch.id)!,
    };
  }
  if (batch.status === "discarded") {
    throw new DeliveryServiceError(
      "import.discarded",
      "A discarded import cannot be applied again",
    );
  }
  const allCandidates = ctx.delivery.listImportCandidates(batch.id);
  const selectedIds = new Set(
    input.selectedCandidateIds.length
      ? input.selectedCandidateIds
      : allCandidates
          .filter((candidate) => candidate.status !== "discarded")
          .map((candidate) => candidate.id),
  );
  const selected = allCandidates.filter((candidate) =>
    selectedIds.has(candidate.id),
  );
  if (selected.length === 0) {
    throw new DeliveryServiceError(
      "import.candidates.empty",
      "Select at least one split candidate",
    );
  }
  const bundleCandidate = selected.find(
    (candidate) => candidate.kind === "project" && candidate.payload.bundle,
  );
  const projectId = ctx.database.transaction(() => {
    let appliedProjectId: string;
    if (bundleCandidate) {
      const bundle = BundleSchema.parse(bundleCandidate.payload.bundle);
      appliedProjectId = restoreBundle(
        ctx,
        bundle,
        input.projectTitle ?? `${bundle.project.title} · cópia restaurada`,
        input.now,
      ).projectId;
    } else {
      appliedProjectId = applyCandidates(
        ctx,
        batch,
        selected,
        input.projectTitle,
        input.now,
      );
    }
    for (const candidate of allCandidates) {
      ctx.delivery.setCandidateStatus(
        candidate.id,
        selectedIds.has(candidate.id) ? "applied" : "discarded",
        input.now,
      );
    }
    ctx.delivery.updateImportBatch(
      batch.id,
      { status: "applied", appliedProjectId },
      input.now,
    );
    return appliedProjectId;
  });
  return {
    projectId,
    detail: ctx.delivery.getImportBatchDetail(batch.id)!,
  };
}

export function discardImport(
  ctx: DeliveryContext,
  batchId: string,
  now: string,
): ImportBatchDetail {
  const batch = ctx.delivery.requireImportBatch(batchId);
  if (batch.status !== "applied") {
    ctx.delivery.updateImportBatch(batchId, { status: "discarded" }, now);
  }
  return ctx.delivery.getImportBatchDetail(batchId)!;
}

function applyCandidates(
  ctx: DeliveryContext,
  batch: {
    targetProjectId: string | null;
    filename: string;
    metadata: Readonly<Record<string, unknown>>;
  },
  candidates: readonly ImportCandidate[],
  projectTitle: string | undefined,
  now: string,
): string {
  let projectId = batch.targetProjectId;
  if (!projectId) {
    const projectCandidate = candidates.find(
      (candidate) => candidate.kind === "project",
    );
    const title =
      projectTitle ??
      stringField(projectCandidate?.payload, "title") ??
      stringField(batch.metadata, "title") ??
      titleFromFilename(batch.filename);
    projectId = randomUuid();
    ctx.projects.insert(
      createProject({
        id: projectId,
        title,
        premise: stringField(projectCandidate?.payload, "premise"),
        now,
      }),
    );
  }
  let root = ctx.story
    .listOutline(projectId)
    .find((node) => node.kind === "book" && node.parentId === null);
  if (!root) {
    root = ctx.story.insertOutlineNode(
      createOutlineNode({
        id: randomUuid(),
        projectId,
        parent: null,
        kind: "book",
        ordinal: 0,
        title: ctx.projects.get(projectId)!.title,
        now,
      }),
    );
  }
  let chapterOrdinal = ctx.story.listOutlineChildren(projectId, root.id).length;
  const labels = importNoteLabels(ctx.projects.get(projectId)!.language);
  for (const candidate of candidates) {
    if (candidate.kind === "document") {
      const title = stringField(candidate.payload, "title") ?? candidate.title;
      const content = stringField(candidate.payload, "content") ?? "";
      const kind =
        stringField(candidate.payload, "kind") === "chapter"
          ? "chapter"
          : "manuscript";
      const chapter =
        kind === "chapter"
          ? ctx.story.insertOutlineNode(
              createOutlineNode({
                id: randomUuid(),
                projectId,
                parent: root,
                kind: "chapter",
                ordinal: chapterOrdinal,
                title,
                summary: stringField(candidate.payload, "summary"),
                metadata: { importCandidateId: candidate.id },
                now,
              }),
            )
          : null;
      const document = ctx.documents.insert(
        createDocument({
          id: randomUuid(),
          projectId,
          kind,
          title,
          outlineNodeId: chapter?.id ?? null,
          now,
        }),
      );
      const version = ctx.documents.appendVersion(projectId, document.id, {
        id: randomUuid(),
        content,
        source: `import:${candidate.batchId}`,
        expectedCurrentVersionId: null,
        now,
      });
      if (chapter) {
        ctx.indexer.indexDocument({
          projectId,
          documentId: document.id,
          versionId: version.id,
          provenance: { importCandidateId: candidate.id },
          now,
        });
        const summary = stringField(candidate.payload, "summary");
        if (summary) {
          ctx.state.upsertSummary({
            id: `import:${candidate.id}:summary`,
            projectId,
            scopeType: "chapter",
            scopeId: chapter.id,
            summary,
            stateDelta: {},
            sourceHash: version.contentHash,
            createdAt: now,
          });
        }
        ctx.story.updateOutlineStatus(projectId, chapter.id, "committed", now);
        chapterOrdinal += 1;
      }
    } else if (candidate.kind === "entity") {
      const name = stringField(candidate.payload, "name") ?? candidate.title;
      if (
        !ctx.canon
          .listEntities(projectId, { includeRetired: true })
          .some((entity) => entity.name === name)
      ) {
        ctx.canon.insertEntity(
          createCanonEntity({
            id: randomUuid(),
            projectId,
            type: canonType(stringField(candidate.payload, "type")),
            name,
            description: stringField(candidate.payload, "description"),
            aliases: stringArray(candidate.payload.aliases),
            attributes: objectField(candidate.payload, "attributes"),
            now,
          }),
        );
      }
    } else if (candidate.kind === "intent") {
      ctx.story.upsertAuthorIntent({
        projectId,
        promise: stringField(candidate.payload, "promise"),
        themes: stringArray(candidate.payload.themes),
        audience: stringField(candidate.payload, "audience"),
        tone: stringField(candidate.payload, "tone"),
        boundaries: stringArray(candidate.payload.boundaries),
        endingDirection: stringField(candidate.payload, "endingDirection"),
        currentFocus: stringField(candidate.payload, "currentFocus"),
        lockedFields: [],
        updatedAt: now,
      });
    } else if (candidate.kind === "style") {
      ctx.delivery.insertStyleProfile(
        styleFromPayload(projectId, candidate, now),
      );
    } else if (candidate.kind === "skill") {
      ctx.delivery.insertWritingSkill(
        skillFromPayload(projectId, candidate, now),
      );
    } else if (candidate.kind === "relationship") {
      const from = entityByImportedName(
        ctx.canon.listEntities(projectId),
        stringField(candidate.payload, "fromName"),
      );
      const to = entityByImportedName(
        ctx.canon.listEntities(projectId),
        stringField(candidate.payload, "toName"),
      );
      if (from && to)
        ctx.state.insertRelationship({
          id: randomUuid(),
          projectId,
          fromEntityId: from.id,
          toEntityId: to.id,
          relation:
            stringField(candidate.payload, "relation") ??
            labels.defaultRelation,
          intensity: null,
          state: {
            description: stringField(candidate.payload, "description"),
            evidence: objectField(candidate.payload, "evidence"),
          },
          outlineNodeId: null,
          storyTime: null,
          sourceId: candidate.id,
          supersedesEventId: null,
          createdAt: now,
        });
    } else if (candidate.kind === "timeline") {
      const participants = stringArray(candidate.payload.participantNames)
        .map((name) =>
          entityByImportedName(ctx.canon.listEntities(projectId), name),
        )
        .filter((entity): entity is CanonEntity => Boolean(entity))
        .map((entity) => entity.id);
      ctx.state.insertTimelineEvent({
        id: randomUuid(),
        projectId,
        title: stringField(candidate.payload, "title") ?? candidate.title,
        description: stringField(candidate.payload, "description"),
        outlineNodeId: null,
        storyTimeStart: null,
        storyTimeEnd: null,
        sequence: numberField(candidate.payload, "sequence"),
        participants,
        causes: [],
        visibility: "reader",
        sourceId: candidate.id,
        createdAt: now,
        updatedAt: now,
      });
    } else if (candidate.kind === "foreshadow") {
      ctx.state.insertForeshadow({
        id: randomUuid(),
        projectId,
        title: stringField(candidate.payload, "title") ?? candidate.title,
        description:
          stringField(candidate.payload, "description") ?? candidate.title,
        status: "planted",
        importance: 3,
        targetFromNodeId: null,
        targetToNodeId: null,
        dependencies: [],
        evidenceNodeIds: [],
        resolutionNodeId: null,
        // Import provenance, as for relationships and timeline events.
        sourceId: candidate.id,
        createdAt: now,
        updatedAt: now,
      });
    } else if (
      candidate.kind === "character-arc" ||
      candidate.kind === "scene-analysis"
    ) {
      const document = ctx.documents.insert(
        createDocument({
          id: randomUuid(),
          projectId,
          kind: "note",
          title: candidate.title,
          now,
        }),
      );
      ctx.documents.appendVersion(projectId, document.id, {
        id: randomUuid(),
        content: renderAnalysisCandidate(candidate, labels),
        source: `import-analysis:${candidate.id}`,
        expectedCurrentVersionId: null,
        now,
      });
    }
  }
  return projectId;
}

function candidatesFromText(
  batchId: string,
  title: string,
  sourceText: string,
  now: string,
): ImportCandidate[] {
  const sections = splitManuscriptSections(sourceText, title);
  const candidates: ImportCandidate[] = [
    candidate(batchId, "project", 0, title, { title, premise: null }, now),
    ...sections.map((section, index) =>
      candidate(
        batchId,
        "document",
        index,
        section.title,
        {
          title: section.title,
          kind: sections.length > 1 ? "chapter" : "manuscript",
          content: section.content,
          characters: [...section.content].length,
        },
        now,
      ),
    ),
  ];
  if (sourceText.trim()) {
    const style = inferStylePayload(sourceText);
    candidates.push(
      candidate(batchId, "style", 0, style.name, { ...style }, now),
    );
  }
  return candidates;
}

function candidatesFromBundle(
  batchId: string,
  bundle: NarrativeBundle,
  now: string,
): ImportCandidate[] {
  return [
    candidate(
      batchId,
      "project",
      0,
      `Restauração completa de “${bundle.project.title}”`,
      {
        title: bundle.project.title,
        premise: bundle.project.premise,
        bundle,
        counts: {
          outline: bundle.outline.length,
          entities: bundle.entities.length,
          facts: bundle.facts.length,
          documents: bundle.documents.length,
          personas: bundle.personas.length,
          styles: bundle.styles.length,
          skills: bundle.skills.length,
        },
      },
      now,
    ),
  ];
}

function candidate(
  batchId: string,
  kind: ImportCandidate["kind"],
  ordinal: number,
  title: string,
  payload: Record<string, unknown>,
  now: string,
): ImportCandidate {
  return {
    id: `${batchId}:${kind}:${ordinal}`,
    batchId,
    kind,
    ordinal,
    title,
    payload,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
}

async function extractEpub(bytes: Uint8Array) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DeliveryServiceError(
      "import.epub.invalid",
      "The EPUB container could not be read",
    );
  }
  const entries = Object.values(zip.files);
  if (entries.length > 2_000) {
    throw new DeliveryServiceError(
      "import.epub.entry_limit",
      "The EPUB entry count exceeds the safety limit (2000)",
    );
  }
  const declaredBytes = entries.reduce(
    (sum, entry) => sum + declaredUncompressedSize(entry),
    0,
  );
  if (declaredBytes > 100 * 1024 * 1024) {
    throw new DeliveryServiceError(
      "import.epub.expansion_limit",
      "The EPUB declares an uncompressed size above the safety limit (100 MB)",
    );
  }
  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (container && container.length > 1024 * 1024) {
    throw new DeliveryServiceError(
      "import.epub.container_too_large",
      "The EPUB container manifest is unusually large",
    );
  }
  const opfPath = container?.match(/full-path=["']([^"']+)["']/iu)?.[1];
  if (!opfPath) {
    throw new DeliveryServiceError(
      "import.epub.container_missing",
      "The EPUB is missing META-INF/container.xml or the OPF path",
    );
  }
  const opf = await zip.file(opfPath)?.async("string");
  if (!opf)
    throw new DeliveryServiceError(
      "import.epub.opf_missing",
      "The EPUB is missing the OPF manifest",
    );
  if (opf.length > 5 * 1024 * 1024) {
    throw new DeliveryServiceError(
      "import.epub.opf_too_large",
      "The EPUB OPF manifest is unusually large",
    );
  }
  const base = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
    : "";
  const manifest = new Map<string, string>();
  for (const match of opf.matchAll(/<item\b([^>]+)>?/giu)) {
    const attrs = match[1] ?? "";
    const id = attrs.match(/\bid=["']([^"']+)["']/iu)?.[1];
    const href = attrs.match(/\bhref=["']([^"']+)["']/iu)?.[1];
    const media = attrs.match(/\bmedia-type=["']([^"']+)["']/iu)?.[1];
    if (
      id &&
      href &&
      (media === "application/xhtml+xml" || media === "text/html")
    ) {
      manifest.set(id, decodeEpubHref(href));
    }
  }
  const spine = [
    ...opf.matchAll(/<itemref\b[^>]*idref=["']([^"']+)["'][^>]*\/?\s*>/giu),
  ].map((match) => match[1]!);
  const paths = (
    spine.length ? spine.map((id) => manifest.get(id)) : [...manifest.values()]
  ).filter((value): value is string => Boolean(value));
  const texts: string[] = [];
  let extractedBytes = 0;
  for (const path of paths) {
    const html = await zip.file(`${base}${path}`)?.async("string");
    if (!html) continue;
    if (/<body\b[^>]*class=["'][^"']*title-page/iu.test(html)) continue;
    const pageBytes = html.length;
    if (pageBytes > 10 * 1024 * 1024) {
      throw new DeliveryServiceError(
        "import.epub.page_too_large",
        "A single EPUB content page exceeds the safety limit (10 MB)",
      );
    }
    extractedBytes += pageBytes;
    if (extractedBytes > 50 * 1024 * 1024) {
      throw new DeliveryServiceError(
        "import.epub.content_limit",
        "The EPUB uncompressed content exceeds the safety limit (50 MB)",
      );
    }
    texts.push(htmlToText(html));
  }
  const result = normalizeImportedText(texts.join("\n\n"));
  if (!result.trim()) {
    throw new DeliveryServiceError(
      "import.epub.empty",
      "The EPUB contains no readable manuscript text",
    );
  }
  return result;
}

function decodeEpubHref(href: string): string {
  const xmlDecoded = href
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
  try {
    return decodeURIComponent(xmlDecoded);
  } catch {
    throw new DeliveryServiceError(
      "import.epub.invalid_href",
      "The EPUB manifest contains an invalid content path encoding",
    );
  }
}

async function extractDocx(bytes: Uint8Array) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new DeliveryServiceError(
      "import.docx.invalid",
      "The DOCX container could not be read",
    );
  }
  const entries = Object.values(zip.files);
  if (entries.length > 2_000)
    throw new DeliveryServiceError(
      "import.docx.entry_limit",
      "The DOCX entry count exceeds the safety limit (2000)",
    );
  if (
    entries.reduce((sum, entry) => sum + declaredUncompressedSize(entry), 0) >
    100 * 1024 * 1024
  )
    throw new DeliveryServiceError(
      "import.docx.expansion_limit",
      "The DOCX declares an uncompressed size above the safety limit (100 MB)",
    );
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml)
    throw new DeliveryServiceError(
      "import.docx.document_missing",
      "The DOCX is missing word/document.xml",
    );
  if (documentXml.length > 100 * 1024 * 1024)
    throw new DeliveryServiceError(
      "import.docx.document_too_large",
      "The expanded DOCX content exceeds the safety limit",
    );
  // 样式表可选；用于识别本地化 Word 的标题样式（如葡语 Ttulo1 → heading 1）。
  const stylesXml =
    (await zip.file("word/styles.xml")?.async("string")) ?? null;
  if (documentXml.length + (stylesXml?.length ?? 0) > 100 * 1024 * 1024)
    throw new DeliveryServiceError(
      "import.docx.document_too_large",
      "The expanded DOCX content exceeds the safety limit",
    );
  return normalizeImportedText(docxDocumentText(documentXml, stylesXml));
}

function normalizeImportedText(value: string) {
  return trimLineEnds(
    value
      .replace(/^\uFEFF/u, "")
      .replace(/\0/gu, "")
      .replace(/\r\n?/gu, "\n"),
  )
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
}

function entityByImportedName(
  entities: readonly CanonEntity[],
  name: string | null,
): CanonEntity | null {
  if (!name) return null;
  const normalized = name.normalize("NFKC").toLocaleLowerCase();
  return (
    entities.find(
      (entity) =>
        entity.name.normalize("NFKC").toLocaleLowerCase() === normalized ||
        entity.aliases.some(
          (alias) => alias.normalize("NFKC").toLocaleLowerCase() === normalized,
        ),
    ) ?? null
  );
}

/** Notes written at import follow the project's writing language.
 *  Style-candidate wording follows the manuscript script; see inferStylePayload. */
function importNoteLabels(language: string) {
  return language === "en"
    ? {
        defaultRelation: "related",
        evidence: "Source evidence",
        position: "Position: ",
        contentHash: "Content hash: ",
      }
    : {
        defaultRelation: "relacionado",
        evidence: "Evidência da origem",
        position: "Posição: ",
        contentHash: "Hash do texto: ",
      };
}

function renderAnalysisCandidate(
  candidate: ImportCandidate,
  labels: ReturnType<typeof importNoteLabels>,
): string {
  const evidence = Array.isArray(candidate.payload.evidence)
    ? candidate.payload.evidence.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  return [
    `# ${candidate.title}`,
    ...Object.entries(candidate.payload)
      .filter(([key, value]) => key !== "evidence" && typeof value === "string")
      .map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
    `## ${labels.evidence}`,
    ...evidence.flatMap((item) => [
      `[P${String(item.paragraphOrdinal ?? "?")}] ${String(item.quote ?? "")}`,
      `${labels.position}${String(item.start ?? "?")}–${String(item.end ?? "?")}`,
      `${labels.contentHash}${String(item.contentHash ?? "")}`,
    ]),
  ].join("\n");
}

function styleFromPayload(
  projectId: string,
  candidate: ImportCandidate,
  now: string,
): StyleProfile {
  return {
    id: randomUuid(),
    projectId,
    name: stringField(candidate.payload, "name") ?? candidate.title,
    description: stringField(candidate.payload, "description"),
    rules: stringArray(candidate.payload.rules),
    examples: stringArray(candidate.payload.examples),
    negativeRules: stringArray(candidate.payload.negativeRules),
    source: `import:${candidate.batchId}`,
    active: candidate.payload.active === true,
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function skillFromPayload(
  projectId: string,
  candidate: ImportCandidate,
  now: string,
): WritingSkill {
  return {
    id: randomUuid(),
    projectId,
    name: stringField(candidate.payload, "name") ?? candidate.title,
    description: stringField(candidate.payload, "description"),
    instructions:
      stringField(candidate.payload, "instructions") ??
      "Manter os fatos narrativos e o ponto de vista originais.",
    scopes: skillScopes(candidate.payload.scopes),
    priority: boundedNumber(candidate.payload.priority, 0, 100, 50),
    enabled: candidate.payload.enabled !== false,
    source: `import:${candidate.batchId}`,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

function titleFromFilename(filename: string) {
  return (
    filename
      .replace(/\.narrative\.json$/iu, "")
      .replace(/\.(?:md|markdown|txt|epub|docx|html?|xhtml|json)$/iu, "")
      .trim() || "Obra importada"
  );
}
