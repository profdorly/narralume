import { textToBytes } from "../internal/bytes.js";
import {
  DeliveryServiceError,
  buildBundle,
  records,
  safeFilename,
  type DeliveryContext,
  type ProjectExportOptions,
} from "./bundle.js";
import {
  renderDocx,
  renderEpub,
  renderMarkdown,
  renderText,
} from "./render.js";

export async function exportProject(
  ctx: DeliveryContext,
  projectId: string,
  format: "markdown" | "text" | "docx" | "epub" | "narrative-bundle",
  now: string,
  options: ProjectExportOptions = {
    versionMode: "current",
    includeAnnotations: false,
    includeRuns: false,
  },
): Promise<{
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}> {
  const project = ctx.projects.get(projectId);
  if (!project)
    throw new DeliveryServiceError("project.not_found", "Project not found");
  const safeTitle = safeFilename(project.title);
  if (format === "narrative-bundle") {
    const bytes = textToBytes(
      JSON.stringify(buildBundle(ctx, projectId, now, options), null, 2),
    );
    return {
      filename: `${safeTitle}.narrative.json`,
      mimeType: "application/json; charset=utf-8",
      bytes,
    };
  }
  const sections = exportSections(ctx, projectId, options);
  if (format === "markdown") {
    return {
      filename: `${safeTitle}.md`,
      mimeType: "text/markdown; charset=utf-8",
      bytes: textToBytes(renderMarkdown(project, sections)),
    };
  }
  if (format === "text") {
    return {
      filename: `${safeTitle}.txt`,
      mimeType: "text/plain; charset=utf-8",
      bytes: textToBytes(renderText(project, sections)),
    };
  }
  if (format === "docx") {
    return {
      filename: `${safeTitle}.docx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: await renderDocx(project, sections),
    };
  }
  return {
    filename: `${safeTitle}.epub`,
    mimeType: "application/epub+zip",
    bytes: await renderEpub(project, sections),
  };
}

export function exportSections(
  ctx: DeliveryContext,
  projectId: string,
  options: ProjectExportOptions,
) {
  const outlineOrder = new Map(
    ctx.story.listOutline(projectId).map((node, index) => [node.id, index]),
  );
  const documents = ctx.documents
    .list(projectId)
    .filter((document) =>
      ["manuscript", "chapter", "scene"].includes(document.kind),
    )
    .sort((left, right) => {
      const leftOrder = left.outlineNodeId
        ? outlineOrder.get(left.outlineNodeId)
        : undefined;
      const rightOrder = right.outlineNodeId
        ? outlineOrder.get(right.outlineNodeId)
        : undefined;
      if (leftOrder !== undefined && rightOrder !== undefined)
        return leftOrder - rightOrder;
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;
      return 0;
    });
  const sections = documents.flatMap((document) => {
    const versions =
      options.versionMode === "history"
        ? [...ctx.documents.listVersions(projectId, document.id)].reverse()
        : document.currentVersionId
          ? [
              ctx.documents.getVersion(
                projectId,
                document.id,
                document.currentVersionId,
              ),
            ].filter((version): version is NonNullable<typeof version> =>
              Boolean(version),
            )
          : [];
    return versions.map((version, index) => ({
      documentId: document.id,
      versionId: version.id,
      title:
        options.versionMode === "history"
          ? `${document.title} · versão ${index + 1}`
          : document.title,
      content: version.content,
    }));
  });
  if (options.includeAnnotations) {
    const annotations = records(
      ctx.database,
      "SELECT * FROM document_comments WHERE project_id = ? ORDER BY created_at",
      projectId,
    );
    for (const section of sections) {
      const notes = annotations.filter(
        (annotation) => annotation.version_id === section.versionId,
      );
      if (notes.length) {
        section.content += `\n\n---\n\nAnotações\n\n${notes
          .map(
            (note, index) =>
              `${index + 1}. “${String(note.quote)}” — ${String(note.body)} [${String(note.status)}]`,
          )
          .join("\n")}`;
      }
    }
  }
  if (options.includeRuns) {
    const runs = records(
      ctx.database,
      "SELECT id, recipe, mode, status, started_at, finished_at, created_at FROM runs WHERE project_id = ? ORDER BY created_at",
      projectId,
    );
    if (runs.length)
      sections.push({
        documentId: "run-audit",
        versionId: "run-audit",
        title: "Apêndice · Registro das execuções de IA",
        content: runs
          .map(
            (run) =>
              `${String(run.created_at)} · ${String(run.recipe)} · ${String(run.mode)} · ${String(run.status)} · ${String(run.id)}`,
          )
          .join("\n"),
      });
  }
  return sections.filter((section) => section.content.trim());
}
