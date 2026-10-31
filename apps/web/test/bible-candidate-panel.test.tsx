// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { CanonCandidatePanel } from "../src/workspaces/bible/candidate-panel";

/* Canon candidate desk: the instruction text and startedRunId are bound to the
   Spread identity and remount on page switch. */

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderPanel(spread: "intent" | "outline") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CanonCandidatePanel projectId="p-1" spread={spread} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLocale("pt-BR");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Canon candidate desk", () => {
  it("all undecided candidates stay visible; finished history only adds the three most recent groups", async () => {
    const candidate = (index: number, status: "candidate" | "applied") => ({
      id: `set-${index}`,
      projectId: "p-1",
      runId: `run-${index}`,
      stepId: `step-${index}`,
      spread: "intent",
      instruction: `指示 ${index}`,
      summary: `候选组 ${index}`,
      baseFingerprint: `base-${index}`,
      currentFingerprint: `current-${index}`,
      stale: false,
      status,
      items: [],
      createdAt: `2026-08-${String(10 - index).padStart(2, "0")}T00:00:00.000Z`,
      decidedAt: status === "applied" ? "2026-08-11T00:00:00.000Z" : null,
    });
    const sets = [
      candidate(1, "applied"),
      candidate(2, "applied"),
      candidate(3, "applied"),
      candidate(4, "applied"),
      candidate(5, "candidate"),
      candidate(6, "candidate"),
      candidate(7, "candidate"),
      candidate(8, "candidate"),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1/canon-spreads/intent/candidates")
          return json(sets);
        if (url === "/api/projects/p-1/runs") return json([]);
        throw new Error(`unexpected request ${url}`);
      }),
    );
    renderPanel("intent");

    for (const index of [5, 6, 7, 8]) {
      expect(await screen.findByText(`候选组 ${index}`)).toBeInTheDocument();
    }
    expect(screen.getByText("候选组 1")).toBeInTheDocument();
    expect(screen.getByText("候选组 3")).toBeInTheDocument();
    expect(screen.queryByText("候选组 4")).not.toBeInTheDocument();
  });

  it("a recoverable failure still shows the active task and the automatic retry status", async () => {
    const recoverableRun = {
      id: "run-recoverable",
      projectId: "p-1",
      recipe: "canon-spread-candidate",
      recipeVersion: 1,
      mode: "manual",
      status: "failed_recoverable",
      targetOutlineNodeId: null,
      policy: { canonSpread: "intent" },
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 24_000,
        maxCalls: 6,
        maxCostUsd: null,
        maxWallTimeMs: 600_000,
      },
      budgetUsage: {
        inputTokens: 0,
        outputTokens: 0,
        calls: 1,
        costUsd: 0,
        wallTimeMs: 45_000,
      },
      revisionCycle: 0,
      pauseRequested: false,
      cancelRequested: false,
      currentStepId: null,
      startedAt: "2026-08-10T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:45.000Z",
      version: 2,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/canon-spreads/intent/candidates")
        return json([]);
      if (url === "/api/projects/p-1/runs") return json([recoverableRun]);
      if (url === "/api/runs/run-recoverable?projectId=p-1")
        return json({
          run: recoverableRun,
          steps: [],
          events: [],
          latestCheckpoint: null,
        });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPanel("intent");

    await screen.findByText("A IA está preparando candidatos para esta página");
    expect(
      screen.getByText("Esta resposta esgotou o tempo; o sistema espera uma tentativa automática. Você pode sair desta página."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Gerar mudanças candidatas" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhum candidato gerado")).not.toBeInTheDocument();
  });

  it("retrying the same instruction after a failure reuses the requestId; editing the instruction uses a new key", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url === "/api/projects/p-1/canon-spreads/intent/candidates" &&
        init?.method === "POST"
      ) {
        requestBodies.push(
          JSON.parse(String(init.body)) as Record<string, unknown>,
        );
        return Promise.reject(new Error("response lost"));
      }
      if (url === "/api/projects/p-1/canon-spreads/intent/candidates") {
        return json([]);
      }
      if (url === "/api/projects/p-1/runs") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPanel("intent");

    const input = await screen.findByLabelText("Instrução de edição do cânone");
    fireEvent.change(input, { target: { value: "强化结局代价" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar mudanças candidatas" }));
    await waitFor(() => expect(requestBodies).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Gerar mudanças candidatas" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Gerar mudanças candidatas" }));
    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]?.requestId).toBe(requestBodies[0]?.requestId);

    fireEvent.change(input, { target: { value: "强化结局的记忆代价" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar mudanças candidatas" }));
    await waitFor(() => expect(requestBodies).toHaveLength(3));
    expect(requestBodies[2]?.requestId).not.toBe(requestBodies[0]?.requestId);
  });

  it("switching Spread resets the unsubmitted instruction and the in-progress task notice", async () => {
    const runs = [
      {
        id: "run-intent",
        projectId: "p-1",
        recipe: "canon-spread-candidate",
        recipeVersion: 1,
        mode: "manual",
        status: "running",
        targetOutlineNodeId: null,
        policy: { canonSpread: "intent" },
        budgetLimit: { maxInputTokens: 100_000, maxOutputTokens: 24_000, maxCalls: 6, maxCostUsd: null, maxWallTimeMs: 600_000 },
        budgetUsage: { inputTokens: 0, outputTokens: 0, calls: 1, costUsd: 0, wallTimeMs: 45_000 },
        revisionCycle: 0,
        pauseRequested: false,
        cancelRequested: false,
        currentStepId: null,
        startedAt: "2026-08-10T10:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-08-10T10:00:00.000Z",
        updatedAt: "2026-08-10T10:00:45.000Z",
        version: 2,
      },
    ];
    const runDetail = {
      run: runs[0],
      steps: [],
      events: [],
      latestCheckpoint: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/canon-spreads/intent/candidates") return json([]);
      if (url === "/api/projects/p-1/canon-spreads/outline/candidates") return json([]);
      if (url === "/api/projects/p-1/runs") return json(runs);
      if (url === "/api/runs/run-intent?projectId=p-1") return json(runDetail);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = renderPanel("intent");

    /* intent page: type an instruction while an intent Run is in progress */
    fireEvent.change(screen.getByLabelText("Instrução de edição do cânone"), {
      target: { value: "写给意图页的指示" },
    });
    expect(screen.getByLabelText("Instrução de edição do cânone")).toHaveValue("写给意图页的指示");
    await screen.findByText("A IA está preparando candidatos para esta página");

    /* Switch to the outline page: neither the input nor the Run notice may leak
       over from the intent page */
    view.rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <MemoryRouter>
          <CanonCandidatePanel projectId="p-1" spread="outline" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByLabelText("Instrução de edição do cânone");
    expect(screen.getByLabelText("Instrução de edição do cânone")).toHaveValue("");
    expect(screen.queryByText("A IA está preparando candidatos para esta página")).not.toBeInTheDocument();
  });
});
