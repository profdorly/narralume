import {
  MARK_DOT,
  MARK_L_PATH,
  MARK_VIEWBOX,
  WORDMARK_PATH,
  WORDMARK_VIEWBOX,
} from "./lapis-logo-paths";

export const BRAND_NAME = "Lapis";

interface LapisMarkProps {
  variant: "rail" | "empty" | "hero" | "cover";
  /** Accessible name; without it the mark is decorative. */
  label?: string;
  /** Draw the full stop in the ink color (default covers). */
  mono?: boolean;
}

/** The "L." mark: the same drawing in the rail, empty states, heroes and covers; only the size changes. */
export function LapisMark({ variant, label, mono }: LapisMarkProps) {
  const a11y = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": true as const };
  return (
    <svg
      className={`lapis-mark lapis-mark--${variant}`}
      viewBox={MARK_VIEWBOX}
      focusable="false"
      {...a11y}
    >
      <path d={MARK_L_PATH} fill="currentColor" />
      <circle
        cx={MARK_DOT.cx}
        cy={MARK_DOT.cy}
        r={MARK_DOT.r}
        className={mono ? undefined : "lapis-mark__dot"}
        fill="currentColor"
      />
    </svg>
  );
}

/** The outlined "lapis" wordmark (Alegreya 500); decorative, next to a labelled mark. */
export function LapisWordmark() {
  return (
    <svg
      className="lapis-wordmark"
      viewBox={WORDMARK_VIEWBOX}
      focusable="false"
      aria-hidden="true"
    >
      <path d={WORDMARK_PATH} fill="currentColor" />
    </svg>
  );
}
