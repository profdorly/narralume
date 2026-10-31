/* Number input: holds the raw string internally, does not fall back to 0 when
   cleared, and clamps and commits only on blur. Fixes the controlled number
   input problem where clearing gives 0 and typing again yields "0N". */

import { useState } from "react";
import type { InputHTMLAttributes } from "react";

interface NumberFieldProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "onChange" | "min" | "max"
  > {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max?: number;
}

interface NumberDraft {
  /** Raw text in the input; may be an empty string. */
  text: string;
  /**
   * The value already committed to the parent; the display resets only when the
   * external value differs from it.
   */
  committed: number;
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  ...rest
}: NumberFieldProps) {
  const [draft, setDraft] = useState<NumberDraft>(() => ({
    text: String(value),
    committed: value,
  }));
  /* Sync the display when the external value changes (compass loaded, session
     reset); the echo produced by user edits equals committed, so it does not
     interrupt them. */
  if (draft.committed !== value) {
    setDraft({ text: String(value), committed: value });
  }
  const clamp = (candidate: number) =>
    Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, candidate));
  return (
    <input
      type="number"
      inputMode="numeric"
      value={draft.text}
      onChange={(event) => {
        const raw = event.target.value;
        const parsed = Number(raw);
        if (raw.trim() !== "" && Number.isFinite(parsed)) {
          const next = clamp(Math.trunc(parsed));
          setDraft({ text: raw, committed: next });
          onChange(next);
        } else {
          setDraft({ text: raw, committed: draft.committed });
        }
      }}
      onBlur={() => {
        const parsed = Number(draft.text);
        const next =
          draft.text.trim() !== "" && Number.isFinite(parsed)
            ? clamp(Math.trunc(parsed))
            : draft.committed;
        if (next !== draft.committed) onChange(next);
        setDraft({ text: String(next), committed: next });
      }}
      min={min}
      {...(max === undefined ? {} : { max })}
      {...rest}
    />
  );
}
