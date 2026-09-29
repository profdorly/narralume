/* 故事变化（canon change set）裁定卡片：写作台「故事变化」面板与故事圣经
   「从正文补全」面板共用。负责条目渲染、采纳 / 暂缓、冲突展示与强制采纳确认。 */

import "../../styles/studio.css";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorNote } from "../../components/error-note";
import { getLocale, translate, useI18n, type MessageKey } from "../../i18n";
import {
  ApiError,
  decideCanonChangeSet,
  type CanonChangeSetView,
} from "../../lib/api";

export type CanonChangeDecision = "apply" | "reject";

export interface CanonChangeReviewLabels {
  apply?: string;
  forceApply?: string;
  defer?: string;
}

/** 候选变更集列表 + 裁定按钮；成功裁定后回调 onDecided。 */
export function CanonChangeSetReview({
  projectId,
  sets,
  entityNames,
  labels,
  forceAllowed = false,
  disabled = false,
  onDecided,
}: {
  projectId: string;
  sets: CanonChangeSetView[];
  entityNames: Map<string, string>;
  labels?: CanonChangeReviewLabels;
  /** 调用方已知冲突可强制覆盖（例如补全任务停机原因）时，直接提供强制采纳。 */
  forceAllowed?: boolean;
  disabled?: boolean;
  onDecided?: (
    set: CanonChangeSetView,
    action: CanonChangeDecision,
    result: CanonChangeSetView,
  ) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [forceTarget, setForceTarget] = useState<CanonChangeSetView | null>(
    null,
  );
  const mutation = useMutation({
    mutationFn: (input: {
      set: CanonChangeSetView;
      action: CanonChangeDecision;
      conflictPolicy?: "reject" | "force";
    }) =>
      decideCanonChangeSet(projectId, input.set.id, {
        action: input.action,
        expectedStatus: "candidate",
        conflictPolicy: input.conflictPolicy ?? "reject",
      }),
    onSuccess: (result, input) => {
      setForceTarget(null);
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "canon-change-sets"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "runs"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "overview"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["project", projectId, "autopilot"],
      });
      onDecided?.(input.set, input.action, result.changeSet);
    },
  });
  const conflict = settlementConflictDetails(mutation.error);
  const busy = disabled || mutation.isPending;
  return (
    <>
      {sets.map((set) => {
        const items = canonChangeItems(set.changes, entityNames);
        return (
          <article
            key={set.id}
            className="studio__proposal"
            data-status={set.status}
          >
            <strong>
              {canonSummary(set.changes) ?? t("studio.canon.fallbackSummary")}
            </strong>
            {items.length > 0 ? (
              <ul className="studio__canon-items">
                {items.map((item, index) => (
                  <li key={`${item.label}-${index}`}>
                    <span>{item.label}</span>
                    <p>{item.text}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="studio__panel-empty">{t("studio.canon.noItems")}</p>
            )}
            <small>{set.createdAt.slice(0, 16)}</small>
            {set.status === "candidate" ? (
              <div className="studio__proposal-actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => mutation.mutate({ set, action: "apply" })}
                >
                  {labels?.apply ?? t("studio.canon.apply")}
                </button>
                {forceAllowed ||
                (conflict?.forceAllowed &&
                  mutation.variables?.set.id === set.id) ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => setForceTarget(set)}
                  >
                    {labels?.forceApply ?? t("studio.canon.forceApply")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => mutation.mutate({ set, action: "reject" })}
                >
                  {labels?.defer ?? t("studio.canon.defer")}
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
      {mutation.isError ? (
        conflict ? (
          <SettlementConflictNote conflict={conflict} />
        ) : (
          <ErrorNote
            error={mutation.error}
            title={t("studio.errors.canonDecideFailed")}
          />
        )
      ) : null}
      {forceTarget ? (
        <ConfirmDialog
          title={t("studio.canon.forceTitle")}
          confirmLabel={t("studio.canon.forceConfirm")}
          danger
          pending={mutation.isPending}
          onCancel={() => setForceTarget(null)}
          onConfirm={() =>
            mutation.mutate({
              set: forceTarget,
              action: "apply",
              conflictPolicy: "force",
            })
          }
        >
          <p>{t("studio.canon.forceBody")}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** 冲突清单：原因 · 路径 · 当前记录，附可否强制覆盖的说明。 */
export function SettlementConflictNote({
  conflict,
}: {
  conflict: SettlementConflictDetails;
}) {
  const { t } = useI18n();
  return (
    <div
      className="studio__settlement-status"
      data-tone="failed"
      role="alert"
    >
      <strong>{t("studio.canon.conflictTitle")}</strong>
      <ul>
        {conflict.conflicts.map((item, index) => (
          <li key={`${item.path}-${index}`}>
            {settlementConflictLabel(item.reason)} · {item.path}
            {item.existingIds.length > 0
              ? ` · ${t("studio.canon.conflictRecords", { ids: item.existingIds.join(", ") })}`
              : ""}
          </li>
        ))}
      </ul>
      {conflict.forceAllowed ? (
        <p>{t("studio.canon.conflictForceable")}</p>
      ) : (
        <p>{t("studio.canon.conflictNotForceable")}</p>
      )}
    </div>
  );
}

export interface SettlementConflictDetails {
  conflicts: Array<{ path: string; existingIds: string[]; reason: string }>;
  forceAllowed: boolean;
}

/** 从裁定接口的 409 settlement.conflict 读出冲突清单。 */
export function settlementConflictDetails(
  error: unknown,
): SettlementConflictDetails | null {
  if (!(error instanceof ApiError) || error.code !== "settlement.conflict")
    return null;
  return parseSettlementConflicts(error.details);
}

/** 解析 { conflicts, forceAllowed } 载荷（接口错误 details 或任务停机原因）。 */
export function parseSettlementConflicts(
  details: unknown,
): SettlementConflictDetails | null {
  if (
    !isUnknownRecord(details) ||
    !Array.isArray(details.conflicts) ||
    typeof details.forceAllowed !== "boolean"
  )
    return null;
  const conflicts = details.conflicts
    .filter(isUnknownRecord)
    .flatMap((item) =>
      typeof item.path === "string" &&
      typeof item.reason === "string" &&
      Array.isArray(item.existingIds)
        ? [
            {
              path: item.path,
              reason: item.reason,
              existingIds: item.existingIds.filter(
                (id): id is string => typeof id === "string",
              ),
            },
          ]
        : [],
    );
  return { conflicts, forceAllowed: details.forceAllowed };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function settlementConflictLabel(reason: string): string {
  const keys: Record<string, MessageKey> = {
    target_locked: "studio.canon.reason.targetLocked",
    status_changed: "studio.canon.reason.statusChanged",
    target_not_current: "studio.canon.reason.targetNotCurrent",
    target_slot_mismatch: "studio.canon.reason.targetSlotMismatch",
    target_not_found: "studio.canon.reason.targetNotFound",
    target_pair_mismatch: "studio.canon.reason.targetPairMismatch",
    target_voided: "studio.canon.reason.targetVoided",
    target_already_anchored: "studio.canon.reason.targetAlreadyAnchored",
    settlement_unanchored: "studio.canon.reason.settlementUnanchored",
  };
  const messageKey = keys[reason];
  return messageKey ? translate(getLocale(), messageKey) : reason;
}

export function canonSummary(changes: Record<string, unknown>): string | null {
  return typeof changes.summary === "string" && changes.summary.trim()
    ? changes.summary
    : null;
}

export function canonChangeItems(
  changes: Record<string, unknown>,
  entityNames: Map<string, string>,
): Array<{ label: string; text: string }> {
  const locale = getLocale();
  const rows: Array<{ label: string; text: string }> = [];
  const records = (key: string) =>
    Array.isArray(changes[key])
      ? (changes[key] as unknown[]).filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
  const text = (record: Record<string, unknown>, key: string) =>
    typeof record[key] === "string" ? record[key] : "";
  const entity = (id: string) =>
    entityNames.get(id) ?? translate(locale, "studio.canon.unknownEntity");
  for (const item of records("stateDelta")) {
    rows.push({
      label: translate(locale, "studio.canon.itemLabel.stateDelta"),
      text: translate(locale, "studio.canon.stateDeltaText", {
        key: text(item, "key"),
        before:
          text(item, "before") ||
          translate(locale, "studio.canon.noPriorRecord"),
        after: text(item, "after"),
      }),
    });
  }
  for (const item of records("factCandidates")) {
    const value =
      item.value === null || item.value === undefined
        ? translate(locale, "studio.canon.factNoLongerHolds")
        : String(item.value);
    rows.push({
      label: translate(locale, "studio.canon.itemLabel.fact"),
      text: translate(locale, "studio.canon.factText", {
        entity: entity(text(item, "subjectId")),
        predicate: text(item, "predicate"),
        value,
      }),
    });
  }
  for (const item of records("timelineCandidates")) {
    const anchorEventId = text(item, "anchorEventId");
    if (anchorEventId) {
      // Anchoring adopts an existing event: its own title, description,
      // participants, causes and visibility stay (the candidate's required
      // visibility is not applied); the chapter (and story time, when given)
      // is set. The row says so, so the author does not expect the
      // candidate's visibility to take effect.
      const storyTime = text(item, "storyTime");
      rows.push({
        label: translate(locale, "studio.canon.itemLabel.timelineAnchor"),
        text: [
          translate(locale, "studio.canon.timelineAnchorText", {
            title: text(item, "title"),
          }),
          storyTime
            ? translate(locale, "studio.canon.timelineAnchorStoryTime", {
                storyTime,
              })
            : "",
          translate(locale, "studio.canon.timelineAnchorKeeps"),
        ]
          .filter(Boolean)
          .join(" · "),
      });
      continue;
    }
    rows.push({
      label: translate(locale, "studio.canon.itemLabel.timeline"),
      text: [
        text(item, "title"),
        text(item, "storyTime"),
        text(item, "description"),
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  for (const item of records("relationshipCandidates")) {
    rows.push({
      label: translate(locale, "studio.canon.itemLabel.relationship"),
      text: translate(locale, "studio.canon.relationshipText", {
        from: entity(text(item, "fromEntityId")),
        to: entity(text(item, "toEntityId")),
        relation: text(item, "relation"),
        change: text(item, "change"),
      }),
    });
  }
  for (const item of records("foreshadowCandidates")) {
    const actionKeys: Record<string, MessageKey> = {
      plant: "studio.canon.foreshadowAction.plant",
      develop: "studio.canon.foreshadowAction.develop",
      resolve: "studio.canon.foreshadowAction.resolve",
    };
    const action = translate(
      locale,
      actionKeys[text(item, "action")] ??
        "studio.canon.foreshadowAction.fallback",
    );
    rows.push({
      label: translate(locale, "studio.canon.itemLabel.foreshadow"),
      text: translate(locale, "studio.canon.foreshadowText", {
        action,
        title: text(item, "title"),
      }),
    });
  }
  return rows.filter((row) => row.text.replace(/[：:；；·「」]/g, "").trim());
}
