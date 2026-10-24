// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import "./i18n-en";
import type {
  BibleBackfillDetailDto,
  BibleBackfillItemDto,
  BibleBackfillJobDto,
  StoryBible,
} from "../src/lib/api";
import { BibleWorkspace } from "../src/workspaces/bible";
import { BibleBackfillPanel } from "../src/workspaces/bible/backfill-panel";

/* 「从正文补全故事圣经」面板：开始确认、进度、逐章裁定、停机处理与完成指引。 */

const NOW = "2026-09-28T10:00:00.000Z";

const BIBLE = {
  project: {
    id: "p-1",
    title: "Tide Lamp",
    subtitle: null,
    premise: null,
    language: "en",
    phase: "writing",
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  intent: null,
  outline: [],
  entities: [{ id: "e-1", name: "Shen Yan" }],
  facts: [],
  relationships: [],
  timeline: [],
  foreshadows: [],
  occupiedOutlineNodeIds: [],
  documents: ["One", "Two", "Three"].map((title, index) => ({
    id: `doc-${index + 1}`,
    projectId: "p-1",
    kind: "chapter",
    title: `Chapter ${title}`,
    currentVersionId: `ver-${index + 1}`,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  })),
} as unknown as StoryBible;

function job(overrides: Partial<BibleBackfillJobDto> = {}): BibleBackfillJobDto {
  return {
    id: "job-1",
    projectId: "p-1",
    status: "running",
    mode: "review_each",
    error: null,
    pauseRequested: false,
    cancelRequested: false,
    currentOrdinal: 1,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function item(
  ordinal: number,
  status: BibleBackfillItemDto["status"],
  overrides: Partial<BibleBackfillItemDto> = {},
): BibleBackfillItemDto {
  return {
    ordinal,
    outlineNodeId: `node-${ordinal + 1}`,
    documentId: `doc-${ordinal + 1}`,
    versionId: `ver-${ordinal + 1}`,
    title: `Chapter ${["One", "Two", "Three"][ordinal]}`,
    attempt: 1,
    runId: null,
    changeSetId: null,
    status,
    skipReason: null,
    error: null,
    note: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function detail(
  jobValue: BibleBackfillJobDto | null,
  items: BibleBackfillItemDto[],
  availableActions: BibleBackfillDetailDto["availableActions"] = [],
  usage: BibleBackfillDetailDto["usage"] = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
  },
): BibleBackfillDetailDto {
  const count = (status: BibleBackfillItemDto["status"]) =>
    items.filter((entry) => entry.status === status).length;
  return {
    job: jobValue,
    items,
    counts: {
      total: items.length,
      pending: count("pending"),
      settling: count("settling"),
      awaitingDecision: count("awaiting_decision"),
      applied: count("applied"),
      rejected: count("rejected"),
      empty: count("empty"),
      failed: count("failed"),
      skipped: count("skipped"),
    },
    usage,
    availableActions,
    unanchoredImportedEvents: 0,
  };
}

const EMPTY = detail(null, []);

const CHANGE_SET = {
  id: "ccs-2",
  projectId: "p-1",
  runId: "run-2",
  stepId: "step-2",
  changes: {
    summary: "Lamp heat reveals the missing name",
    factCandidates: [
      { subjectId: "e-1", predicate: "can read", value: "blank letters" },
    ],
  },
  status: "candidate",
  createdAt: NOW,
  decidedAt: null,
};

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** 路由式 fetch 桩：current 可在测试中替换；未知请求返回 404。 */
function stubApi(routes: {
  current: () => BibleBackfillDetailDto;
  onStart?: (body: Record<string, unknown>) => Promise<Response>;
  onAction?: (body: Record<string, unknown>) => Promise<Response>;
  onDecision?: (body: Record<string, unknown>) => Promise<Response>;
  changeSets?: () => unknown[];
  extra?: (url: string) => Promise<Response> | null;
}) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    if (url === "/api/projects/p-1/bible-backfills/current")
      return json(routes.current());
    if (url === "/api/projects/p-1/bible-backfills" && method === "POST")
      return routes.onStart ? routes.onStart(body!) : json({}, 500);
    if (url === "/api/projects/p-1/bible-backfills/job-1/actions")
      return routes.onAction ? routes.onAction(body!) : json({}, 500);
    if (url === "/api/projects/p-1/canon-change-sets")
      return json({ changeSets: routes.changeSets?.() ?? [] });
    if (url.startsWith("/api/projects/p-1/canon-change-sets/") && url.endsWith("/decisions"))
      return routes.onDecision ? routes.onDecision(body!) : json({}, 500);
    const extra = routes.extra?.(url);
    if (extra) return extra;
    return json({ error: { code: "route.not_found", message: `unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function renderPanel(
  options: {
    focus?: boolean;
    onOpen?: (section: string) => void;
    /** 预先放入缓存的变更集列表（模拟写作台已读取过）。 */
    cachedChangeSets?: unknown[];
  } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (options.cachedChangeSets)
    client.setQueryData(["project", "p-1", "canon-change-sets"], options.cachedChangeSets);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BibleBackfillPanel
          projectId="p-1"
          bible={BIBLE}
          focus={options.focus ?? true}
          onOpenCandidateDesk={options.onOpen ?? (() => undefined)}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function actionResponse(value: BibleBackfillDetailDto) {
  return json({ ...value, idempotentReplay: false });
}

class EventSourceStub {
  static current: EventSourceStub | null = null;
  private readonly listeners = new Map<string, EventListener[]>();
  constructor() {
    EventSourceStub.current = this;
  }
  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener() {}
  close() {}
  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  setLocale("en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  EventSourceStub.current = null;
  window.localStorage.clear();
});

describe("Complete Story Bible from manuscript", () => {
  it("idle state explains the pass and starts it after the confirmation dialog", async () => {
    let current = EMPTY;
    const { calls } = stubApi({
      current: () => current,
      onStart: () => {
        current = detail(job({ mode: "auto_apply_stop_on_conflict", currentOrdinal: 0 }), [
          item(0, "settling", { runId: "run-1" }),
          item(1, "pending"),
          item(2, "pending"),
        ], ["pause", "cancel", "skip_item"]);
        return json({ ...current, idempotentReplay: false }, 202);
      },
    });
    renderPanel();

    expect(await screen.findByText(/Found 3 chapters with manuscript text/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Complete Story Bible from manuscript" })).toBeInTheDocument();
    expect(screen.getByText(/proposes those story changes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate full Story Bible" }));

    const dialog = screen.getByRole("alertdialog", { name: "Generate the full Story Bible" });
    expect(
      within(dialog).getByRole("radio", { name: /Generate everything automatically \(recommended\)/ }),
    ).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /Then generate Intent, Entities and Outline/ })).toBeChecked();
    expect(within(dialog).getByText(/It will process 3 chapters with manuscript text/)).toBeInTheDocument();
    const cost = within(dialog).getByText(/Uses the writing model configured in Settings/);
    expect(cost).toHaveTextContent(/at least one model call/);
    expect(cost).toHaveTextContent(/up to 5 attempts/);
    expect(cost).toHaveTextContent(/one more embedding call/);
    expect(cost).toHaveTextContent(/no spending cap/);
    expect(cost).toHaveTextContent(/pause or cancel at any time/);
    expect(cost).not.toHaveTextContent(/one model call and/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Generate" }));

    await screen.findByText("Reading chapter 1 of 3: Chapter One");
    const start = calls.find((call) => call.method === "POST" && call.url.endsWith("/bible-backfills"));
    expect(start?.body).toEqual({
      requestId: expect.any(String),
      mode: "auto_apply_stop_on_conflict",
    });
    expect(window.localStorage.getItem("narralume:bible-backfill:sections:job-1")).toBe("1");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("explains how to re-import when the manuscript has no chapters", async () => {
    stubApi({
      current: () => EMPTY,
      onStart: () =>
        json(
          {
            error: {
              code: "bible_backfill.no_chapters",
              message: "There is no chapter manuscript to complete the Story Bible from",
              requestId: "req-1",
            },
          },
          422,
        ),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Generate full Story Bible" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("No separate chapters to read")).toBeInTheDocument();
    expect(within(alert).getByText(/Re-import the file with chapter headings/)).toBeInTheDocument();
  });

  it("running state shows progress, accessible chapter statuses, and pauses", async () => {
    let current = detail(job({ currentOrdinal: 1 }), [
      item(0, "applied"),
      item(1, "settling", { runId: "run-2" }),
      item(2, "pending"),
    ], ["pause", "cancel", "skip_item"]);
    const { calls } = stubApi({
      current: () => current,
      onAction: () => {
        current = { ...current, job: job({ pauseRequested: true }), availableActions: ["cancel", "skip_item"] };
        return actionResponse(current);
      },
    });
    renderPanel();

    expect(await screen.findByText("Reading chapter 2 of 3: Chapter Two")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Completion progress" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByText("1 of 3 chapters done")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Chapter progress" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Chapter OneApplied",
      "Chapter TwoReading",
      "Chapter ThreeWaiting",
    ]);
    expect(rows[1]).toHaveAttribute("aria-current", "step");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByText("Pausing after the current chapter finishes…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    const pause = calls.find((call) => call.url.endsWith("/job-1/actions"));
    expect(pause?.body).toEqual({ requestId: expect.any(String), action: "pause" });
  });

  it("review-each decision applies through the change-set decision route and refreshes", async () => {
    let decided = false;
    let current = detail(job({ status: "awaiting_decision", currentOrdinal: 1 }), [
      item(0, "applied"),
      item(1, "awaiting_decision", { runId: "run-2", changeSetId: "ccs-2" }),
      item(2, "pending"),
    ], ["pause", "cancel", "skip_item"]);
    const { calls } = stubApi({
      current: () => current,
      changeSets: () => [decided ? { ...CHANGE_SET, status: "applied" } : CHANGE_SET],
      onDecision: () => {
        decided = true;
        current = detail(job({ status: "running", currentOrdinal: 2 }), [
          item(0, "applied"),
          item(1, "applied", { changeSetId: "ccs-2" }),
          item(2, "settling", { runId: "run-3" }),
        ], ["pause", "cancel", "skip_item"]);
        return json({ changeSet: { ...CHANGE_SET, status: "applied" } });
      },
    });
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Review chapter 2 of 3: Chapter Two" })).toBeInTheDocument();
    expect(await screen.findByText("Lamp heat reveals the missing name")).toBeInTheDocument();
    expect(screen.getByText("Shen Yan · can read: blank letters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject & continue" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Defer/ })).not.toBeInTheDocument();
    expect(screen.getByText(/A rejected chapter is read again the next time/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply & continue" }));

    expect(await screen.findByText("Reading chapter 3 of 3: Chapter Three")).toBeInTheDocument();
    const decision = calls.find((call) => call.url.endsWith("/canon-change-sets/ccs-2/decisions"));
    expect(decision?.body).toEqual({
      action: "apply",
      expectedStatus: "candidate",
      conflictPolicy: "reject",
      requestId: "ccs-2:apply:reject",
    });
  });

  it("auto-apply conflict offers force apply via the decision route and then resumes", async () => {
    let current = detail(
      job({
        status: "awaiting_user",
        mode: "auto_apply_stop_on_conflict",
        currentOrdinal: 1,
        error: {
          code: "settlement.conflict",
          message: "These story changes conflict with the current canon",
          ordinal: 1,
          changeSetId: "ccs-2",
          conflicts: [{ path: "factCandidates.0", existingIds: ["fact-locked"], reason: "target_locked" }],
          forceAllowed: true,
        },
      }),
      [
        item(0, "applied"),
        item(1, "awaiting_decision", { runId: "run-2", changeSetId: "ccs-2" }),
        item(2, "pending"),
      ],
      ["resume", "cancel", "skip_item"],
    );
    const { calls } = stubApi({
      current: () => current,
      changeSets: () => [CHANGE_SET],
      onDecision: () => json({ changeSet: { ...CHANGE_SET, status: "applied" } }),
      onAction: () => {
        current = detail(job({ status: "running", mode: "auto_apply_stop_on_conflict", currentOrdinal: 2 }), [
          item(0, "applied"),
          item(1, "applied"),
          item(2, "settling"),
        ], ["pause", "cancel"]);
        return actionResponse(current);
      },
    });
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Chapter 2 conflicts with the current canon" })).toBeInTheDocument();
    expect(screen.getByText(/The target record is locked · factCandidates.0/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Force apply & continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm force adopt" }));

    expect(await screen.findByText("Reading chapter 3 of 3: Chapter Three")).toBeInTheDocument();
    const decision = calls.find((call) => call.url.endsWith("/decisions"));
    expect(decision?.body).toMatchObject({ action: "apply", conflictPolicy: "force", requestId: "ccs-2:apply:force" });
    const resume = calls.find((call) => call.url.endsWith("/job-1/actions"));
    expect(resume?.body).toEqual({ requestId: expect.any(String), action: "resume" });
    expect(calls.indexOf(decision!)).toBeLessThan(calls.indexOf(resume!));
  });

  it("child failure offers retry, skip, and a link to the run", async () => {
    const failure = {
      code: "child.failed",
      message: "Provider request timed out",
      category: "timeout",
      runId: "run-2",
      stepId: "step-2",
      ordinal: 1,
    };
    let current = detail(job({ status: "awaiting_user", currentOrdinal: 1, error: failure }), [
      item(0, "applied"),
      item(1, "failed", { runId: "run-2", error: failure }),
      item(2, "pending"),
    ], ["cancel", "skip_item", "retry_item"]);
    const actions: Array<Record<string, unknown>> = [];
    stubApi({
      current: () => current,
      onAction: (body) => {
        actions.push(body);
        current = detail(job({ status: "running", currentOrdinal: 1 }), [
          item(0, "applied"),
          item(1, "pending", { attempt: 2 }),
          item(2, "pending"),
        ], ["pause", "cancel", "skip_item"]);
        return actionResponse(current);
      },
    });
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Chapter 2 could not be settled" })).toBeInTheDocument();
    expect(screen.getByText("The model call for this chapter kept failing after its automatic retries.")).toBeInTheDocument();
    expect(screen.getByText("Details: Provider request timed out")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View run" })).toHaveAttribute("href", "/projects/p-1/runs?run=run-2");
    expect(screen.getByRole("button", { name: "Skip chapter" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry chapter" }));

    await waitFor(() => expect(actions).toEqual([{ requestId: expect.any(String), action: "retry_item", ordinal: 1 }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry chapter" })).not.toBeInTheDocument());
  });

  it("shows the usage recorded so far, with a cost only when pricing produced one", async () => {
    const running = (usage: BibleBackfillDetailDto["usage"]) =>
      detail(job({ currentOrdinal: 1 }), [
        item(0, "applied"),
        item(1, "settling", { runId: "run-2" }),
        item(2, "pending"),
      ], ["pause", "cancel", "skip_item"], usage);
    stubApi({
      current: () => running({ calls: 4, inputTokens: 1_200, outputTokens: 300, costUsd: null }),
    });
    renderPanel();
    expect(await screen.findByText("Used so far: 4 model calls, 1,500 tokens")).toBeInTheDocument();
    expect(
      screen.getByText("Cost estimates appear once model prices are configured in NARRATIVE_MODEL_PRICING_JSON."),
    ).toBeInTheDocument();
    cleanup();

    stubApi({
      current: () => running({ calls: 4, inputTokens: 1_200, outputTokens: 300, costUsd: 0.0042 }),
    });
    renderPanel();
    expect(await screen.findByText("Used so far: 4 model calls, 1,500 tokens, ~$0.0042")).toBeInTheDocument();
    expect(screen.queryByText(/NARRATIVE_MODEL_PRICING_JSON/)).not.toBeInTheDocument();
  });

  it("explains stop reasons in Chinese without surfacing raw codes as the message", async () => {
    setLocale("pt-BR");
    const cases: Array<{
      error: NonNullable<BibleBackfillJobDto["error"]>;
      current: BibleBackfillItemDto;
      message: string;
      secondary: string[];
    }> = [
      {
        error: { code: "child.awaiting_user", runId: "run-2", ordinal: 1 },
        current: item(1, "settling", { runId: "run-2" }),
        message: "A execução de acerto deste capítulo parou e está esperando você. Retome para continuá-la, ou abra a execução para ver os detalhes.",
        secondary: [],
      },
      {
        error: {
          code: "bible_backfill.chapter.changed",
          message: "The chapter manuscript no longer matches the outline chapter it was queued for",
          ordinal: 1,
        },
        current: item(1, "failed"),
        message: "O manuscrito deste capítulo já não corresponde ao capítulo para o qual foi enfileirado; pode ter sido movido, arquivado ou removido.",
        secondary: [],
      },
      {
        error: { code: "settlement.anchor.missing", message: "Manual settlement has no chapter anchor", ordinal: 1 },
        current: item(1, "awaiting_decision", { changeSetId: "ccs-2" }),
        message: "As mudanças da história deste capítulo não podem ser ancoradas porque o manuscrito ou o capítulo da estrutura já não existe.",
        secondary: [],
      },
      {
        error: { code: "bible_backfill.unexpected", message: "canon entity vanished", ordinal: 1 },
        current: item(1, "awaiting_decision", { changeSetId: "ccs-2" }),
        message: "A conclusão encontrou um erro inesperado e parou aqui. O progresso está salvo: retome para tentar de novo, ou cancele.",
        secondary: ["Detalhes: canon entity vanished"],
      },
      {
        error: { code: "bible_backfill.brand_new", message: "Something new broke", ordinal: 1 },
        current: item(1, "awaiting_decision", { changeSetId: "ccs-2" }),
        message: "A conclusão parou por um motivo que não consegue descrever. Retome para tentar de novo, ou abra a execução para ver os detalhes.",
        secondary: ["Detalhes: Something new broke", "Código de erro: bible_backfill.brand_new"],
      },
    ];
    for (const entry of cases) {
      stubApi({
        current: () =>
          detail(
            job({ status: "awaiting_user", currentOrdinal: 1, error: entry.error }),
            [item(0, "applied"), entry.current, item(2, "pending")],
            entry.current.status === "failed" ? ["cancel", "skip_item", "retry_item"] : ["resume", "cancel", "skip_item"],
          ),
      });
      renderPanel();
      expect(await screen.findByText(entry.message)).toBeInTheDocument();
      for (const text of entry.secondary) expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.getByText("Parado · precisa da sua atenção")).toBeInTheDocument();
      const errorTexts = document.querySelectorAll(".bible-backfill__error-text");
      expect(errorTexts).toHaveLength(1);
      expect(errorTexts[0]!.textContent).not.toMatch(/[a-z]+[._][a-z_]+/);
      if (entry.error.code === "child.awaiting_user" || entry.error.code === "bible_backfill.unexpected") {
        expect(screen.getByRole("button", { name: "Retomar" })).toBeInTheDocument();
      }
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("paused state resumes, and cancelling asks for confirmation", async () => {
    let current = detail(job({ status: "paused", currentOrdinal: 1 }), [
      item(0, "applied"),
      item(1, "pending"),
      item(2, "pending"),
    ], ["resume", "cancel", "skip_item"]);
    const actions: Array<Record<string, unknown>> = [];
    stubApi({
      current: () => current,
      onAction: (body) => {
        actions.push(body);
        current =
          body.action === "cancel"
            ? detail(job({ status: "cancelled", currentOrdinal: null }), [
                item(0, "applied"),
                item(1, "pending"),
                item(2, "pending"),
              ])
            : current;
        return actionResponse(current);
      },
    });
    renderPanel();

    expect(await screen.findByText("Paused. Progress is saved; resume whenever you're ready.")).toBeInTheDocument();
    expect(screen.getByText("Paused · 1 of 3 chapters done")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(actions[0]).toEqual({ requestId: expect.any(String), action: "resume" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel completion" }));
    const dialog = screen.getByRole("alertdialog", { name: "Cancel completing the Story Bible?" });
    expect(within(dialog).getByText(/Changes already applied stay in the Story Bible/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, cancel" }));
    expect(await screen.findByRole("heading", { name: "Story Bible completion was cancelled" })).toBeInTheDocument();
    expect(actions[1]).toEqual({ requestId: expect.any(String), action: "cancel" });
  });

  it("completed state summarizes counts and points to the AI candidate panels", async () => {
    stubApi({
      current: () =>
        detail(
          job({ status: "completed", currentOrdinal: null }),
          [
            item(0, "applied"),
            item(1, "empty"),
            item(2, "skipped", { skipReason: "already_settled" }),
          ],
          [],
          { calls: 3, inputTokens: 21_000, outputTokens: 2_400, costUsd: 1.237 },
        ),
    });
    const onOpen = vi.fn();
    renderPanel({ onOpen });

    expect(await screen.findByRole("heading", { name: "Story Bible completion finished" })).toBeInTheDocument();
    expect(screen.getByText("Completed · 3 chapters")).toBeInTheDocument();
    expect(screen.getByText("Used: 3 model calls, 23.4K tokens, ~$1.24")).toBeInTheDocument();
    expect(screen.queryByText(/NARRATIVE_MODEL_PRICING_JSON/)).not.toBeInTheDocument();
    const results = screen.getByLabelText("Results");
    expect(within(results).getByText("Applied").nextSibling).toHaveTextContent("1");
    expect(within(results).getByText("No changes").nextSibling).toHaveTextContent("1");
    expect(within(results).getByText("Skipped").nextSibling).toHaveTextContent("1");
    expect(screen.getByRole("heading", { name: "Fill in the rest of the Story Bible" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Suggest Entities with AI" }));
    expect(onOpen).toHaveBeenCalledWith("entities");
    expect(screen.getByRole("button", { name: "Run again" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Chapter progress · 3"));
    expect(screen.getByText("Already settled")).toBeInTheDocument();
    // Nothing imported is left unanchored, so no leftover note.
    expect(screen.queryByText(/still not anchored/)).not.toBeInTheDocument();
  });

  it("generates Intent, Entities and Outline on its own once a job started with them completes", async () => {
    window.localStorage.setItem("narralume:bible-backfill:sections:job-1", "1");
    const { calls } = stubApi({
      current: () =>
        detail(job({ status: "completed", currentOrdinal: null, mode: "auto_apply_stop_on_conflict" }), [
          item(0, "applied"),
          item(1, "applied"),
          item(2, "empty"),
        ]),
      extra: (url) =>
        /\/canon-spreads\/[a-z]+\/candidates$/.test(url)
          ? json({ runId: "run-spread", idempotentReplay: false }, 202)
          : null,
    });
    renderPanel();

    expect(
      await screen.findByText(/Intent, Entities and Outline suggestions are being generated/),
    ).toBeInTheDocument();
    const spreads = calls.filter((call) => call.method === "POST" && call.url.includes("/canon-spreads/"));
    expect(spreads.map((call) => call.url)).toEqual([
      "/api/projects/p-1/canon-spreads/intent/candidates",
      "/api/projects/p-1/canon-spreads/entities/candidates",
      "/api/projects/p-1/canon-spreads/outline/candidates",
    ]);
    for (const call of spreads) {
      expect(call.body).toEqual({
        requestId: expect.any(String),
        instruction: expect.stringContaining("whole finished manuscript"),
      });
    }
    expect(window.localStorage.getItem("narralume:bible-backfill:sections:job-1")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Generate Intent, Entities & Outline with AI" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suggest Outline with AI" })).toBeInTheDocument();
  });

  it("starts the section suggestions from the button and treats one already running as started", async () => {
    const { calls } = stubApi({
      current: () =>
        detail(job({ status: "completed", currentOrdinal: null }), [item(0, "applied")]),
      extra: (url) =>
        url.endsWith("/canon-spreads/entities/candidates")
          ? json(
              {
                error: {
                  code: "canon_candidate.active_run_exists",
                  message: "Already running",
                  requestId: "req-1",
                },
              },
              409,
            )
          : /\/canon-spreads\/[a-z]+\/candidates$/.test(url)
            ? json({ runId: "run-spread", idempotentReplay: false }, 202)
            : null,
    });
    renderPanel();

    // No stored intention: nothing starts until the author asks.
    const generate = await screen.findByRole("button", {
      name: "Generate Intent, Entities & Outline with AI",
    });
    expect(calls.some((call) => call.url.includes("/canon-spreads/"))).toBe(false);
    fireEvent.click(generate);

    expect(
      await screen.findByText(/Intent, Entities and Outline suggestions are being generated/),
    ).toBeInTheDocument();
    expect(calls.filter((call) => call.url.includes("/canon-spreads/"))).toHaveLength(3);
    expect(screen.queryByText(/could not be started/)).not.toBeInTheDocument();
  });

  it("re-reads a settled chapter through a single-chapter job", async () => {
    let current = detail(job({ status: "completed", currentOrdinal: null }), [
      item(0, "applied"),
      item(1, "empty"),
      item(2, "awaiting_decision"),
    ]);
    const { calls } = stubApi({
      current: () => current,
      onStart: () => {
        current = detail(
          job({ id: "job-2", status: "running", currentOrdinal: 0 }),
          [item(0, "settling", { note: { code: "bible_backfill.item.reread", reread: true } })],
          ["pause", "cancel"],
        );
        return json({ ...current, idempotentReplay: false }, 202);
      },
    });
    renderPanel();

    fireEvent.click(await screen.findByText("Chapter progress · 3"));
    // A chapter still awaiting a decision is not offered for a re-read.
    expect(screen.queryByRole("button", { name: "Re-read Chapter Three" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-read Chapter One" }));

    const dialog = screen.getByRole("alertdialog", { name: "Re-read “Chapter One”?" });
    expect(within(dialog).getByText(/adds what is missing and corrects what is wrong/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Review the changes before applying them" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "Re-read chapter" }));

    expect(await screen.findByText(/Read again at your request/)).toBeInTheDocument();
    const start = calls.find((call) => call.method === "POST" && call.url.endsWith("/bible-backfills"));
    expect(start?.body).toEqual({
      requestId: expect.any(String),
      mode: "review_each",
      chapterIds: ["node-1"],
      rereadSettled: true,
    });
  });

  it.each([
    {
      locale: "en" as const,
      text: "Imported timeline events still not anchored to a chapter: 12. No settled chapter showed them happening (for example, backstory the prose only mentions). They stay in the Timeline section, where you can place or remove them.",
    },
    {
      locale: "pt-BR" as const,
      text: "Eventos da linha do tempo importados ainda sem âncora num capítulo: 12. Nenhum capítulo acertado mostrou que eles acontecem (por exemplo, um passado que a prosa só menciona). Eles permanecem na seção Linha do tempo, onde você pode colocá-los ou removê-los.",
    },
  ])(
    "tells the author at completion how many imported events stay unanchored ($locale)",
    async ({ locale, text }) => {
      setLocale(locale);
      stubApi({
        current: () => ({
          ...detail(job({ status: "completed", currentOrdinal: null }), [
            item(0, "applied"),
          ]),
          unanchoredImportedEvents: 12,
        }),
      });
      renderPanel();
      expect(await screen.findByText(text)).toBeInTheDocument();
    },
  );

  it("refetches progress when a bible_backfill.status event arrives", async () => {
    vi.stubGlobal("EventSource", EventSourceStub);
    let current = detail(job({ currentOrdinal: 0 }), [
      item(0, "settling", { runId: "run-1" }),
      item(1, "pending"),
    ], ["pause", "cancel"]);
    stubApi({ current: () => current });
    renderPanel();

    expect(await screen.findByText("Reading chapter 1 of 2: Chapter One")).toBeInTheDocument();
    current = detail(job({ currentOrdinal: 1 }), [
      item(0, "empty"),
      item(1, "settling", { runId: "run-2" }),
    ], ["pause", "cancel"]);
    act(() => {
      EventSourceStub.current?.emit("bible_backfill.status", {
        type: "bible_backfill.status",
        projectId: "p-1",
        jobId: "job-1",
        status: "running",
        action: "item.empty",
      });
    });
    expect(await screen.findByText("Reading chapter 2 of 2: Chapter Two")).toBeInTheDocument();
  });

  it("stays collapsed for projects that never ran it without chapter manuscripts", async () => {
    stubApi({ current: () => EMPTY });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BibleBackfillPanel
            projectId="p-1"
            bible={{ ...BIBLE, documents: [] }}
            onOpenCandidateDesk={() => undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Not started")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Show/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Generate full Story Bible" })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText("It will process every imported chapter that has manuscript text.")).toBeInTheDocument();
  });
});

describe("Story Bible completion around mid-job edits and author canon", () => {
  const currentCalls = (calls: Recorded[]) =>
    calls.filter((call) => call.url === "/api/projects/p-1/bible-backfills/current").length;

  it("polls only while it is reading, and relies on events while it waits", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const running = detail(job({ currentOrdinal: 1 }), [
        item(0, "applied"),
        item(1, "settling", { runId: "run-2" }),
        item(2, "pending"),
      ], ["pause", "cancel", "skip_item"]);
      let current = running;
      const { calls } = stubApi({ current: () => current });
      renderPanel();
      expect(await screen.findByText("Reading chapter 2 of 3: Chapter Two")).toBeInTheDocument();
      const before = currentCalls(calls);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(currentCalls(calls)).toBeGreaterThan(before);
      cleanup();

      for (const status of ["paused", "awaiting_user", "awaiting_decision"] as const) {
        current = detail(job({ status, currentOrdinal: 1 }), [
          item(0, "applied"),
          item(1, status === "paused" ? "pending" : "awaiting_decision", { changeSetId: "ccs-2" }),
          item(2, "pending"),
        ], ["resume", "cancel", "skip_item"]);
        const waiting = stubApi({ current: () => current, changeSets: () => [CHANGE_SET] });
        renderPanel();
        await screen.findByText(
          status === "paused"
            ? "Paused. Progress is saved; resume whenever you're ready."
            : status === "awaiting_user"
              ? "Stopped · needs your attention"
              : "Waiting for your review of chapter 2",
        );
        const settled = currentCalls(waiting.calls);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(currentCalls(waiting.calls)).toBe(settled);
        cleanup();
        vi.unstubAllGlobals();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops auto-apply for review of records it did not create, then resumes after the decision", async () => {
    let current = detail(
      job({
        status: "awaiting_user",
        mode: "auto_apply_stop_on_conflict",
        currentOrdinal: 1,
        error: {
          code: "bible_backfill.review_required",
          message: "This chapter would change existing Story Bible records",
          ordinal: 1,
          changeSetId: "ccs-2",
          targets: [
            { path: "factCandidates.0", kind: "fact", action: "supersede", id: "f-1", label: "Shen Yan · role: postman" },
            { path: "foreshadowCandidates.0", kind: "foreshadow", action: "resolve", id: "fs-1", label: "Blank letter" },
            { path: "foreshadowCandidates.1", kind: "foreshadow", action: "develop", id: "fs-2", label: "Lamp key", reopens: true },
            { path: "foreshadowCandidates.2", kind: "foreshadow", action: "develop", id: "fs-3", label: "Tide bell" },
          ],
        },
      }),
      [
        item(0, "applied"),
        item(1, "awaiting_decision", { runId: "run-2", changeSetId: "ccs-2" }),
        item(2, "pending"),
      ],
      ["resume", "cancel", "skip_item"],
    );
    const { calls } = stubApi({
      current: () => current,
      changeSets: () => [CHANGE_SET],
      onDecision: () => json({ changeSet: { ...CHANGE_SET, status: "applied" } }),
      onAction: () => {
        current = detail(job({ status: "running", mode: "auto_apply_stop_on_conflict", currentOrdinal: 2 }), [
          item(0, "applied"),
          item(1, "applied"),
          item(2, "settling"),
        ], ["pause", "cancel"]);
        return actionResponse(current);
      },
    });
    renderPanel();

    expect(
      await screen.findByRole("heading", { name: "Chapter 2 would change records this completion didn't create" }),
    ).toBeInTheDocument();
    const targets = screen.getByRole("list", { name: "Existing records this chapter would change" });
    expect(within(targets).getByText("Replace fact")).toBeInTheDocument();
    expect(within(targets).getByText(/Shen Yan · role: postman/)).toBeInTheDocument();
    expect(within(targets).getByText("Resolve foreshadow")).toBeInTheDocument();
    expect(within(targets).getByText("Reopen foreshadow").parentElement).toHaveTextContent("Lamp key");
    expect(within(targets).getByText("Develop foreshadow").parentElement).toHaveTextContent("Tide bell");
    expect(screen.queryByRole("button", { name: "Force apply & continue" })).not.toBeInTheDocument();
    expect(screen.getByText(/this chapter's change set stays undecided in Studio/)).toBeInTheDocument();
    const apply = await screen.findByRole("button", { name: "Apply & continue" });
    // Resuming before the decision would only stop again: the panel asks for the decision instead.
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.getByText(/Resume isn't needed here: apply or reject this chapter's changes/)).toBeInTheDocument();
    fireEvent.click(apply);

    expect(await screen.findByText("Reading chapter 3 of 3: Chapter Three")).toBeInTheDocument();
    const decision = calls.find((call) => call.url.endsWith("/decisions"));
    expect(decision?.body).toMatchObject({ action: "apply", conflictPolicy: "reject" });
    const resume = calls.find((call) => call.url.endsWith("/job-1/actions"));
    expect(resume?.body).toEqual({ requestId: expect.any(String), action: "resume" });
    expect(calls.indexOf(decision!)).toBeLessThan(calls.indexOf(resume!));
  });

  it.each([
    {
      locale: "en" as const,
      action: "Anchor timeline event to this chapter",
      anchorLabel: "Timeline · anchor",
      anchorText: "Anchor the existing event “Helena chega a Vila do Sal” to this chapter; no new event is created · story time: Outono · the event keeps its own description, participants, causes and visibility",
      newLabel: "Timeline",
    },
    {
      locale: "pt-BR" as const,
      action: "Ancorar evento da linha do tempo neste capítulo",
      anchorLabel: "Linha do tempo · âncora",
      anchorText: "Ancorar o evento existente “Helena chega a Vila do Sal” a este capítulo; nenhum evento novo é criado · tempo da história: Outono · o evento mantém a própria descrição, participantes, causas e visibilidade",
      newLabel: "Linha do tempo",
    },
  ])(
    "shows an anchored timeline event as adopting the existing event ($locale)",
    async ({ locale, action, anchorLabel, anchorText, newLabel }) => {
      setLocale(locale);
      stubApi({
        current: () =>
          detail(
            job({
              status: "awaiting_user",
              mode: "auto_apply_stop_on_conflict",
              currentOrdinal: 1,
              error: {
                code: "bible_backfill.review_required",
                ordinal: 1,
                changeSetId: "ccs-2",
                targets: [
                  {
                    path: "timelineCandidates.0",
                    kind: "timeline",
                    action: "anchor",
                    id: "event-1",
                    label: "Helena chega a Vila do Sal",
                  },
                ],
              },
            }),
            [
              item(0, "applied"),
              item(1, "awaiting_decision", { runId: "run-2", changeSetId: "ccs-2" }),
              item(2, "pending"),
            ],
            ["cancel", "skip_item"],
          ),
        changeSets: () => [
          {
            ...CHANGE_SET,
            changes: {
              summary: "Helena chega a Vila do Sal",
              timelineCandidates: [
                {
                  anchorEventId: "event-1",
                  title: "Helena chega a Vila do Sal",
                  description: null,
                  storyTime: "Outono",
                },
                {
                  anchorEventId: null,
                  title: "O farol é vendido",
                  description: "A dona da pensão conta.",
                  storyTime: null,
                },
              ],
            },
          },
        ],
      });
      renderPanel();

      expect(await screen.findByText(action)).toBeInTheDocument();
      expect(screen.getByText(action).parentElement).toHaveTextContent("Helena chega a Vila do Sal");
      const anchored = await screen.findByText(anchorText);
      expect(anchored.parentElement).toHaveTextContent(anchorLabel);
      const created = screen.getByText("O farol é vendido · A dona da pensão conta.");
      expect(created.previousElementSibling).toHaveTextContent(new RegExp(`^${newLabel}$`, "u"));
    },
  );

  it("offers Resume on a review stop once the change set was decided elsewhere", async () => {
    stubApi({
      current: () =>
        detail(
          job({
            status: "awaiting_user",
            mode: "auto_apply_stop_on_conflict",
            currentOrdinal: 1,
            error: { code: "bible_backfill.review_required", ordinal: 1, changeSetId: "ccs-2", targets: [] },
          }),
          [item(0, "applied"), item(1, "awaiting_decision", { changeSetId: "ccs-2" }), item(2, "pending")],
          ["resume", "cancel", "skip_item"],
        ),
      changeSets: () => [{ ...CHANGE_SET, status: "rejected", decidedAt: NOW }],
    });
    renderPanel();

    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByText(/Resume isn't needed here/)).not.toBeInTheDocument();
  });

  it("explains review stops, re-targeted chapters and the Studio change sets they leave in Chinese", async () => {
    setLocale("pt-BR");
    stubApi({
      current: () =>
        detail(
          job({
            status: "awaiting_user",
            mode: "auto_apply_stop_on_conflict",
            currentOrdinal: 1,
            error: {
              code: "bible_backfill.review_required",
              ordinal: 1,
              changeSetId: "ccs-2",
              targets: [{ path: "factCandidates.0", kind: "fact", action: "withdraw", id: "f-1", label: "沈焰 · 身份: 邮差" }],
            },
          }),
          [
            item(0, "applied", {
              note: {
                code: "bible_backfill.item.retargeted",
                retargetedFromVersionId: "ver-0",
                supersededChangeSetId: "ccs-old",
              },
            }),
            item(1, "awaiting_decision", { changeSetId: "ccs-2" }),
            item(2, "pending"),
          ],
          ["resume", "cancel", "skip_item"],
        ),
      changeSets: () => [CHANGE_SET],
    });
    renderPanel();

    expect(await screen.findByRole("heading", { name: "O capítulo 2 mudaria registros que esta conclusão não criou" })).toBeInTheDocument();
    expect(screen.getByText("Retirar fato")).toBeInTheDocument();
    expect(
      screen.getByText("Editado durante a conclusão; o texto mais recente é lido. O conjunto de mudanças do texto anterior permanece indeciso no painel “Mudanças da história” da mesa de escrita."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Pular só faz a conclusão avançar/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("bible_backfill.review_required");
  });

  it("tells the author a skipped review chapter stays reviewable in Studio", async () => {
    stubApi({
      current: () =>
        detail(job({ status: "awaiting_decision", currentOrdinal: 1 }), [
          item(0, "applied"),
          item(1, "awaiting_decision", { runId: "run-2", changeSetId: "ccs-2" }),
          item(2, "pending"),
        ], ["pause", "cancel", "skip_item"]),
      changeSets: () => [CHANGE_SET],
    });
    renderPanel();

    expect(await screen.findByRole("button", { name: "Skip chapter" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Skipping only moves the completion on: this chapter's change set stays undecided in Studio's “Story changes” panel, where you can still apply or reject it.",
      ),
    ).toBeInTheDocument();
  });

  it("records adopted, detached and handed-back settlements and chapters left for review", async () => {
    stubApi({
      current: () =>
        detail(job({ status: "cancelled", currentOrdinal: null }), [
          item(0, "awaiting_decision", {
            changeSetId: "ccs-1",
            note: {
              code: "bible_backfill.item.adopted",
              adoptedRunId: "run-w",
              adoptedChangeSetId: "ccs-1",
              adoptedOutcome: "candidate",
            },
          }),
          item(1, "pending", {
            note: { code: "bible_backfill.item.detached", detachedRunId: "run-s" },
          }),
          item(2, "pending", {
            note: {
              code: "bible_backfill.item.handed_back",
              retargetedFromVersionId: "ver-0",
              handedBackRunId: "run-h",
            },
          }),
        ]),
    });
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Story Bible completion was cancelled" })).toBeInTheDocument();
    const results = screen.getByLabelText("Results");
    expect(within(results).getByText("Left for review in Studio").nextSibling).toHaveTextContent("1");
    fireEvent.click(screen.getByText("Chapter progress · 3"));
    expect(screen.getByText("Uses the change set Studio already produced for this text.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Its Studio settlement continues on its own (follow it in the Run Center); the result appears in Studio's “Story changes” panel.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/its latest text is settled in Studio instead/)).toBeInTheDocument();
    expect(screen.queryByText(/the latest text is read/)).not.toBeInTheDocument();
  });

  it("shows a cancelled job's chapter as decided once Studio decided its change set", async () => {
    stubApi({
      current: () =>
        detail(job({ status: "cancelled", currentOrdinal: null }), [
          item(0, "applied"),
          item(1, "awaiting_decision", { changeSetId: "ccs-2" }),
          item(2, "pending"),
        ]),
    });
    renderPanel({ cachedChangeSets: [{ ...CHANGE_SET, status: "applied", decidedAt: NOW }] });

    expect(await screen.findByRole("heading", { name: "Story Bible completion was cancelled" })).toBeInTheDocument();
    const results = screen.getByLabelText("Results");
    expect(within(results).queryByText("Left for review in Studio")).not.toBeInTheDocument();
    expect(within(results).getByText("Applied").nextSibling).toHaveTextContent("2");
    fireEvent.click(screen.getByText("Chapter progress · 3"));
    expect(screen.queryByText("Needs review")).not.toBeInTheDocument();
  });
});

describe("Story Bible workspace", () => {
  it("opens the completion panel from ?backfill=open and switches to a section's AI candidate panel", async () => {
    stubApi({
      current: () =>
        detail(job({ status: "completed", currentOrdinal: null }), [item(0, "applied")]),
      extra: (url) => {
        if (url === "/api/projects/p-1/story-bible") return json(BIBLE);
        if (url === "/api/projects/p-1/runs") return json([]);
        if (url.includes("/canon-spreads/") && url.endsWith("/candidates")) return json([]);
        return null;
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/projects/p-1/bible?spread=outline&view=board&backfill=open"]}>
          <Routes>
            <Route path="/projects/:projectId/bible" element={<BibleWorkspace />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const heading = await screen.findByRole("heading", { name: "Complete Story Bible from manuscript" });
    await waitFor(() => expect(heading).toHaveFocus());
    fireEvent.click(await screen.findByRole("button", { name: "Suggest Intent with AI" }));
    expect(screen.getByRole("button", { name: "View Intent" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Canon edit instruction" })).toHaveFocus(),
    );
  });
});
