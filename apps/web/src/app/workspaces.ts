import {
  Activity,
  BookOpenText,
  Brain,
  Compass,
  Cpu,
  LibraryBig,
  PenLine,
  Radar,

  Truck,
  type LucideIcon,
} from "lucide-react";

import type { MessageKey } from "../i18n";

/* Main navigation is reduced to five creative surfaces: shelf / project
   overview / story / writing / delivery. The other workspaces (review,
   autopilot, run ledger, long-form simulation, model supply) sit in the
   "Advanced tools" group for now, to be merged in or retired as the writing
   desk merge and the settings migration progress. label / blurb are i18n
   dictionary keys, resolved on display with t() / translate(). */

export interface WorkspaceDef {
  id: string;
  path: string;
  projectScoped: boolean;
  label: MessageKey;
  en: string;
  index: string;
  icon: LucideIcon;
  blurb: MessageKey;
}

export const WORKSPACES: WorkspaceDef[] = [
  {
    id: "shelf",
    path: "/shelf",
    projectScoped: false,
    label: "shell.nav.shelf",
    en: "ESTANTE",
    index: "01",
    icon: LibraryBig,
    blurb: "shell.nav.shelfBlurb",
  },
  {
    id: "overview",
    path: "/projects/:projectId/overview",
    projectScoped: true,
    label: "shell.nav.overview",
    en: "VISÃO",
    index: "02",
    icon: Compass,
    blurb: "shell.nav.overviewBlurb",
  },
  {
    id: "bible",
    path: "/projects/:projectId/bible",
    projectScoped: true,
    label: "shell.nav.bible",
    en: "BÍBLIA",
    index: "03",
    icon: BookOpenText,
    blurb: "shell.nav.bibleBlurb",
  },
  {
    id: "studio",
    path: "/projects/:projectId/studio",
    projectScoped: true,
    label: "shell.nav.studio",
    en: "ESTÚDIO",
    index: "04",
    icon: PenLine,
    blurb: "shell.nav.studioBlurb",
  },
  {
    id: "delivery",
    path: "/projects/:projectId/delivery",
    projectScoped: true,
    label: "shell.nav.delivery",
    en: "ENTREGA",
    index: "05",
    icon: Truck,
    blurb: "shell.nav.deliveryBlurb",
  },
];

/**
 * Continuous creation is a regular product entry, but shown in a separate group
 * from the five stable workspaces.
 */
export const QUICK_WORKSPACES: WorkspaceDef[] = [
  {
    id: "autopilot",
    path: "/projects/:projectId/autopilot",
    projectScoped: true,
    label: "shell.nav.autopilot",
    en: "CRIAR",
    index: "Q1",
    icon: Radar,
    blurb: "shell.nav.autopilotBlurb",
  },
];

/* Advanced tools group: only diagnostics, simulation and global configuration,
   never the main creative flow. */
export const ADVANCED_WORKSPACES: WorkspaceDef[] = [
  {
    id: "runs",
    path: "/projects/:projectId/runs",
    projectScoped: true,
    label: "shell.nav.runs",
    en: "EXECUÇÕES",
    index: "L1",
    icon: Activity,
    blurb: "shell.nav.runsBlurb",
  },
  {
    id: "lab",
    path: "/projects/:projectId/lab",
    projectScoped: true,
    label: "shell.nav.lab",
    en: "LAB",
    index: "L2",
    icon: Brain,
    blurb: "shell.nav.labBlurb",
  },
  {
    id: "supply",
    path: "/settings",
    projectScoped: false,
    label: "shell.nav.settings",
    en: "AJUSTES",
    index: "S1",
    icon: Cpu,
    blurb: "shell.nav.settingsBlurb",
  },
];

const ALL_WORKSPACES = [...WORKSPACES, ...QUICK_WORKSPACES, ...ADVANCED_WORKSPACES];

export function workspaceByPath(pathname: string): WorkspaceDef {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return ADVANCED_WORKSPACES.find((item) => item.id === "supply")!;
  }
  const projectWorkspace = /^\/projects\/[^/]+\/([^/]+)/.exec(pathname)?.[1];
  const projectlessWorkspace = /^\/([^/]+)\/?$/.exec(pathname)?.[1];
  return (
    ALL_WORKSPACES.find(
      (item) => item.id === (projectWorkspace ?? projectlessWorkspace),
    ) ??
    WORKSPACES[0]!
  );
}

export function projectIdFromPath(pathname: string): string | null {
  const value = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  return value ? decodeURIComponent(value) : null;
}

export function workspacePath(item: WorkspaceDef, projectId: string | null): string {
  if (!item.projectScoped) return item.path;
  if (!projectId) return `/${item.id}`;
  return item.path.replace(":projectId", encodeURIComponent(projectId));
}
