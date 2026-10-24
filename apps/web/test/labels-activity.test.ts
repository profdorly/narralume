import { describe, expect, it } from "vitest";

import {
  activityGoalLabel,
  activityStageLabel,
  activitySummaryLabel,
  artifactKindLabel,
  assistantSkillLabel,
  stopReasonLabel,
} from "../src/lib/labels";
import { setLocale } from "../src/i18n";
import "./i18n-en";

describe("assistant activity label formatters", () => {
  it("renders machine-key goals through the dictionary with params", () => {
    setLocale("pt-BR");
    expect(
      activityGoalLabel({ key: "activity.goal.sessionChapters", params: { count: 5 } }),
    ).toBe("Criação rápida de 5 capítulos");
    expect(
      activityGoalLabel({
        key: "activity.goal.chapterTitle",
        params: { title: "雨夜" },
      }),
    ).toBe("Concluir “雨夜”");
  });

  it("passes raw-string goals through verbatim (user-authored titles)", () => {
    setLocale("pt-BR");
    expect(activityGoalLabel("我的复合任务")).toBe("我的复合任务");
  });

  it("falls back to the raw key for unknown machine keys", () => {
    setLocale("pt-BR");
    expect(activityGoalLabel({ key: "activity.goal.unknown", params: {} })).toBe(
      "activity.goal.unknown",
    );
  });

  it("renders stage steps and interpolates progress", () => {
    setLocale("pt-BR");
    expect(
      activityStageLabel({
        key: "activity.stage.sessionWritingTitle",
        params: { title: "雾都", progress: "2/5" },
      }),
    ).toBe("Escrevendo “雾都” — 2/5 capítulos");
    expect(activityStageLabel({ key: "activity.step.draftGenerate", params: {} })).toBe(
      "Escrevendo o texto",
    );
  });

  it("renders summaries and null safety", () => {
    setLocale("pt-BR");
    expect(
      activitySummaryLabel({ key: "activity.summary.longGoalCompleted", params: {} }),
    ).toBe("Tarefa longa concluída");
    expect(activitySummaryLabel(null)).toBeNull();
  });

  it("maps artifact kinds and keeps unknown labels verbatim", () => {
    setLocale("pt-BR");
    expect(artifactKindLabel("document_version", "document_version")).toBe("Versão do manuscrito");
    expect(artifactKindLabel("custom_kind", "自定义保留")).toBe("自定义保留");
  });

  it("renders skill labels by id", () => {
    setLocale("pt-BR");
    expect(assistantSkillLabel("compose.serial")).toBe("Tarefa composta de escrita");
    expect(assistantSkillLabel("unknown.skill")).toBe("unknown.skill");
  });

  it("localizes the long-goal baseline pause reason code", () => {
    setLocale("pt-BR");
    expect(stopReasonLabel("long_goal.paused_baseline")).toBe(
      "A base mudou; continue ou cancele a tarefa",
    );
  });

  it("switches to English with the locale", () => {
    setLocale("en");
    expect(
      activityGoalLabel({ key: "activity.goal.sessionChapters", params: { count: 3 } }),
    ).toBe("AI quick-write 3 chapters");
    expect(activityStageLabel({ key: "activity.step.draftGenerate", params: {} })).toBe(
      "Writing the prose",
    );
    setLocale("pt-BR");
  });
});
