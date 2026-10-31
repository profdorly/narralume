import { useParams } from "react-router";

/**
 * The project workspace reads its scope only from the URL, so refreshes, deep
 * links and multiple tabs never mix projects.
 */
export function useProjectId(): string | null {
  const { projectId } = useParams<{ projectId: string }>();
  return projectId ?? null;
}

export function projectWorkspacePath(projectId: string, workspace: string): string {
  return `/projects/${encodeURIComponent(projectId)}/${workspace}`;
}

/**
 * Query parameter: when opening the story bible, expand and focus the "Fill in
 * the story bible from the manuscript" panel.
 */
export const BIBLE_BACKFILL_PARAM = "backfill";

/**
 * The "Use AI to fill in the story bible" entry shown after an import finishes.
 */
export function bibleBackfillPath(projectId: string): string {
  return `${projectWorkspacePath(projectId, "bible")}?${BIBLE_BACKFILL_PARAM}=open`;
}
