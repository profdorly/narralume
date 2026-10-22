import "../project-assistant.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowUp,
  CircleDashed,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ErrorNote } from "../../components/error-note";
import { getLocale, translate, useI18n } from "../../i18n";
import {
  archiveAssistantConversation,
  configureAssistantConversation,
  controlAutopilotSession,
  controlRun,
  createAssistantConversation,
  decideAssistantActivity,
  getAssistantConversation,
  getAssistantConversations,
  renameAssistantConversation,
  sendAssistantMessage,
  type AssistantActivityDto,
  type AssistantContext,
  type AssistantConversationDto,
} from "../../lib/api";
import { useServerEvents } from "../../lib/sse";
import { ConversationPicker } from "./conversation-picker";
import {
  assistantRunIds,
  createRequestId,
  hasLiveActivity,
  invalidateAssistant,
  invalidateAssistantDetail,
  rememberedConversation,
  selectConversation,
  timelineEntries,
  activityActionId,
} from "./helpers";
import { AssistantModelControls } from "./model-controls";
import {
  ActivityEntry,
  AssistantWelcome,
  ContextRibbon,
  MessageEntry,
} from "./timeline";

const PROJECT_CONTEXT: AssistantContext = {
  surface: "project",
  documentId: null,
  outlineNodeId: null,
  canonSpread: null,
  selection: null,
};

