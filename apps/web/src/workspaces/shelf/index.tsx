import "./shelf.css";

import {
  Archive,
  LayoutGrid,
  Plus,
  Rows3,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import Lenis from "lenis";
import { motion, useReducedMotion, type MotionStyle } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { Empty } from "../../components/empty";
import { ErrorNote } from "../../components/error-note";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../i18n";
import type { Project } from "../../lib/api";
import { coverHue, formatRelativeDate, shortId } from "../../lib/fmt";
import { projectPhaseLabel } from "../../lib/labels";
import { projectWorkspacePath } from "../../lib/project-route";
import { BookCover } from "./book-cover";
import { BookEditDialog } from "./book-edit-dialog";
import { CreateBookDialog } from "./create-book-dialog";
import { DeleteDialog } from "./delete-dialog";
import { ImportDialog } from "./import-dialog";
import { OnboardingChoices } from "./onboarding-choices";
import { ProjectActions } from "./project-actions";
import { RecycleBin } from "./recycle-bin";
import { chapterCount, useShelfProjects } from "./use-shelf-projects";
import type { CreateBookMode } from "./use-create-project-dialog";

/* ==========================================================================
   藏书室：作品编目与建书入口。本页是唯一允许挂 Lenis 平滑滚动的工作区。
   ========================================================================== */

export function ShelfWorkspace() {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { t } = useI18n();
  const lenisReady = reduceMotion !== true;
  useEffect(() => {
    if (!lenisReady) return;
    const lenis = new Lenis({ lerp: 0.11 });
    let frame = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [lenisReady]);

  const [createMode, setCreateMode] = useState<CreateBookMode | null>(null);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const {
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
    projectsQuery,
    rows,
    isEmpty,
    refresh,
    archiveMutation,
    duplicateMutation,
    uploadMutation,
  } = useShelfProjects();

  const openProject = (project: Project) => {
    setMenuFor(null);
    navigate(projectWorkspacePath(project.id, "overview"));
  };

  return (
    <div className="shelf">
      <div
        className="shelf__cta"
        role="group"
        aria-label={t("shelf.create.ariaLabel")}
      >
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => setCreateMode("blank")}
        >
          <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
          {t("shelf.create.blank")}
        </button>
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => setCreateMode("ai")}
        >
          <Sparkles size={14} strokeWidth={1.5} aria-hidden="true" />
          {t("shelf.create.ai")}
        </button>
        <button
          type="button"
          className="btn btn--outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
        >
          <Upload size={14} strokeWidth={1.5} aria-hidden="true" />
          {uploadMutation.isPending
            ? t("shelf.upload.importing")
            : t("shelf.upload.import")}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,.txt,.text,.docx,.html,.htm,.epub,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) uploadMutation.mutate(file);
            event.target.value = "";
          }}
        />
      </div>

      <header className="shelf__masthead">
        <p className="shelf__ghost" aria-hidden="true">
          {t("shelf.ghost")}
        </p>
        <h1 className="shelf__title">{t("shelf.title")}</h1>
        <p className="shelf__kicker mono">01 · Estante</p>
      </header>

      <div className="shelf__toolbar">
        <label className="shelf__search">
          <Search size={14} strokeWidth={1.5} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("shelf.toolbar.searchLabel")}
            placeholder={t("shelf.toolbar.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="shelf__archive-toggle"
          aria-pressed={includeArchived}
          onClick={() => setIncludeArchived((value) => !value)}
        >
          <Archive size={13} strokeWidth={1.5} aria-hidden="true" />
          {t("shelf.toolbar.includeArchived")}
        </button>
        <button
          type="button"
          className="shelf__archive-toggle"
          onClick={() => setRecycleOpen(true)}
        >
          <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
          {t("shelf.recycle.title")}
        </button>
        <div
          className="shelf__view-switch"
          role="group"
          aria-label={t("shelf.toolbar.viewLabel")}
        >
          <button
            type="button"
            aria-pressed={view === "covers"}
            onClick={() => selectView("covers")}
          >
            <LayoutGrid size={13} strokeWidth={1.5} aria-hidden="true" />
            {t("shelf.toolbar.viewCovers")}
          </button>
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => selectView("list")}
          >
            <Rows3 size={13} strokeWidth={1.5} aria-hidden="true" />
            {t("shelf.toolbar.viewList")}
          </button>
        </div>
      </div>

      {actionError !== null ? (
        <div style={{ marginTop: "1rem" }}>
          <ErrorNote error={actionError} title={t("shelf.error.action")} />
        </div>
      ) : null}

      {projectsQuery.isPending ? (
        <div className="shelf__catalog" aria-busy="true">
          <Skeleton lines={5} />
        </div>
      ) : projectsQuery.isError ? (
        <div style={{ marginTop: "2rem" }}>
          <ErrorNote
            error={projectsQuery.error}
            title={t("shelf.error.load")}
          />
        </div>
      ) : isEmpty ? (
        <OnboardingChoices
          onIdea={() => setCreateMode("ai")}
          onManuscript={() => fileInputRef.current?.click()}
          onBlank={() => setCreateMode("blank")}
        />
      ) : rows.length === 0 ? (
        <div className="shelf__catalog">
          <Empty
            title={t("shelf.noMatch.title")}
            description={t("shelf.noMatch.description")}
          />
        </div>
      ) : (
        <div className="shelf__catalog">
          <div className="shelf__catalog-head">
            <span className="mono">
              {t("shelf.catalog.worksCount", { count: rows.length })}
            </span>
            <span className="shelf__catalog-rule" aria-hidden="true" />
            <span className="mono">
              {t("shelf.catalog.latestUpdate", {
                date: formatRelativeDate(rows[0]!.updatedAt),
              })}
            </span>
          </div>
          {view === "covers" ? (
            <div className="shelf__bookshelf">
              {rows.map((project) => (
                <motion.article
                  key={project.id}
                  className="shelf-book"
                  data-archived={project.archivedAt ? "true" : "false"}
                  data-menu-open={menuFor === project.id ? "true" : "false"}
                  {...(reduceMotion
                    ? {}
                    : {
                        whileHover: "shelf-book-hover",
                        variants: { "shelf-book-hover": { y: -5 } },
                        transition: {
                          type: "spring",
                          stiffness: 360,
                          damping: 28,
                        },
                      })}
                  style={
                    {
                      "--book-hue": coverHue(project.id),
                    } as unknown as MotionStyle
                  }
                >
                  <button
                    type="button"
                    className="shelf-book__open"
                    aria-label={t("shelf.book.open", { name: project.title })}
                    onClick={() => openProject(project)}
                  />
                  <div className="shelf-book__cover-wrap">
                    <BookCover project={project} />
                  </div>
                  <div className="shelf-book__info">
                    <div className="shelf-book__title-row">
                      <h2 className="shelf-book__title">{project.title}</h2>
                      {project.archivedAt ? (
                        <span className="shelf-book__archived-tag mono">
                          {t("shelf.book.archived")}
                        </span>
                      ) : null}
                    </div>
                    <p className="shelf-book__subtitle">
                      {project.subtitle ?? projectPhaseLabel(project.phase)}
                    </p>
                    <p
                      className="shelf-book__premise"
                      data-empty={project.premise ? "false" : "true"}
                    >
                      {project.premise ?? t("shelf.book.noPremise")}
                    </p>
                    <div className="shelf-book__meta mono">
                      <span>
                        {t("shelf.book.chapters", {
                          count: chapterCount(project),
                        })}
                      </span>
                      <span>
                        {t("common.state.characters", {
                          count: project.wordCount ?? 0,
                        })}
                      </span>
                      <span>{formatRelativeDate(project.updatedAt)}</span>
                    </div>
                  </div>
                  <ProjectActions
                    project={project}
                    className="shelf-book"
                    open={menuFor === project.id}
                    onToggle={() =>
                      setMenuFor((value) =>
                        value === project.id ? null : project.id,
                      )
                    }
                    onClose={() => setMenuFor(null)}
                    onAutopilot={() =>
                      navigate(projectWorkspacePath(project.id, "autopilot"))
                    }
                    onEdit={() => setEditTarget(project)}
                    onDuplicate={() => duplicateMutation.mutate(project)}
                    onArchive={() => archiveMutation.mutate(project)}
                    onDelete={() => setDeleteTarget(project)}
                  />
                </motion.article>
              ))}
            </div>
          ) : (
            <div className="shelf__list">
              <div className="shelf-list__head" aria-hidden="true">
                <span className="mono">{t("shelf.catalog.headNo")}</span>
                <span className="mono">{t("shelf.catalog.headTitle")}</span>
                <span className="mono">{t("shelf.catalog.headMeta")}</span>
                <span />
                <span />
              </div>
              {rows.map((project, index) => (
                <motion.article
                  key={project.id}
                  className="shelf-row"
                  data-archived={project.archivedAt ? "true" : "false"}
                  data-menu-open={menuFor === project.id ? "true" : "false"}
                  {...(reduceMotion
                    ? {}
                    : {
                        whileHover: "shelf-row-hover",
                        variants: { "shelf-row-hover": { x: 4 } },
                        transition: {
                          type: "spring",
                          stiffness: 420,
                          damping: 30,
                        },
                      })}
                  style={{ transformStyle: "preserve-3d" }}
                >
                  <button
                    type="button"
                    className="shelf-row__open"
                    aria-label={t("shelf.book.open", { name: project.title })}
                    onClick={() => openProject(project)}
                  />
                  <span className="shelf-row__no">
                    <span className="mono">
                      NO.{String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="shelf-row__id mono">
                      {shortId(project.id)}
                    </span>
                  </span>
                  <span className="shelf-row__body">
                    <span className="shelf-row__title">{project.title}</span>
                    <span
                      className="shelf-row__premise"
                      data-empty={project.premise ? "false" : "true"}
                    >
                      {project.premise ?? t("shelf.book.noPremiseRow")}
                    </span>
                  </span>
                  <span className="shelf-row__meta mono">
                    {project.archivedAt ? (
                      <span className="shelf-row__archived-tag mono">
                        {t("shelf.book.archived")}
                      </span>
                    ) : null}
                    <span>
                      {t("shelf.book.chapters", {
                        count: chapterCount(project),
                      })}
                    </span>
                    <span className="shelf-row__phase">
                      {projectPhaseLabel(project.phase)}
                    </span>
                    <span>{formatRelativeDate(project.updatedAt)}</span>
                  </span>
                  <ProjectActions
                    project={project}
                    className="shelf-row"
                    open={menuFor === project.id}
                    onToggle={() =>
                      setMenuFor((value) =>
                        value === project.id ? null : project.id,
                      )
                    }
                    onClose={() => setMenuFor(null)}
                    onAutopilot={() =>
                      navigate(projectWorkspacePath(project.id, "autopilot"))
                    }
                    onEdit={() => setEditTarget(project)}
                    onDuplicate={() => duplicateMutation.mutate(project)}
                    onArchive={() => archiveMutation.mutate(project)}
                    onDelete={() => setDeleteTarget(project)}
                  />
                  <motion.span
                    className="shelf-spine"
                    aria-hidden="true"
                    style={
                      {
                        "--spine-hue": coverHue(project.id),
                      } as MotionStyle
                    }
                    {...(reduceMotion
                      ? {}
                      : {
                          variants: {
                            "shelf-row-hover": {
                              y: -2,
                              rotateY: 8,
                              rotate: -2,
                              transformPerspective: 180,
                            },
                          },
                          transition: {
                            type: "spring",
                            stiffness: 420,
                            damping: 24,
                          },
                        })}
                    initial={{ rotate: -2 }}
                  >
                    <span className="shelf-spine__cap" />
                    <span className="shelf-spine__band" />
                    <span className="shelf-spine__cloth">
                      <span className="shelf-spine__emboss" />
                      <span className="shelf-spine__emboss shelf-spine__emboss--second" />
                    </span>
                  </motion.span>
                </motion.article>
              ))}
            </div>
          )}
        </div>
      )}

      {createMode ? (
        <CreateBookDialog
          mode={createMode}
          onClose={() => setCreateMode(null)}
          onCreated={(project) => {
            setCreateMode(null);
            void refresh();
            navigate(projectWorkspacePath(project.id, "overview"));
          }}
        />
      ) : null}
      {editTarget ? (
        <BookEditDialog
          project={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            void refresh();
          }}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteDialog
          project={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            void refresh();
          }}
        />
      ) : null}
      {recycleOpen ? (
        <RecycleBin
          onClose={() => setRecycleOpen(false)}
          onChanged={() => void refresh()}
        />
      ) : null}
      {importBatch ? (
        <ImportDialog
          detail={importBatch}
          onClose={() => setImportBatch(null)}
          onApplied={() => void refresh()}
          onOpen={(path) => {
            setImportBatch(null);
            navigate(path);
          }}
        />
      ) : null}
    </div>
  );
}
