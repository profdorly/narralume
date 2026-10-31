import "./shell.css";

import { useQuery } from "@tanstack/react-query";
import {
  Command,
  Languages,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router";

import { ChunkBoundary } from "../components/chunk-boundary";
import { IconButton } from "../components/icon-button";
import { BRAND_NAME, LapisMark, LapisWordmark } from "../components/lapis-mark";
import { getLocale, translate, useI18n, type MessageKey } from "../i18n";
import { getAssistantConversations, getHealth } from "../lib/api";
import {
  subscribeAssistantContext,
  type AssistantContextPatch,
} from "./assistant-page-context";
import { AssistantTrigger } from "./assistant-trigger";
import { useTheme } from "./theme";
import {
  ADVANCED_WORKSPACES,
  projectIdFromPath,
  QUICK_WORKSPACES,
  WORKSPACES,
  workspaceByPath,
  workspacePath,
  type WorkspaceDef,
} from "./workspaces";

/* App shell: left rail (collapsible) + routed main area + ⌘K command palette.
   Main navigation is reduced to shelf / project overview / story / writing /
   delivery; the other workspaces hang under an "Advanced tools" group in the
   rail, and quick jumps all go through the command palette (the full-screen
   menu is retired). */

const RAIL_COLLAPSED_KEY = "lapis:rail-collapsed";
const AUTO_COLLAPSE_QUERY = "(max-width: 1100px)";
const ASSISTANT_OPEN_KEY = "lapis:assistant-open";
const REPOSITORY_URL = "https://github.com/profdorly/narralume";

function GitHubMark({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.63 5.47 7.7.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.5-2.23.49-2.69-.55-2.69-.55-.36-.94-.89-1.19-.89-1.19-.73-.5.05-.49.05-.49.8.06 1.22.83 1.22.83.71 1.23 1.87.87 2.33.67.07-.52.28-.87.51-1.07-1.78-.21-3.64-.9-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.5 7.5 0 018 3.42a7.5 7.5 0 012 .28c1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.13-1.87 3.81-3.65 4.01.29.25.54.75.54 1.51 0 1.09-.01 1.97-.01 2.24 0 .22.15.47.55.39A8.02 8.02 0 0016 8.13C16 3.64 12.42 0 8 0Z" />
    </svg>
  );
}

const ShelfWorkspace = lazy(() => import("../workspaces/shelf").then((module) => ({ default: module.ShelfWorkspace })));
const OverviewWorkspace = lazy(() => import("../workspaces/overview").then((module) => ({ default: module.OverviewWorkspace })));
const BibleWorkspace = lazy(() => import("../workspaces/bible").then((module) => ({ default: module.BibleWorkspace })));
const StudioWorkspace = lazy(() => import("../workspaces/studio").then((module) => ({ default: module.StudioWorkspace })));
const DeliveryWorkspace = lazy(() => import("../workspaces/delivery").then((module) => ({ default: module.DeliveryWorkspace })));
const AutopilotWorkspace = lazy(() => import("../workspaces/autopilot").then((module) => ({ default: module.AutopilotWorkspace })));
const RunsWorkspace = lazy(() => import("../workspaces/runs").then((module) => ({ default: module.RunsWorkspace })));
const LabWorkspace = lazy(() => import("../workspaces/lab").then((module) => ({ default: module.LabWorkspace })));
const SettingsWorkspace = lazy(() => import("../workspaces/settings").then((module) => ({ default: module.SettingsWorkspace })));

/* Not needed for the first paint: the palette loads on its first open, the assistant
   panel (with its CSS) on its first open or when it was left open last time. */
const CommandPalette = lazy(() => import("./command-palette").then((module) => ({ default: module.CommandPalette })));
const ProjectAssistant = lazy(() => import("./assistant").then((module) => ({ default: module.ProjectAssistant })));

/** Reloads the page once rendered; used when an updated app's chunk is gone. */
function ReloadOnMount() {
  useEffect(() => {
    window.location.reload();
  }, []);
  return null;
}

/* The rail's collapsed state has two sources: the wide-screen memory
   (localStorage) and automatic collapse on narrow screens (≤1100px). A manual
   collapse / expand on a narrow screen is a session-level override and is not
   remembered; returning to a wide screen restores the remembered state. */
function useRailCollapsed(): [boolean, () => void] {
  const [preference, setPreference] = useState(() => {
    try {
      return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [autoCollapse, setAutoCollapse] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(AUTO_COLLAPSE_QUERY).matches,
  );
  const [override, setOverride] = useState<boolean | null>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(AUTO_COLLAPSE_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      setAutoCollapse(event.matches);
      setOverride(null);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const collapsed = autoCollapse ? (override ?? true) : preference;

  const toggle = () => {
    if (autoCollapse) {
      setOverride(!collapsed);
      return;
    }
    const next = !preference;
    setPreference(next);
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* In private browsing, give up persistence */
    }
  };

  return [collapsed, toggle];
}

export function AppShell() {
  return (
    <BrowserRouter>
      <ShellFrame />
    </BrowserRouter>
  );
}

function StatusPill() {
  const { t } = useI18n();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => getHealth(signal),
    refetchInterval: 30_000,
  });
  const state = health.isPending
    ? "pending"
    : health.isError
      ? "false"
      : "true";
  const label = health.isPending
    ? t("shell.status.connecting")
    : health.isError
      ? t("shell.status.offline")
      : t("shell.status.online");
  return (
    <p
      className="status-pill"
      data-online={state}
      aria-live="polite"
      title={label}
    >
      <span className="status-pill__dot" aria-hidden="true" />
      <span className="status-pill__label">{label}</span>
    </p>
  );
}

export function RepositoryLink() {
  const { t } = useI18n();
  return (
    <a
      className="icon-button"
      href={REPOSITORY_URL}
      target="_blank"
      rel="noreferrer"
      aria-label={t("shell.repository.viewSource")}
      title={t("shell.repository.viewSource")}
    >
      <GitHubMark />
    </a>
  );
}

function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();
  const next = locale === "pt-BR" ? "en" : "pt-BR";
  return (
    <IconButton
      icon={Languages}
      label={t("shell.language.switch")}
      onClick={() => setLocale(next)}
    />
  );
}