interface ProjectAssistantProps {
  projectId: string;
  context: AssistantContext;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

interface PendingAssistantSend {
  identity: string;
  conversationRequestId: string;
  messageRequestId: string;
  targetConversationId: string | null;
}

export function ProjectAssistant({
  projectId,
  context,
  open,
  onOpen,
  onClose,
}: ProjectAssistantProps) {
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [usePageContext, setUsePageContext] = useState(true);
  const [conversationId, setConversationId] = useState<string | null>(() =>
    rememberedConversation(projectId),
  );
  const messageContext = usePageContext ? context : PROJECT_CONTEXT;
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(open);
  const pendingSendRef = useRef<PendingAssistantSend | null>(null);
  const defaultConversationRequestedRef = useRef(false);
  const conversationsQuery = useQuery({
    queryKey: ["assistant", projectId, "conversations"],
    queryFn: ({ signal }) => getAssistantConversations(projectId, signal),
  });

  useEffect(() => {
    const conversations = conversationsQuery.data;
    if (!conversations) return;
    const selected = conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (selected) return;
    const next = conversations.find(
      (conversation) => conversation.status === "active",
    );
    selectConversation(projectId, next?.id ?? null, setConversationId);
  }, [conversationId, conversationsQuery.data, projectId]);

  const detailQuery = useQuery({
    queryKey: ["assistant", projectId, "conversation", conversationId],
    queryFn: ({ signal }) => getAssistantConversation(conversationId!, signal),
    enabled: Boolean(conversationId),
    refetchInterval: (query) =>
      hasLiveActivity(query.state.data) ? 1_500 : false,
  });
  const relatedRunIds = useMemo(
    () => assistantRunIds(detailQuery.data),
    [detailQuery.data],
  );
  useServerEvents({
    onRunStatus: (runId) => {
      if (relatedRunIds.has(runId))
        void invalidateAssistantDetail(queryClient, projectId, conversationId);
    },
    onRunEvent: (runId) => {
      if (relatedRunIds.has(runId))
        void invalidateAssistantDetail(queryClient, projectId, conversationId);
    },
  }, open && Boolean(conversationId));

  const createMutation = useMutation({
    mutationFn: (title?: string) =>
      createAssistantConversation(projectId, {
        requestId: createRequestId(),
        title: title ?? translate(getLocale(), "assistant.conversation.defaultTitle"),
      }),
    onSuccess: (conversation) => {
      pendingSendRef.current = null;
      queryClient.setQueryData<AssistantConversationDto[]>(
        ["assistant", projectId, "conversations"],
        (current = []) => [
          conversation,
          ...current.filter((candidate) => candidate.id !== conversation.id),
        ],
      );
      selectConversation(projectId, conversation.id, setConversationId);
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
    },
    onError: () => {
      defaultConversationRequestedRef.current = false;
    },
  });
  useEffect(() => {
    const conversations = conversationsQuery.data;
    if (
      !conversations ||
      conversations.some((conversation) => conversation.status === "active") ||
      defaultConversationRequestedRef.current
    ) {
      return;
    }
    defaultConversationRequestedRef.current = true;
    createMutation.mutate(undefined);
  }, [conversationsQuery.data, createMutation]);

  const archiveMutation = useMutation({
    mutationFn: (targetConversationId: string) =>
      archiveAssistantConversation(targetConversationId),
    onSuccess: (conversation) => {
      const next = conversationsQuery.data?.find(
        (candidate) =>
          candidate.id !== conversation.id && candidate.status === "active",
      );
      selectConversation(projectId, next?.id ?? null, setConversationId);
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
    },
  });
  const [renamingConversation, setRenamingConversation] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      renameAssistantConversation(input.conversationId, input.title),
    onSuccess: () => {
      setRenamingConversation(false);
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
    },
  });
  const configureMutation = useMutation({
    mutationFn: (input: {
      conversationId: string;
      modelId?: string | null;
      reasoningEffort?: string | null;
    }) =>
      configureAssistantConversation(input.conversationId, {
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: input.reasoningEffort }),
      }),
    onSuccess: (conversation) => {
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversation", conversation.id],
      });
    },
  });
  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      const contextSnapshot = messageContext;
      const identity = JSON.stringify({ content, context: contextSnapshot });
      if (pendingSendRef.current?.identity !== identity) {
        pendingSendRef.current = {
          identity,
          conversationRequestId: createRequestId(),
          messageRequestId: createRequestId(),
          targetConversationId: conversationId,
        };
      }
      const pending = pendingSendRef.current;
      let targetConversationId = pending.targetConversationId;
      if (!targetConversationId) {
        const conversation = await createAssistantConversation(projectId, {
          requestId: pending.conversationRequestId,
          title: translate(getLocale(), "assistant.conversation.defaultTitle"),
        });
        targetConversationId = conversation.id;
        pending.targetConversationId = conversation.id;
        selectConversation(projectId, conversation.id, setConversationId);
      }
      return {
        conversationId: targetConversationId,
        accepted: await sendAssistantMessage(targetConversationId, {
          requestId: pending.messageRequestId,
          content,
          context: contextSnapshot,
        }),
      };
    },
    onSuccess: ({ conversationId: targetConversationId }) => {
      pendingSendRef.current = null;
      setDraft("");
      void queryClient.invalidateQueries({
        queryKey: [
          "assistant",
          projectId,
          "conversation",
          targetConversationId,
        ],
      });
      void queryClient.invalidateQueries({
        queryKey: ["assistant", projectId, "conversations"],
      });
    },
  });
  const activityMutation = useMutation({
    mutationFn: (input: {
      activityId: string;
      action: "confirm" | "reject" | "retry" | "resume" | "cancel";
    }) => decideAssistantActivity(input.activityId, input.action),
    onSettled: () =>
      invalidateAssistant(queryClient, projectId, conversationId),
  });
  /* 侧栏的低风险直连动作：run/autopilot 卡的取消直接走各自控制端点，
   *  不经 assistant activity 通道（那套只服务工具提案/长期目标）。
   *  失败章节卡的重试同理——与运行中心「重试本章」同一动作。 */
  const taskControlMutation = useMutation({
    mutationFn: async ({
      activity,
      action,
    }: {
      activity: AssistantActivityDto;
      action: "cancel" | "retry_chapter";
    }): Promise<unknown> => {
      // 返回结构随来源不同（RunSnapshot vs 会话详情），这里只关心成功与否。
      if (action === "retry_chapter") {
        return controlRun(projectId, activity.sourceId, {
          action: "retry_chapter",
          requestId: crypto.randomUUID(),
        });
      }
      if (activity.sourceType === "autopilot") {
        await controlAutopilotSession(activity.sourceId, {
          action: "cancel",
        });
        return null;
      }
      return controlRun(projectId, activity.sourceId, { action: "cancel" });
    },
    onSettled: () =>
      invalidateAssistant(queryClient, projectId, conversationId),
  });

  const entries = useMemo(
    () => timelineEntries(detailQuery.data),
    [detailQuery.data],
  );
  const activeCount =
    detailQuery.data?.activities.filter((activity) =>
      ["queued", "running", "waiting", "proposed"].includes(activity.status),
    ).length ?? 0;
  const currentConversation = conversationsQuery.data?.find(
    (conversation) => conversation.id === conversationId,
  );
  const conversationArchived = currentConversation?.status === "archived";
  const submitRename = () => {
    const title = renameDraft.trim();
    if (!conversationId || !title || title === currentConversation?.title) {
      setRenamingConversation(false);
      return;
    }
    renameMutation.mutate({ conversationId, title });
  };

  useEffect(() => {
    if (!open) return;
    const frame = timelineRef.current;
    if (!frame) return;
    frame.scrollTo({ top: frame.scrollHeight, behavior: "smooth" });
  }, [entries.length, open]);

  useEffect(() => {
    if (wasOpenRef.current && !open) triggerRef.current?.focus();
    wasOpenRef.current = open;
  }, [open]);

  const submit = (content = draft) => {
    const value = content.trim();
    if (!value || sendMutation.isPending) return;
    sendMutation.mutate(value);
  };

  return (
    <>
      {!open ? (
        <button
          ref={triggerRef}
          type="button"
          className="assistant-trigger"
          onClick={onOpen}
          aria-label={t("assistant.trigger.open")}
          title={t("assistant.trigger.title")}
        >
          <MessageSquareText size={17} strokeWidth={1.5} aria-hidden="true" />
          <span>{t("assistant.trigger.label")}</span>
          {activeCount > 0 ? (
            <span className="assistant-trigger__count mono">{activeCount}</span>
          ) : null}
        </button>
      ) : null}
      {open ? (
        <div
          className="assistant-backdrop"
          aria-hidden="true"
          onClick={onClose}
        />
      ) : null}
      {open ? (
        <aside
          className="assistant-panel"
          data-open="true"
          aria-label={t("assistant.panel.label")}
        >
        <header className="assistant-panel__head">
          <div className="assistant-panel__identity">
            <p className="assistant-panel__eyebrow mono">PROJECT ASSISTANT</p>
            {renamingConversation ? (
              <form className="assistant-conv__rename" onSubmit={(event) => { event.preventDefault(); submitRename(); }}>
                <input
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRenamingConversation(false);
                  }}
                  autoFocus
                  maxLength={200}
                  aria-label={t("assistant.conversation.renameLabel")}
                  placeholder={t("assistant.conversation.renamePlaceholder")}
                />
                <button
                  type="submit"
                  className="assistant-conv__rename-save"
                  disabled={renameMutation.isPending || !renameDraft.trim()}
                >
                  {renameMutation.isPending ? t("common.state.saving") : t("common.action.save")}
                </button>
              </form>
            ) : (
              <ConversationPicker
                conversations={conversationsQuery.data ?? []}
                loading={conversationsQuery.isPending}
                value={conversationId}
                onSelect={(next) =>
                  selectConversation(projectId, next, setConversationId)
                }
              />
            )}
          </div>
          <div className="assistant-panel__head-actions">
            <button
              type="button"
              className="assistant-panel__icon"
              aria-label={t("assistant.conversation.renameAction")}
              title={t("assistant.conversation.renameAction")}
              disabled={!conversationId}
              onClick={() => {
                setRenameDraft(currentConversation?.title ?? "");
                setRenamingConversation(true);
              }}
            >
              <Pencil size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="assistant-panel__icon"
              aria-label={t("assistant.conversation.archiveAction")}
              title={t("assistant.conversation.archiveAction")}
              disabled={
                !conversationId || conversationArchived || archiveMutation.isPending
              }
              onClick={() => conversationId && archiveMutation.mutate(conversationId)}
            >
              <Archive size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="assistant-panel__icon"
              aria-label={t("assistant.conversation.createAction")}
              title={t("assistant.conversation.createAction")}
              disabled={createMutation.isPending}
              onClick={() =>
                createMutation.mutate(
                  t("assistant.conversation.newTitle", {
                    count: (conversationsQuery.data?.length ?? 0) + 1,
                  }),
                )
              }
            >
              <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="assistant-panel__icon"
              aria-label={t("assistant.panel.close")}
              onClick={onClose}
            >
              <X size={17} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        </header>

        <ContextRibbon
          context={messageContext}
          usingPageContext={usePageContext}
          onToggleScope={() => setUsePageContext((current) => !current)}
        />

        <div className="assistant-panel__timeline" ref={timelineRef}>
          {conversationsQuery.isError ? (
            <ErrorNote
              error={conversationsQuery.error}
              title={t("assistant.errors.loadConversations")}
            />
          ) : detailQuery.isError ? (
            <ErrorNote error={detailQuery.error} title={t("assistant.errors.loadDetail")} />
          ) : entries.length > 0 ? (
            <ol className="assistant-timeline" aria-live="polite">
              {entries.map((entry) => (
                <li key={`${entry.type}:${entry.id}`}>
                  {entry.type === "message" ? (
                    <MessageEntry message={entry.message} />
                  ) : (
                    <ActivityEntry
                      projectId={projectId}
                      activity={entry.activity}
                      pending={
                        activityMutation.isPending &&
                        activityMutation.variables?.activityId ===
                          activityActionId(entry.activity)
                      }
                      onDecision={(action) => {
                        const activityId = activityActionId(entry.activity);
                        if (activityId) {
                          activityMutation.mutate({ activityId, action });
                        }
                      }}
                      onCancelTask={
                        entry.activity.availableActions.includes("cancel") &&
                        (entry.activity.sourceType === "run" ||
                          entry.activity.sourceType === "autopilot")
                          ? () =>
                              taskControlMutation.mutate({
                                activity: entry.activity,
                                action: "cancel",
                              })
                          : null
                      }
                      onRetryChapter={
                        entry.activity.availableActions.includes(
                          "retry_chapter",
                        ) && entry.activity.sourceType === "run"
                          ? () =>
                              taskControlMutation.mutate({
                                activity: entry.activity,
                                action: "retry_chapter",
                              })
                          : null
                      }
                    />
                  )}
                </li>
              ))}
            </ol>
          ) :
              conversationsQuery.isPending ||
                (Boolean(conversationId) && detailQuery.isPending) ? (
            <div className="assistant-panel__loading" role="status">
              <CircleDashed size={18} strokeWidth={1.4} aria-hidden="true" />
              {t("assistant.loading")}
            </div>
          ) : (
            <AssistantWelcome onPrompt={submit} />
          )}
        </div>

        <footer className="assistant-composer">
          {sendMutation.isError ? (
            <ErrorNote error={sendMutation.error} title={t("assistant.errors.sendMessage")} />
          ) : null}
          {activityMutation.isError ? (
            <ErrorNote
              error={activityMutation.error}
              title={t("assistant.errors.decideActivity")}
            />
          ) : null}
          {archiveMutation.isError ? (
            <ErrorNote error={archiveMutation.error} title={t("assistant.errors.archive")} />
          ) : null}
          {renameMutation.isError ? (
            <ErrorNote error={renameMutation.error} title={t("assistant.errors.rename")} />
          ) : null}
          {configureMutation.isError ? (
            <ErrorNote
              error={configureMutation.error}
              title={t("assistant.errors.configure")}
            />
          ) : null}
          <AssistantModelControls
            conversation={currentConversation ?? null}
            disabled={!conversationId || conversationArchived}
            pending={configureMutation.isPending}
            onConfigure={(input) =>
              conversationId &&
              configureMutation.mutate({ conversationId, ...input })
            }
          />
          <label className="assistant-composer__field">
            <span className="sr-only">{t("assistant.composer.messageLabel")}</span>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t("assistant.composer.placeholder")}
              rows={3}
              maxLength={100_000}
              disabled={conversationArchived}
            />
            <button
              type="button"
              className="assistant-composer__send"
              aria-label={t("assistant.composer.send")}
              disabled={
                conversationArchived || !draft.trim() || sendMutation.isPending
              }
              onClick={() => submit()}
            >
              {sendMutation.isPending ? (
                <LoaderCircle
                  className="assistant-spin"
                  size={17}
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
              ) : (
                <ArrowUp size={17} strokeWidth={1.7} aria-hidden="true" />
              )}
            </button>
          </label>
          <p className="assistant-composer__note">
            {conversationArchived ? (
              <span>{t("assistant.conversation.archivedNote")}</span>
            ) : (
              <>
                <span>{t("assistant.composer.sendHint")}</span>
                <span>{t("assistant.composer.persistHint")}</span>
              </>
            )}
          </p>
        </footer>
        </aside>
      ) : null}
    </>
  );
}
