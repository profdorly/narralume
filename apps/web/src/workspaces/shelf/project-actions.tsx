import {
  Archive,
  ArchiveRestore,
  Copy,
  Ellipsis,
  PenLine,
  Radar,
  Trash2,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { IconButton } from "../../components/icon-button";
import { useI18n } from "../../i18n";
import type { Project } from "../../lib/api";

export function ProjectActions({
  project,
  className,
  open,
  onToggle,
  onClose,
  onAutopilot,
  onEdit,
  onDuplicate,
  onArchive,
  onDelete,
}: {
  project: Project;
  className: "shelf-book" | "shelf-row";
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAutopilot: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open)
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus();
  }, [open]);

  const closeAndRestoreFocus = () => {
    onClose();
    rootRef.current
      ?.querySelector<HTMLButtonElement>(`.${className}__menu-btn`)
      ?.focus();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        [],
    );
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (
      !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
      items.length === 0
    )
      return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <span
      ref={rootRef}
      className={`${className}__menu`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <IconButton
        icon={Ellipsis}
        label={t("shelf.book.moreActions", { name: project.title })}
        className={`${className}__menu-btn`}
        aria-expanded={open}
        onClick={onToggle}
      />
      {open ? (
        <>
          <div className="shelf-menu-backdrop" onMouseDown={onClose} />
          <div
            ref={menuRef}
            className="shelf-menu"
            role="menu"
            data-lenis-prevent
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              className="shelf-menu__item"
              onClick={() => {
                onClose();
                onAutopilot();
              }}
            >
              <Radar size={13} strokeWidth={1.5} aria-hidden="true" />{" "}
              {t("shelf.menu.autopilot")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="shelf-menu__item"
              onClick={() => {
                onClose();
                onEdit();
              }}
            >
              <PenLine size={13} strokeWidth={1.5} aria-hidden="true" />{" "}
              {t("shelf.menu.edit")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="shelf-menu__item"
              onClick={() => {
                onClose();
                onDuplicate();
              }}
            >
              <Copy size={13} strokeWidth={1.5} aria-hidden="true" />{" "}
              {t("common.action.copy")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="shelf-menu__item"
              onClick={() => {
                onClose();
                onArchive();
              }}
            >
              {project.archivedAt ? (
                <ArchiveRestore size={13} strokeWidth={1.5} aria-hidden="true" />
              ) : (
                <Archive size={13} strokeWidth={1.5} aria-hidden="true" />
              )}
              {project.archivedAt
                ? t("shelf.menu.restore")
                : t("shelf.menu.archive")}
            </button>
            <div className="shelf-menu__divider" />
            <button
              type="button"
              role="menuitem"
              className="shelf-menu__item shelf-menu__item--danger"
              onClick={() => {
                onClose();
                onDelete();
              }}
            >
              <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />{" "}
              {t("shelf.menu.recycle")}
            </button>
          </div>
        </>
      ) : null}
    </span>
  );
}
