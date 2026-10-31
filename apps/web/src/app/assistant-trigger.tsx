import "./assistant-trigger.css";

import { MessageSquareText } from "lucide-react";
import type { Ref } from "react";

import { useI18n } from "../i18n";

/* The closed-state launcher for the project assistant. The shell renders it on its
   own until the assistant chunk is loaded; after that ProjectAssistant renders it
   with the live activity count. */
export function AssistantTrigger({
  onOpen,
  count = 0,
  buttonRef,
}: {
  onOpen: () => void;
  count?: number;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useI18n();
  return (
    <button
      ref={buttonRef}
      type="button"
      className="assistant-trigger"
      onClick={onOpen}
      aria-label={t("assistant.trigger.open")}
      title={t("assistant.trigger.title")}
    >
      <MessageSquareText size={17} strokeWidth={1.5} aria-hidden="true" />
      <span>{t("assistant.trigger.label")}</span>
      {count > 0 ? (
        <span className="assistant-trigger__count mono">{count}</span>
      ) : null}
    </button>
  );
}
