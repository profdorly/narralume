/* Task ledger: records background tasks the author started (single-chapter run
   / quick create voyage / foundation book setup), so the project overview can
   offer a "back to the task" recovery entry alongside the server's source of
   truth. The ledger stores only navigation hints and never parses a task's
   internal Steps; the server overview is always authoritative. */

import { projectWorkspacePath } from "./project-route";

const LEDGER_KEY = "lapis:task-ledger";
const LEDGER_CAP = 20;

export interface TaskLedgerEntry {
  projectId: string;
  kind: "quick_creation" | "chapter" | "foundation";
  taskId: string;
  label: string;
  createdAt: string;
  origin?: Record<string, unknown> | null;
  documentId?: string | null;
}

export interface TaskNavigationContext {
  origin?: Record<string, unknown> | null;
  documentId?: string | null;
}

/** The task's location is derived from its product origin: writing tasks go
 *  back to the writing desk, continuous creation to quick create; only
 *  background tasks without a product origin fall back to the advanced runs
 *  page. */
export function taskHref(
  projectId: string,
  kind: TaskLedgerEntry["kind"] | string,
  taskId: string,
  context: TaskNavigationContext = {},
): string {
  const originDocumentId = typeof context.origin?.documentId === "string"
    ? context.origin.documentId
    : null;
  const documentId = context.documentId ?? originDocumentId;
  const surface = typeof context.origin?.surface === "string"
    ? context.origin.surface
    : null;
  if (kind === "quick_creation") {
    return `${projectWorkspacePath(projectId, "autopilot")}?session=${encodeURIComponent(taskId)}`;
  }
  if (kind === "foundation") {
    return `${projectWorkspacePath(projectId, "autopilot")}?foundation=${encodeURIComponent(taskId)}`;
  }
  if (kind === "chapter" || surface === "studio" || surface === "writing") {
    const params = new URLSearchParams({ run: taskId });
    if (documentId) params.set("document", documentId);
    return `${projectWorkspacePath(projectId, "studio")}?${params.toString()}`;
  }
  if (surface === "autopilot" || surface === "project-overview" || surface === "shelf") {
    return projectWorkspacePath(projectId, "autopilot");
  }
  return `${projectWorkspacePath(projectId, "runs")}?run=${encodeURIComponent(taskId)}`;
}

function readLedger(): TaskLedgerEntry[] {
  try {
    const raw = window.localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is TaskLedgerEntry =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as TaskLedgerEntry).projectId === "string" &&
        typeof (item as TaskLedgerEntry).taskId === "string",
    );
  } catch {
    return [];
  }
}

function writeLedger(entries: TaskLedgerEntry[]): void {
  try {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
  } catch {
    /* In private browsing, give up persistence */
  }
}

/**
 * Record a task that was just started; the same taskId counts as one entry
 * (idempotent retries add no duplicates).
 */
export function rememberTask(entry: TaskLedgerEntry): void {
  const rest = readLedger().filter((item) => item.taskId !== entry.taskId);
  writeLedger([entry, ...rest].slice(0, LEDGER_CAP));
}

/** Tasks of one project still in the ledger (newest first). */
export function rememberedTasks(projectId: string): TaskLedgerEntry[] {
  return readLedger().filter((item) => item.projectId === projectId);
}

/** When reconciling with the server's source of truth, move active tasks to the
 *  front but keep the latest terminal ones, so finished results can still be
 *  consumed by returning from the project overview. The capacity limit prunes
 *  old records. */
export function reconcileTasks(projectId: string, keeperTaskIds: string[]): void {
  const keepers = new Set(keeperTaskIds);
  const entries = readLedger();
  const projectEntries = entries.filter((item) => item.projectId === projectId);
  const otherEntries = entries.filter((item) => item.projectId !== projectId);
  const active = projectEntries.filter((item) => keepers.has(item.taskId));
  const recent = projectEntries.filter((item) => !keepers.has(item.taskId));
  writeLedger([...active, ...recent, ...otherEntries].slice(0, LEDGER_CAP));
}
