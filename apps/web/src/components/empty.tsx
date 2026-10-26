import type { ReactNode } from "react";

import { LaudaMark } from "./lauda-mark";

/* Shared empty state: the decorative "L." mark + a serif title + description + optional action. */

interface EmptyProps {
  title: string;
  description?: string;
  action?: ReactNode;
  titleAs?: "h1" | "h2";
  markVariant?: "empty" | "hero";
}

export function Empty({
  title,
  description,
  action,
  titleAs: Title = "h2",
  markVariant = "empty",
}: EmptyProps) {
  return (
    <div className="empty">
      <LaudaMark variant={markVariant} />
      <Title className="empty__title">{title}</Title>
      {description ? <p className="empty__description">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}
