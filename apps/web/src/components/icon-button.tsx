import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

/* Square icon button with a thin outline: uniform 32px touch area, a hairline
   appears on hover. */

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
}

export function IconButton({
  icon: Icon,
  label,
  pressed,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      {...rest}
    >
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}
