import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { ErrorNote } from "../../components/error-note";
import {
  LOCALES,
  LOCALE_LABELS,
  useI18n,
} from "../../i18n";
import {
  getHealth,
  listAssignments,
  listProviders,
  type Project,
  type ProjectLanguage,
} from "../../lib/api";
import { ShelfDialog } from "./dialog";
import {
  useCreateProjectDialog,
  type CreateBookMode,
  type ProjectForm,
} from "./use-create-project-dialog";

export function CreateBookDialog({
  mode,
  onClose,
  onCreated,
}: {
  mode: CreateBookMode;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const { t } = useI18n();
  const {
    title,
    setTitle,
    premise,
    setPremise,
    language,
    setLanguage,
    form,
    setForm,
    mutation,
    submit,
  } = useCreateProjectDialog(mode, onCreated);
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => getHealth(signal),
    enabled: mode === "ai",
  });
  const assignmentsQuery = useQuery({
    queryKey: ["assignments"],
    queryFn: ({ signal }) => listAssignments(signal),
    enabled: mode === "ai" && healthQuery.isSuccess,
  });
  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: ({ signal }) => listProviders(signal),
    enabled: mode === "ai" && healthQuery.isSuccess,
  });
  const unconfigured =
    mode === "ai" &&
    healthQuery.isSuccess &&
    assignmentsQuery.isSuccess &&
    providersQuery.isSuccess &&
    !(assignmentsQuery.data ?? []).some((entry) => entry.role === "writing") &&
    !(providersQuery.data ?? []).some((provider) => provider.enabled);

  return (
    <ShelfDialog
      eyebrow={t("shelf.ghost")}
      title={mode === "blank" ? t("shelf.create.blank") : t("shelf.create.ai")}
      note={
        mode === "blank"
          ? t("shelf.create.noteBlank")
          : t("shelf.create.noteAi")
      }
      onClose={onClose}
    >
      {unconfigured ? (
        <div className="panel stack stack--tight" role="note">
          <strong>{t("common.state.unconfigured")}</strong>
          <p>{t("settings.roles.writing.note")}</p>
          <Link className="btn btn--outline" to="/settings">
            {t("settings.title")}
          </Link>
        </div>
      ) : null}
      <form onSubmit={submit}>
        <div className="shelf-dialog__field">
          <label className="shelf-dialog__label mono" htmlFor="create-title">
            {t("shelf.create.titleLabel")}
          </label>
          <input
            id="create-title"
            className="shelf-dialog__input"
            placeholder={t("shelf.create.titlePlaceholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </div>
        <div className="shelf-dialog__field">
          <label className="shelf-dialog__label mono" htmlFor="create-language">
            {t("shelf.create.languageLabel")}
          </label>
          <select
            id="create-language"
            className="shelf-dialog__input"
            value={language}
            onChange={(event) =>
              setLanguage(event.target.value as ProjectLanguage)
            }
          >
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {LOCALE_LABELS[locale]}
              </option>
            ))}
          </select>
        </div>
        <div className="shelf-dialog__field">
          <label className="shelf-dialog__label mono" htmlFor="create-form">
            {t("shelf.create.formLabel")}
          </label>
          <select
            id="create-form"
            className="shelf-dialog__input"
            value={form}
            onChange={(event) => setForm(event.target.value as ProjectForm)}
          >
            <option value="short-story">{t("shelf.create.formShort")}</option>
            <option value="novella">{t("shelf.create.formNovella")}</option>
            <option value="novel">{t("shelf.create.formNovel")}</option>
          </select>
        </div>
        <div className="shelf-dialog__field">
          <label className="shelf-dialog__label mono" htmlFor="create-premise">
            {mode === "blank"
              ? t("shelf.create.premiseLabelBlank")
              : t("shelf.create.premiseLabelAi")}
          </label>
          {mode === "blank" ? (
            <input
              id="create-premise"
              className="shelf-dialog__input"
              placeholder={t("shelf.create.premisePlaceholderBlank")}
              value={premise}
              onChange={(event) => setPremise(event.target.value)}
            />
          ) : (
            <textarea
              id="create-premise"
              className="shelf-dialog__textarea"
              rows={4}
              placeholder={t("shelf.create.premisePlaceholderAi")}
              value={premise}
              onChange={(event) => setPremise(event.target.value)}
            />
          )}
        </div>
        {mutation.isError ? (
          <div className="shelf-dialog__error">
            <ErrorNote error={mutation.error} title={t("shelf.create.error")} />
          </div>
        ) : null}
        <div className="shelf-dialog__actions">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            {t("common.action.cancel")}
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={
              mutation.isPending ||
              !title.trim() ||
              (mode === "ai" && !premise.trim())
            }
          >
            {mutation.isPending
              ? t("shelf.create.submitting")
              : mode === "blank"
                ? t("shelf.create.submitBlank")
                : t("shelf.create.submitAi")}
          </button>
        </div>
      </form>
    </ShelfDialog>
  );
}
