import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  duplicateProject,
  getProjects,
  getProjectsIncludingArchived,
  updateProject,
  uploadStoryFile,
  type ImportBatchDetail,
  type ImportFormat,
  type Project,
} from "../../lib/api";

export function importFormatFor(filename: string): ImportFormat {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "txt" || ext === "text") return "text";
  if (ext === "docx") return "docx";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "epub") return "epub";
  if (ext === "json") return "narrative-bundle";
  return "markdown";
}

export function chapterCount(project: Project): number {
  return project.committedChapters ?? project.totalChapters ?? 0;
}

export function useShelfProjects() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [view, setView] = useState<"covers" | "list">(() =>
    window.localStorage.getItem("shelf:view") === "list" ? "list" : "covers",
  );
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [importBatch, setImportBatch] = useState<ImportBatchDetail | null>(
    null,
  );
  const [actionError, setActionError] = useState<unknown>(null);

  const projectsQuery = useQuery({
    queryKey: ["projects", { archived: includeArchived }],
    queryFn: ({ signal }) =>
      includeArchived
        ? getProjectsIncludingArchived(signal)
        : getProjects(signal),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["projects"] });

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const source = projectsQuery.data ?? [];
    return source
      .filter(
        (project) =>
          !needle ||
          project.title.toLowerCase().includes(needle) ||
          (project.premise ?? "").toLowerCase().includes(needle) ||
          project.id.toLowerCase().startsWith(needle),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [projectsQuery.data, query]);

  const archiveMutation = useMutation({
    mutationFn: (project: Project) =>
      updateProject(project.id, {
        title: project.title,
        subtitle: project.subtitle,
        premise: project.premise,
        archived: !project.archivedAt,
        expectedUpdatedAt: project.updatedAt,
      }),
    onSuccess: () => {
      setMenuFor(null);
      setActionError(null);
      void refresh();
    },
    onError: (error) => {
      setMenuFor(null);
      setActionError(error);
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: (project: Project) => duplicateProject(project.id),
    onSuccess: () => {
      setMenuFor(null);
      setActionError(null);
      void refresh();
    },
    onError: (error) => {
      setMenuFor(null);
      setActionError(error);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      uploadStoryFile(file, null, importFormatFor(file.name)),
    onSuccess: (detail) => {
      setActionError(null);
      setImportBatch(detail);
    },
    onError: (error) => setActionError(error),
  });

  const selectView = (next: "covers" | "list") => {
    setMenuFor(null);
    setView(next);
    window.localStorage.setItem("shelf:view", next);
  };

  const isEmpty = !projectsQuery.isPending && rows.length === 0 && !query;

  return {
    query,
    setQuery,
    includeArchived,
    setIncludeArchived,
    view,
    selectView,
    menuFor,
    setMenuFor,
    importBatch,
    setImportBatch,
    actionError,
    setActionError,
    projectsQuery,
    rows,
    isEmpty,
    refresh,
    archiveMutation,
    duplicateMutation,
    uploadMutation,
  };
}
