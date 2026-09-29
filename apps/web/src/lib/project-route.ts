import { useParams } from "react-router";

/** 项目工作区只从 URL 读取作用域，避免刷新、深链和多标签页串项目。 */
export function useProjectId(): string | null {
  const { projectId } = useParams<{ projectId: string }>();
  return projectId ?? null;
}

export function projectWorkspacePath(projectId: string, workspace: string): string {
  return `/projects/${encodeURIComponent(projectId)}/${workspace}`;
}

/** 查询参数：打开故事圣经时展开并聚焦「从正文补全故事圣经」面板。 */
export const BIBLE_BACKFILL_PARAM = "backfill";

/** 导入完成后的「用 AI 补全故事圣经」入口。 */
export function bibleBackfillPath(projectId: string): string {
  return `${projectWorkspacePath(projectId, "bible")}?${BIBLE_BACKFILL_PARAM}=open`;
}
