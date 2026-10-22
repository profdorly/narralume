import { type ReactNode } from "react";

import { useFocusTrap } from "../../app/focus-trap";

interface ShelfDialogProps {
  eyebrow: string;
  title: string;
  note?: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

export function ShelfDialog({
  eyebrow,
  title,
  note,
  className,
  onClose,
  children,
}: ShelfDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(onClose);
  return (
    <div
      className="shelf-dialog-backdrop"
      data-lenis-prevent
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className={`shelf-dialog${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-lenis-prevent
      >
        <p className="shelf-dialog__eyebrow mono">{eyebrow}</p>
        <h2 className="shelf-dialog__title">{title}</h2>
        {note ? <p className="shelf-dialog__note">{note}</p> : null}
        {children}
      </div>
    </div>
  );
}
