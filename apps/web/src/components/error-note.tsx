import { apiErrorHint, apiErrorMessage } from "../lib/api";
import { useI18n } from "../i18n";

/* Error note: the ApiError code hint takes precedence, falling back to the
   backend message. */

interface ErrorNoteProps {
  error: unknown;
  title?: string;
}

export function ErrorNote({ error, title }: ErrorNoteProps) {
  const { t } = useI18n();
  const hint = apiErrorHint(error);
  const message = apiErrorMessage(error);
  return (
    <div className="error-note" role="alert">
      <p className="error-note__title">
        {title ?? t("components.errorNote.defaultTitle")}
      </p>
      <p className="error-note__message">{message}</p>
      {hint && hint !== message ? (
        <p className="error-note__hint">{hint}</p>
      ) : null}
    </div>
  );
}