export function NaviLink(item: WorkspaceDef, projectId: string | null, current: WorkspaceDef, currentPath: string) {
  const locale = getLocale();
  const itemLabel = translate(locale, item.label);
  const Icon = item.icon;
  const href = item.id === "supply" && projectId
    ? current.id === "supply" ? currentPath : settingsPath(projectId, currentPath)
    : workspacePath(item, projectId);
  return (
    <Link
      key={item.id}
      to={href}
      className="rail__item"
      data-tooltip={itemLabel}
      aria-label={translate(locale, "shell.nav.goTo", { label: itemLabel })}
      {...(current.id === item.id ? { "aria-current": "page" } : {})}
    >
      <span className="rail__item-icon">
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <span className="rail__item-label">{itemLabel}</span>
      <span className="rail__item-index mono">{item.index}</span>
    </Link>
  );
}

function ShellFrame() {
  const { t } = useI18n();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [railCollapsed, toggleRail] = useRailCollapsed();
  const { preference: themePreference, theme, toggleTheme } = useTheme();
  const location = useLocation();
  const current = workspaceByPath(location.pathname);
  const projectId = projectIdFromPath(location.pathname) ?? (
    current.id === "supply" ? new URLSearchParams(location.search).get("project") : null
  );
  const currentPath = `${location.pathname}${location.search}`;
  const mobileLayout =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 760px)").matches;
  const [assistantState, setAssistantState] = useState(() => ({
    open:
      !mobileLayout &&
      (() => {
        try {
          return window.localStorage.getItem(ASSISTANT_OPEN_KEY) === "1";
        } catch {
          return false;
        }
      })(),
    route: currentPath,
  }));
  const assistantOpen =
    assistantState.open && (!mobileLayout || assistantState.route === currentPath);
  // Latches on the first open: from then on ProjectAssistant renders the launcher
  // itself (with the live activity count) and stays loaded when closed. A
  // project that already has an assistant conversation loads it right away
  // (still closed), so the launcher shows its running tasks; a project that
  // never used the assistant has none to count. The list query shares its key
  // with ProjectAssistant, so it is fetched once.
  const assistantConversations = useQuery({
    queryKey: ["assistant", projectId, "conversations"],
    queryFn: ({ signal }) => getAssistantConversations(projectId!, signal),
    enabled: Boolean(projectId),
  });
  const [assistantLoaded, setAssistantLoaded] = useState(false);
  if (
    !assistantLoaded &&
    (assistantOpen || (assistantConversations.data?.length ?? 0) > 0)
  )
    setAssistantLoaded(true);
  const assistantScope = assistantContextScope(
    location.pathname,
    location.search,
  );
  const [pageAssistantContext, setPageAssistantContext] = useState<{
    scope: string;
    patch: AssistantContextPatch;
  }>({ scope: "", patch: {} });
  const routeContext = routeAssistantContext(
    location.pathname,
    location.search,
  );
  const assistantPatch =
    pageAssistantContext.scope === assistantScope
      ? { ...routeContext, ...pageAssistantContext.patch }
      : routeContext;
  const assistantContext = {
    surface: current.id,
    documentId: assistantPatch.documentId ?? null,
    outlineNodeId: assistantPatch.outlineNodeId ?? null,
    canonSpread: assistantPatch.canonSpread ?? null,
    selection: assistantPatch.selection ?? null,
  };

  useEffect(
    () =>
      subscribeAssistantContext((patch) =>
        setPageAssistantContext((current) => ({
          scope: assistantScope,
          patch:
            current.scope === assistantScope
              ? { ...current.patch, ...patch }
              : patch,
        })),
      ),
    [assistantScope],
  );

  const setProjectAssistantOpen = useCallback(
    (open: boolean) => {
      setAssistantState({ open, route: currentPath });
      try {
        window.localStorage.setItem(ASSISTANT_OPEN_KEY, open ? "1" : "0");
      } catch {
        /* In private browsing, keep only the current session state */
      }
    },
    [currentPath],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        if (projectId) setProjectAssistantOpen(!assistantOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [assistantOpen, projectId, setProjectAssistantOpen]);

  return (
    <div
      className="shell"
      data-rail-collapsed={railCollapsed ? "true" : "false"}
      data-assistant-open={
        projectId && assistantOpen ? "true" : "false"
      }
    >
      <aside className="rail">
        <div className="rail__brand">
          <LapisMark variant="rail" label={BRAND_NAME} />
          <div className="rail__brand-text">
            <LapisWordmark />
            <span className="rail__brand-tagline">{t("shell.brand.tagline")}</span>
          </div>
        </div>
        <nav className="rail__nav" aria-label={t("shell.nav.aria")}>
          {WORKSPACES.map((item) => NaviLink(item, projectId, current, currentPath))}
        </nav>
        <div className="rail__quick-nav" aria-label={t("shell.groups.quick")}>
          <p className="rail__group-label">{t("shell.groups.quick")}</p>
          {QUICK_WORKSPACES.map((item) => NaviLink(item, projectId, current, currentPath))}
        </div>
        <details className="rail__tools-nav" aria-label={t("shell.groups.advanced")}>
          <summary className="rail__group-label">{t("shell.groups.advanced")}</summary>
          {ADVANCED_WORKSPACES.filter((item) => item.id !== "supply").map((item) =>
            NaviLink(item, projectId, current, currentPath),
          )}
        </details>
        <div className="rail__tools">
          {NaviLink(
            ADVANCED_WORKSPACES.find((item) => item.id === "supply")!,
            projectId,
            current,
            currentPath,
          )}
          <StatusPill />
          <div className="rail__tools-row">
            <RepositoryLink />
            <LanguageToggle />
            <IconButton
              icon={theme === "light" ? Moon : Sun}
              label={t(themeButtonLabel(theme, themePreference))}
              pressed={themePreference !== "system"}
              onClick={toggleTheme}
            />
            <IconButton
              icon={Command}
              label={t("shell.palette.button")}
              onClick={() => setPaletteOpen(true)}
            />
          </div>
        </div>
        <div className="rail__collapse">
          <IconButton
            icon={railCollapsed ? PanelLeftOpen : PanelLeftClose}
            label={railCollapsed ? t("shell.rail.expand") : t("shell.rail.collapse")}
            onClick={toggleRail}
          />
        </div>
      </aside>
      <div className="shell__topbar">
        <StatusPill />
        <RepositoryLink />
        <LanguageToggle />
        <IconButton
          icon={theme === "light" ? Moon : Sun}
          label={t(themeButtonLabel(theme, themePreference))}
          pressed={themePreference !== "system"}
          onClick={toggleTheme}
        />
        <IconButton
          icon={Command}
          label={t("shell.palette.button")}
          onClick={() => setPaletteOpen(true)}
        />
      </div>
      <main className="shell__main">
        <Suspense fallback={<div className="shell__loading" role="status">{t("shell.loading.workspace")}</div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/shelf" replace />} />
            <Route path="/shelf" element={<ShelfWorkspace />} />
            <Route path="/overview" element={<OverviewWorkspace />} />
            <Route path="/projects/:projectId/overview" element={<OverviewWorkspace />} />
            <Route path="/bible" element={<BibleWorkspace />} />
            <Route path="/projects/:projectId/bible" element={<BibleWorkspace />} />
            <Route path="/studio" element={<StudioWorkspace />} />
            <Route path="/projects/:projectId/studio" element={<StudioWorkspace />} />
            <Route path="/lab" element={<LabWorkspace />} />
            <Route path="/projects/:projectId/lab" element={<LabWorkspace />} />
            <Route path="/autopilot" element={<AutopilotWorkspace />} />
            <Route path="/projects/:projectId/autopilot" element={<AutopilotWorkspace />} />
            <Route path="/runs" element={<RunsWorkspace />} />
            <Route path="/projects/:projectId/runs" element={<RunsWorkspace />} />
            <Route path="/settings" element={<SettingsWorkspace />} />
            <Route path="/delivery" element={<DeliveryWorkspace />} />
            <Route path="/projects/:projectId/delivery" element={<DeliveryWorkspace />} />
            <Route path="*" element={<Navigate to="/shelf" replace />} />
          </Routes>
        </Suspense>
      </main>
      {paletteOpen ? (
        <ChunkBoundary
          // The palette's file is gone (the app was updated): reload to get it.
          fallback={<ReloadOnMount />}
        >
          <Suspense fallback={null}>
            <CommandPalette
              projectId={projectId}
              onClose={() => setPaletteOpen(false)}
            />
          </Suspense>
        </ChunkBoundary>
      ) : null}
      {projectId ? (
        assistantLoaded ? (
          <ChunkBoundary
            // The app was probably updated while this tab stayed open: a
            // reload fetches the current files.
            fallback={<AssistantTrigger onOpen={() => window.location.reload()} />}
          >
            <Suspense
              // Keep the launcher on screen while the assistant chunk loads.
              fallback={
                assistantOpen ? null : (
                  <AssistantTrigger onOpen={() => setProjectAssistantOpen(true)} />
                )
              }
            >
              <ProjectAssistant
                key={projectId}
                projectId={projectId}
                context={assistantContext}
                open={assistantOpen}
                onOpen={() => setProjectAssistantOpen(true)}
                onClose={() => setProjectAssistantOpen(false)}
              />
            </Suspense>
          </ChunkBoundary>
        ) : (
          <AssistantTrigger onOpen={() => setProjectAssistantOpen(true)} />
        )
      ) : null}
    </div>
  );
}

function themeButtonLabel(
  theme: "light" | "dark",
  preference: "system" | "light" | "dark",
): MessageKey {
  if (preference !== "system") return "shell.theme.followSystem";
  return theme === "light" ? "shell.theme.toDark" : "shell.theme.toLight";
}

function routeAssistantContext(
  pathname: string,
  search: string,
): AssistantContextPatch {
  const params = new URLSearchParams(search);
  const context: AssistantContextPatch = {};
  if (pathname.endsWith("/studio")) {
    context.documentId = params.get("document");
    context.outlineNodeId = params.get("outline");
  }
  if (pathname.endsWith("/bible")) {
    const spread = params.get("spread");
    context.canonSpread = isCanonSpread(spread) ? spread : "intent";
  }
  return context;
}

function assistantContextScope(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  return [
    pathname,
    params.get("document") ?? "",
    params.get("outline") ?? "",
    params.get("spread") ?? "",
  ].join("|");
}

function isCanonSpread(
  value: string | null,
): value is NonNullable<AssistantContextPatch["canonSpread"]> {
  return [
    "intent",
    "outline",
    "entities",
    "facts",
    "relations",
    "timeline",
    "foreshadows",
  ].includes(value ?? "");
}

function settingsPath(projectId: string, returnTo: string): string {
  const params = new URLSearchParams({ project: projectId, return: returnTo });
  return `/settings?${params.toString()}`;
}
