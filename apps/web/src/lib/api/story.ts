import type { ProjectCoverMutation, ProjectLanguage } from "@narralume/contracts";

import {
  currentDriverMode,
  readDriverOverride,
} from "../../kernel/transport";
import { jsonRequest, requestBlob, requestJson, requestVoid } from "./transport";
import type { Project, ProjectOverview, RecycledProject } from "./types";

export async function getProjects(signal?: AbortSignal): Promise<Project[]> {
  return getAllProjectPages(false, signal);
}

export async function getProjectsIncludingArchived(
  signal?: AbortSignal,
): Promise<Project[]> {
  return getAllProjectPages(true, signal);
}

async function getAllProjectPages(
  includeArchived: boolean,
  signal?: AbortSignal,
): Promise<Project[]> {
  const pageSize = 100;
  const projects: Project[] = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams();
    if (includeArchived) params.set("includeArchived", "true");
    if (offset > 0) params.set("offset", String(offset));
    const query = params.toString();
    const page = await requestJson<Project[]>(
      `/api/projects${query ? `?${query}` : ""}`,
      signal ? { signal } : {},
    );
    projects.push(...page);
    if (page.length < pageSize) return projects;
    offset += page.length;
  }
}

export async function createProject(input: {
  requestId: string;
  title: string;
  premise: string | null;
  language?: ProjectLanguage;
  form?: "short-story" | "novella" | "novel";
}): Promise<Project> {
  return requestJson<Project>("/api/projects", jsonRequest("POST", input));
}

export async function updateProject(
  projectId: string,
  input: {
    title: string;
    subtitle: string | null;
    premise: string | null;
    language?: ProjectLanguage;
    archived: boolean;
    expectedUpdatedAt: string;
    cover?: ProjectCoverMutation;
  },
): Promise<Project> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}`,
    jsonRequest("PUT", input),
  );
}

export function projectCoverUrl(
  project: Pick<Project, "id" | "cover">,
): string | null {
  if (!project.cover) return null;
  if (readDriverOverride() === "local" || currentDriverMode() === "local") {
    // local 模式封面无 HTTP URL——封面经 projectCoverBlob() 取 bytes 后
    // 由调用方渲染；此处返回 null 让调用方走默认占位或已缓存的 blob。
    return localCoverCache.get(coverCacheKey(project)) ?? null;
  }
  return `/api/projects/${encodeURIComponent(project.id)}/cover?v=${encodeURIComponent(project.cover.updatedAt)}`;
}

const localCoverCache = new Map<string, string>();
function coverCacheKey(
  project: Pick<Project, "id" | "cover">,
): string {
  return `${project.id}:${project.cover?.updatedAt ?? ""}`;
}

/** local 模式取封面 bytes 并缓存为 Blob URL（同封面更新时间只取一次）。 */
export async function projectCoverBlob(
  project: Pick<Project, "id" | "cover">,
): Promise<string | null> {
  if (!project.cover) return null;
  const key = coverCacheKey(project);
  const cached = localCoverCache.get(key);
  if (cached) return cached;
  const { blob } = await requestBlob(
    `/api/projects/${encodeURIComponent(project.id)}/cover`,
  );
  const url = URL.createObjectURL(blob);
  // 回收旧版本的 Blob URL，避免刷新封面后累积泄漏。
  for (const [existingKey, existingUrl] of localCoverCache) {
    if (existingKey.startsWith(`${project.id}:`) && existingKey !== key) {
      URL.revokeObjectURL(existingUrl);
      localCoverCache.delete(existingKey);
    }
  }
  localCoverCache.set(key, url);
  return url;
}

export async function duplicateProject(
  projectId: string,
  title?: string,
): Promise<Project> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/duplicate`,
    jsonRequest("POST", title ? { title } : {}),
  );
}

export async function deleteProject(
  project: Pick<Project, "id" | "title" | "updatedAt">,
): Promise<RecycledProject> {
  return requestJson(
    `/api/projects/${encodeURIComponent(project.id)}`,
    jsonRequest("DELETE", {
      confirmationTitle: project.title,
      expectedUpdatedAt: project.updatedAt,
    }),
  );
}

export async function getRecycledProjects(
  signal?: AbortSignal,
): Promise<RecycledProject[]> {
  return requestJson(
    "/api/projects/recycle-bin",
    signal ? { signal } : {},
  );
}


export async function restoreRecycledProject(
  project: Pick<RecycledProject, "id" | "deletionToken">,
): Promise<Project> {
  return requestJson(
    `/api/projects/${encodeURIComponent(project.id)}/restore`,
    jsonRequest("POST", { deletionToken: project.deletionToken }),
  );
}

export async function purgeRecycledProject(
  project: Pick<RecycledProject, "id" | "title" | "deletionToken">,
): Promise<void> {
  return requestVoid(
    `/api/projects/${encodeURIComponent(project.id)}/purge`,
    jsonRequest("DELETE", {
      deletionToken: project.deletionToken,
      confirmationTitle: project.title,
    }),
  );
}

/** 项目概览：进度、当前章节、活动任务、待办计数与下一步。 */
export async function getProjectOverview(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectOverview> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/overview`,
    signal ? { signal } : {},
  );
}
