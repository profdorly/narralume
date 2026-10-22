import { Plus } from "lucide-react";

import { useI18n } from "../../i18n";

export function OnboardingChoices({
  onIdea,
  onManuscript,
  onBlank,
}: {
  onIdea: () => void;
  onManuscript: () => void;
  onBlank: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="shelf__empty empty-hero">
      <p className="shelf__empty-line">{t("shelf.empty.title")}</p>
      <p className="shelf__empty-sub">{t("shelf.empty.sub")}</p>
      <div className="choice-grid">
        <button type="button" className="choice-card" onClick={onIdea}>
          <strong>{t("shelf.empty.ideaTitle")}</strong>
          <span>{t("shelf.empty.ideaBody")}</span>
        </button>
        <button type="button" className="choice-card" onClick={onManuscript}>
          <strong>{t("shelf.empty.manuscriptTitle")}</strong>
          <span>{t("shelf.empty.manuscriptBody")}</span>
        </button>
      </div>
      <button type="button" className="btn" onClick={onBlank}>
        <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
        {t("shelf.empty.cta")}
      </button>
    </div>
  );
}
