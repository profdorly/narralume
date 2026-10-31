import type { ReactNode } from "react";

/* Page header band: mono tag on the left, serif title in the center, notes on
   the right. Every workspace header uses this component (except the library,
   with its vertical giant title) to keep alignment. */

interface PageBandProps {
  /** Tag, e.g. "VOYAGE · 06" */
  index: string;
  /** Workspace name, e.g. "Autopilot" */
  title: string;
  /** Right-side notes area: stats, status, mode toggles, etc. */
  meta?: ReactNode;
}

export function PageBand({ index, title, meta }: PageBandProps) {
  return (
    <header className="page-band">
      <span className="page-band__index mono" aria-hidden="true">
        {index}
      </span>
      <p className="page-band__title">{title}</p>
      <div className="page-band__meta">{meta}</div>
    </header>
  );
}
