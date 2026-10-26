// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { OverviewWorkspace } from "../src/workspaces/overview";

/* 项目概览：刊头（书名 / 卷首语 / 进度注记）+ 当前章节卡 + 下一步入口。
   数据源为服务端 overview 聚合契约。 */

const OVERVIEW = {
  project: {
    id: "p-1-tides",
    title: "潮汐灯塔",
    subtitle: null,
    premise: "O porto esquece uma pessoa por ano.",
    language: "pt-BR",
    phase: "writing",
    archivedAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
  progress: {
    lastWritingAt: "2026-08-10T10:00:00.000Z",
    wordCount: 12_345,
    committedChapters: 1,
    totalChapters: 2,
  },
  currentChapter: {
    outlineNodeId: "n-ch-2",
    title: "第二章 回声邮局",
    status: "planned",
    documentId: null,
    documentVersionId: null,
  },
  activeTask: null,
  pending: {
    foundationCandidates: 0,
    reviewIssues: 0,
    revisionProposals: 0,
    canonChangeSets: 0,
  },
  nextAction: { kind: "write_chapter", targetId: "n-ch-2" },
};

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderOverview(entry = "/projects/p-1-tides/overview") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/projects/:projectId/overview" element={<OverviewWorkspace />} />
          <Route path="/missing" element={<OverviewWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((queryText: string) => ({
      matches: true,
      media: queryText,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  window.localStorage.clear();setLocale("pt-BR");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Visão geral do projeto", () => {
  it("渲染刊头、当前章节与下一步入口", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1-tides/overview") return json(OVERVIEW);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderOverview();

    await screen.findByRole("heading", { name: "潮汐灯塔" });
    expect(screen.getByText("O porto esquece uma pessoa por ano.")).toBeInTheDocument();
    expect(screen.getByText("VISÃO · 02")).toBeInTheDocument();
    expect(
      screen.getByText("1 registrado · 2 capítulos · 12345 caracteres"),
    ).toBeInTheDocument();

    expect(screen.getByText("Capítulo atual")).toBeInTheDocument();
    expect(screen.getByText("第二章 回声邮局")).toBeInTheDocument();

    expect(
      screen.getByRole("link", { name: "Continuar este capítulo na mesa de escrita" }),
    ).toHaveAttribute("href", "/projects/p-1-tides/studio?outline=n-ch-2");
    expect(screen.getByText("Continuar a escrever")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Organizar a história" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Criação rápida com IA" })).toBeInTheDocument();
  });

  it("全部章节定稿时提示走交付", async () => {
    const allCommitted = {
      ...OVERVIEW,
      currentChapter: null,
      nextAction: { kind: "complete", targetId: null },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1-tides/overview") return json(allCommitted);
        throw new Error(`unexpected request ${url}`);
      }),
    );
    renderOverview();

    await screen.findByText("Todos os capítulos estão registrados; próximo passo: conferir e entregar.");
  });

  it("定稿后有审稿待办时说明真实下一步，并直达对应正文", async () => {
    const needsReview = {
      ...OVERVIEW,
      currentChapter: null,
      progress: { ...OVERVIEW.progress, committedChapters: 2 },
      pending: {
        ...OVERVIEW.pending,
        reviewIssues: 3,
        reviewDocumentId: "document-under-review",
      },
      nextAction: { kind: "review_writing", targetId: "report-1" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1-tides/overview") return json(needsReview);
        throw new Error(`unexpected request ${url}`);
      }),
    );
    renderOverview();

    await screen.findByText("Há capítulos registrados; próximo passo: tratar revisão e reescritas.");
    expect(screen.getByRole("link", { name: "Pontos de revisão · 3" })).toHaveAttribute(
      "href",
      "/projects/p-1-tides/studio?focus=review&document=document-under-review",
    );
    expect(screen.getByRole("link", { name: "Tratar revisão e reescritas" })).toHaveAttribute(
      "href",
      "/projects/p-1-tides/studio?focus=review&document=document-under-review",
    );
  });

  it("pending strip marks each link with its kind so the CSS can tell findings from AI candidates", async () => {
    const withPending = {
      ...OVERVIEW,
      pending: { ...OVERVIEW.pending, reviewIssues: 2, revisionProposals: 1 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1-tides/overview") return json(withPending);
        throw new Error(`unexpected request ${url}`);
      }),
    );
    renderOverview();

    expect(await screen.findByRole("link", { name: "Pontos de revisão · 2" })).toHaveAttribute("data-kind", "issues");
    expect(screen.getByRole("link", { name: "Propostas de reescrita · 1" })).toHaveAttribute("data-kind", "proposals");
  });

  it("活跃任务卡只呈现任务协议字段并给出回到任务现场链接", async () => {
    const withTask = {
      ...OVERVIEW,
      activeTask: {
        kind: "chapter",
        id: "run-abc",
        status: "awaiting_user",
        targetChapter: {
          outlineNodeId: "n-ch-2",
          title: "第二章 回声邮局",
          status: "drafting",
          documentId: "d-1",
          documentVersionId: "v-1",
        },
        origin: { surface: "studio" },
        stopReason: "chapter_commit_approval_required",
        availableActions: ["accept_manuscript", "request_revision", "cancel"],
      },
      nextAction: { kind: "continue_task", targetId: "run-abc" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1-tides/overview") return json(withTask);
        throw new Error(`unexpected request ${url}`);
      }),
    );
    renderOverview();

    await screen.findByText("Tarefa ativa · Tarefa de um capítulo");
    expect(screen.getByText("第二章 回声邮局")).toBeInTheDocument();
    expect(screen.getByText("Manuscrito candidato aguardando adoção")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancelar/ })).toBeInTheDocument();
    expect(screen.getByText("Esperando você")).toBeInTheDocument();
    const restore = screen.getByRole("link", { name: "Voltar à tarefa" });
    expect(restore).toHaveAttribute(
      "href",
      "/projects/p-1-tides/studio?run=run-abc&document=d-1",
    );
    expect(restore).toHaveTextContent("Tratar candidatos e decisões");
  });

  it("活动任务的暂停动作是真实按钮，并调用统一任务动作接口", async () => {
    const withTask = {
      ...OVERVIEW,
      activeTask: {
        kind: "chapter",
        id: "run-live",
        status: "running",
        targetChapter: { ...OVERVIEW.currentChapter, documentId: "d-2" },
        origin: { surface: "writing", documentId: "d-2" },
        stopReason: null,
        availableActions: ["pause", "cancel"],
      },
      nextAction: { kind: "continue_task", targetId: "run-live" },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1-tides/overview") return json(withTask);
      if (url === "/api/runs/run-live/actions" && init?.method === "POST") return json({ run: { id: "run-live", status: "paused" }, steps: [], events: [], latestCheckpoint: null });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderOverview();

    fireEvent.click(await screen.findByRole("button", { name: "Pausar" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/runs/run-live/actions")).toBe(true));
    const call = fetchMock.mock.calls.find(([url]) => String(url) === "/api/runs/run-live/actions");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ action: "pause", projectId: "p-1-tides" });
  });

  it("AI 建书后台任务返回故事方向，不再误入写作台", async () => {
    const withFoundation = {
      ...OVERVIEW,
      activeTask: {
        kind: "foundation",
        id: "run-foundation",
        status: "failed_recoverable",
        targetChapter: null,
        origin: { surface: "autopilot" },
        stopReason: "request_start_timeout",
        availableActions: ["cancel"],
      },
      nextAction: { kind: "continue_task", targetId: "run-foundation" },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/projects/p-1-tides/overview") return json(withFoundation);
      throw new Error(`unexpected request ${String(input)}`);
    }));
    renderOverview();

    await screen.findByText("Tarefa ativa · Fundação guiada por IA");
    expect(screen.getByText("Aguardando nova tentativa automática")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar à tarefa" })).toHaveAttribute(
      "href",
      "/projects/p-1-tides/autopilot?foundation=run-foundation",
    );
  });

  it("未选择作品时给出空态且不拉取 overview", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderOverview("/missing");

    expect(screen.getByRole("heading", { name: "Visão geral do projeto" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar à estante" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("轮询切换活动任务后，为旧任务打开的取消确认随之关闭", async () => {
    vi.useFakeTimers();
    const taskA = {
      kind: "chapter",
      id: "run-a",
      status: "running",
      targetChapter: { ...OVERVIEW.currentChapter, documentId: "d-a" },
      origin: { surface: "writing", documentId: "d-a" },
      stopReason: null,
      availableActions: ["pause", "cancel"],
    };
    const taskB = {
      ...taskA,
      id: "run-b",
      targetChapter: { ...OVERVIEW.currentChapter, title: "第三章 灯骸", documentId: "d-b" },
    };
    let active: typeof taskA | null = taskA;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1-tides/overview") {
        return json({ ...OVERVIEW, activeTask: active, nextAction: { kind: "continue_task", targetId: active?.id ?? null } });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderOverview();

    await vi.waitFor(() => expect(screen.queryByText("Tarefa ativa · Tarefa de um capítulo")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    /* 3 秒轮询后活动任务从 A 换成 B：确认框必须随任务 A 一起消失 */
    active = taskB;
    await vi.advanceTimersByTimeAsync(3_100);
    await vi.waitFor(() => expect(screen.queryByText("第三章 灯骸")).not.toBeNull());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/actions")).length).toBe(0);
  });
});
