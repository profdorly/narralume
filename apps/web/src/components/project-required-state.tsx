import { LibraryBig } from "lucide-react";
import { Link } from "react-router";

import { useI18n } from "../i18n";

import { Empty } from "./empty";

interface ProjectRequiredStateProps {
  title: string;
  description: string;
}

/**
 * Shared "no work selected" state for project-level pages; empty states inside
 * a page still use Empty.
 */
export function ProjectRequiredState({
  title,
  description,
}: ProjectRequiredStateProps) {
  const { t } = useI18n();
  return (
    <main className="project-required">
      <Empty
        markVariant="hero"
        title={title}
        titleAs="h1"
        description={description}
        action={
          <Link className="btn btn--primary project-required__back" to="/shelf">
            <LibraryBig size={14} strokeWidth={1.5} aria-hidden="true" />
            {t("components.projectRequired.backToShelf")}
          </Link>
        }
      />
    </main>
  );
}
