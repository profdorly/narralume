import {
  ArrowUp,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { useI18n } from "../../i18n";
import {
  type AssistantActivityDto,
  type AssistantContext,
  type AssistantMessageDto,
} from "../../lib/api";
import { formatRelativeDate } from "../../lib/fmt";
import {
  activityGoalLabel,
  activityStageLabel,
  activitySummaryLabel,
  artifactKindLabel,
  assistantSkillLabel,
  stopReasonLabel,
} from "../../lib/labels";
import {
  activityHref,
  activityKindLabel,
  artifactHref,
  contextDetails,
  phaseLabel,
  shortId,
  surfaceLabel,
  toolCallLabel,
} from "./helpers";

export function ContextRibbon({
  context,
  usingPageContext,
  onToggleScope,
}: {
  context: AssistantContext;
  usingPageContext: boolean;
  onToggleScope: () => void;
}) {
  const { t } = useI18n();
  const details = contextDetails(context);
  return (
    <div className="assistant-context" aria-label={t("assistant.context.label")}>
      <span className="assistant-context__mark" aria-hidden="true" />
      <span>{surfaceLabel(context.surface)}</span>
      {details.map((detail) => (
        <span key={detail} className="assistant-context__detail">
          {detail}
        </span>
      ))}
      <button
        type="button"
        className="assistant-context__scope"
        title={usingPageContext ? t("assistant.context.projectOnlyTitle") : t("assistant.context.followPageTitle")}
        onClick={onToggleScope}
      >
        {usingPageContext ? t("assistant.context.projectOnly") : t("assistant.context.followPage")}
      </button>
    </div>
  );
}

export function AssistantWelcome({ onPrompt }: { onPrompt: (text: string) => void }) {
  const { t } = useI18n();
  const prompts = [
    t("assistant.welcome.promptStatus"),
    t("assistant.welcome.promptConsistency"),
    t("assistant.welcome.promptTasks"),
  ];
  return (
    <section className="assistant-welcome">
      <div className="assistant-welcome__seal" aria-hidden="true">
        <Sparkles size={19} strokeWidth={1.35} />
      </div>
      <p className="assistant-welcome__eyebrow mono">CONTEXT IN HAND</p>
      <h3>{t("assistant.welcome.title")}</h3>
      <p>
        {t("assistant.welcome.body")}
      </p>
      <div className="assistant-welcome__prompts">
        {prompts.map((prompt) => (
          <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>
            <span>{prompt}</span>
            <ArrowUp size={13} strokeWidth={1.5} aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

export function MessageEntry({ message }: { message: AssistantMessageDto }) {
  const { t } = useI18n();
  const isAssistant = message.role !== "user";
  const render = useMarkdownRenderer(isAssistant);
  return (
    <article
      className="assistant-message"
      data-role={message.role}
      aria-label={isAssistant ? t("assistant.message.assistantLabel") : t("assistant.message.authorLabel")}
    >
      <header>
        <span className="mono">
          {isAssistant ? "ASSISTANT" : "AUTHOR"}
        </span>
        <time dateTime={message.createdAt}>
          {formatRelativeDate(message.createdAt)}
        </time>
      </header>
      {isAssistant && render ? (
        <div
          className="assistant-message__body"
          dangerouslySetInnerHTML={{ __html: render(message.content) }}
        />
      ) : (
        <p>{message.content}</p>
      )}
    </article>
  );
}

type MarkdownRenderer = (content: string) => string;

let markdownRenderer: MarkdownRenderer | null = null;
let markdownLoading: Promise<MarkdownRenderer> | null = null;

/** Loads the sanitizing Markdown renderer once (marked + DOMPurify live in
 *  their own chunk). A failed load is retried on the next message. */
export function loadMarkdownRenderer(): Promise<MarkdownRenderer> {
  markdownLoading ??= import("./markdown").then(
    (module) => (markdownRenderer = module.renderMarkdown),
    (error: unknown) => {
      markdownLoading = null;
      throw error;
    },
  );
  return markdownLoading;
}

/** Until the renderer arrives, replies show as plain text (never as HTML). */
function useMarkdownRenderer(enabled: boolean): MarkdownRenderer | null {
  const [renderer, setRenderer] = useState(() => markdownRenderer);
  useEffect(() => {
    if (!enabled || renderer) return;
    let active = true;
    loadMarkdownRenderer().then(
      (loaded) => {
        if (active) setRenderer(() => loaded);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [enabled, renderer]);
  return renderer;
}

export function ActivityEntry({
  projectId,
  activity,
  pending,
  onDecision,
  onCancelTask,
  onRetryChapter,
}: {
  projectId: string;
  activity: AssistantActivityDto;
  pending: boolean;
  onDecision: (
    action: "confirm" | "reject" | "retry" | "resume" | "cancel",
  ) => void;
  onCancelTask: (() => void) | null;
  onRetryChapter: (() => void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const href = activityHref(projectId, activity);
  const proposal = activity.availableActions.includes("confirm");
  const retryable = activity.availableActions.includes("retry");
  const resumable = activity.availableActions.includes("resume");
  const cancellable = activity.availableActions.includes("cancel");
  const hasDetail =
    activity.phaseKey !== null ||
    activity.artifacts.length > 0 ||
    activity.lastError !== null ||
    activity.linkedSources.length > 0 ||
    (activity.result !== null && Object.keys(activity.result).length > 0);
  return (
    <article
      className="assistant-activity"
      data-status={activity.status}
      data-kind={activity.kind}
    >
      <div className="assistant-activity__rail" aria-hidden="true">
        <ActivityStatusIcon status={activity.status} />
      </div>
      <div className="assistant-activity__body">
        <header>
          <span className="mono">{activityKindLabel(activity.kind)}</span>
          {activity.skillId ? (
            <span className="assistant-activity__skill">
              {assistantSkillLabel(activity.skillId)}
            </span>
          ) : null}
          <time dateTime={activity.updatedAt}>
            {formatRelativeDate(activity.updatedAt)}
          </time>
        </header>
        <h3>{activityGoalLabel(activity.goal)}</h3>
        <p className="assistant-activity__stage">
          {activityStageLabel(activity.stage)}
        </p>
        {activitySummaryLabel(activity.summary) ? (
          <p className="assistant-activity__summary">
            {activitySummaryLabel(activity.summary)}
          </p>
        ) : null}
        {activity.waitingReason ? (
          <p className="assistant-activity__reason">
            <CircleAlert size={13} strokeWidth={1.5} aria-hidden="true" />
            {stopReasonLabel(activity.waitingReason)}
          </p>
        ) : null}
        {proposal ? (
          <div className="assistant-activity__decisions">
            <button
              type="button"
              className="assistant-activity__confirm"
              disabled={pending}
              onClick={() => onDecision("confirm")}
            >
              <Check size={13} strokeWidth={1.7} aria-hidden="true" />
              {pending ? t("assistant.decision.confirming") : t("assistant.decision.confirm")}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => onDecision("reject")}
            >
              {t("assistant.decision.reject")}
            </button>
          </div>
        ) : retryable ? (
          <div className="assistant-activity__decisions">
            <button
              type="button"
              className="assistant-activity__confirm"
              disabled={pending}
              onClick={() => onDecision("retry")}
            >
              {pending ? t("assistant.decision.retrying") : t("assistant.decision.retry")}
            </button>
          </div>
        ) : resumable ? (
          <div className="assistant-activity__decisions">
            <button
              type="button"
              className="assistant-activity__confirm"
              disabled={pending}
              onClick={() => onDecision("resume")}
            >
              {pending ? t("assistant.decision.resuming") : t("assistant.decision.resume")}
            </button>
            {cancellable ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onDecision("cancel")}
              >
                {t("assistant.activity.cancelTask")}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="assistant-activity__actions">
          {href ? (
            <Link className="assistant-activity__link" to={href}>
              {activity.status === "waiting" ? t("assistant.activity.openWaiting") : t("assistant.activity.openRun")}
              <ExternalLink size={12} strokeWidth={1.5} aria-hidden="true" />
            </Link>
          ) : null}
          {cancellable && onCancelTask ? (
            <button
              type="button"
              disabled={pending}
              onClick={onCancelTask}
              title={t("assistant.activity.cancelTaskTitle")}
            >
              {t("assistant.activity.cancelTask")}
            </button>
          ) : null}
          {onRetryChapter ? (
            <button
              type="button"
              disabled={pending}
              onClick={onRetryChapter}
              title={t("assistant.activity.retryChapterTitle")}
            >
              {t("assistant.activity.retryChapter")}
            </button>
          ) : null}
          {hasDetail ? (
            <button
              type="button"
              className="assistant-activity__toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? t("assistant.activity.collapseTrace") : t("assistant.activity.expandTrace")}
            </button>
          ) : null}
        </div>
        {expanded ? (
          <ActivityTrace projectId={projectId} activity={activity} />
        ) : null}
      </div>
    </article>
  );
}

function ActivityTrace({
  projectId,
  activity,
}: {
  projectId: string;
  activity: AssistantActivityDto;
}) {
  const { t } = useI18n();
  return (
    <div className="assistant-trace">
      {activity.phaseKey ? (
        <p className="assistant-trace__row">
          <span className="assistant-trace__label">{t("assistant.trace.phase")}</span>
          <span>{phaseLabel(activity.phaseKey)}</span>
        </p>
      ) : null}
      {activity.lastError ? (
        <p className="assistant-trace__row assistant-trace__row--error">
          <span className="assistant-trace__label">{t("assistant.trace.lastError")}</span>
          <span>
            {activity.lastError.message}
            <span className="mono"> · {activity.lastError.code}</span>
          </span>
        </p>
      ) : null}
      {activity.artifacts.length > 0 ? (
        <div className="assistant-trace__row">
          <span className="assistant-trace__label">{t("assistant.trace.artifacts")}</span>
          <ul className="assistant-trace__artifacts">
            {activity.artifacts.map((artifact) => (
              <li key={`${artifact.kind}:${artifact.id}`}>
                <Link to={artifactHref(projectId, artifact)}>
                  {artifactKindLabel(artifact.kind, artifact.label)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {activity.linkedSources.length > 0 ? (
        <p className="assistant-trace__row">
          <span className="assistant-trace__label">{t("assistant.trace.linked")}</span>
          <span className="mono">
            {activity.linkedSources
              .map((source) => `${source.type === "run" ? t("assistant.trace.sourceRun") : t("assistant.trace.sourceSession")} ${shortId(source.id)}`)
              .join(" · ")}
          </span>
        </p>
      ) : null}
      {activity.toolCall ? (
        <p className="assistant-trace__row">
          <span className="assistant-trace__label">{t("assistant.trace.toolCall")}</span>
          <span>{toolCallLabel(activity.toolCall)}</span>
        </p>
      ) : null}
    </div>
  );
}

function ActivityStatusIcon({
  status,
}: {
  status: AssistantActivityDto["status"];
}) {
  const props = { size: 15, strokeWidth: 1.6, "aria-hidden": true } as const;
  if (status === "completed") return <CircleCheck {...props} />;
  if (status === "failed" || status === "cancelled") {
    return <CircleAlert {...props} />;
  }
  if (status === "waiting" || status === "proposed") {
    return <Clock3 {...props} />;
  }
  if (status === "rejected") return <X {...props} />;
  return <LoaderCircle className="assistant-spin" {...props} />;
}
