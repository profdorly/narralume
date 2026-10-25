// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { LabWorkspace } from "../src/workspaces/lab";

/* 长篇推演：语义检索、剧情预测、故事记忆与影响预演。 */

const PREDICTIONS = [
  {
    id: "pp-1",
    projectId: "p-1",
    title: "姐姐的失踪与旧邮局刚开张时被拆掉的人为道迹也许有互证关系。",
    horizon: 3,
    summary: "基于第三章灯下潮痕的缝隙，姐姐消失前至少两次回邮局。",
    impact: ["第一章 灯下潮痕"],
    risks: ["与第 1 章 timeline 相逢不足"],
    uncertainty: 0.42,
    contextFingerprint: "fp-1",
    status: "candidate",
    stale: false,
    sourceIds: [],
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
];

const MEMORIES = [
  {
    id: "m-1",
    projectId: "p-1",
    layer: "episodic",
    scopeType: "project",
    scopeId: "p-1",
    title: "姐姐回邮局的两次证据",
    content: "第三章stamp、preface的按需印。",
    stateDelta: {},
    sourceHash: "sha-1",
    status: "active",
    refreshedAt: "2026-08-10T10:00:00.000Z",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
];

const HITS = [
  {
    id: "h-1",
    projectId: "p-1",
    sourceType: "document",
    sourceId: "doc-1",
    title: "第一章 灯下潮痕",
    content: "第3章起邮局名字以风铃物证验证 姐姐消失前",
    authority: "confirmed",
    metadata: {},
    entityIds: [],
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    lexicalRank: 1,
    vectorRank: 0.8,
    entityScore: 0.6,
    vectorScore: 0.8,
    rerankScore: null,
    score: 0.82,
    reasons: ["fts", "vector"],
  },
];

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderLab(entry = "/projects/p-1/lab") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/projects/:projectId/lab" element={<LabWorkspace />} />
          <Route path="/missing" element={<LabWorkspace />} />
          <Route path="/shelf" element={<p>已入馆：藏书室</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLocale("pt-BR");
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
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Simulação de longo fôlego", () => {
  it("语义检索可提交问题并展示原文；剧情预测和故事记忆有卡", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions") return json(PREDICTIONS);
      if (url.startsWith("/api/projects/p-1/memories")) return json(MEMORIES);
      if (url === "/api/projects/p-1/retrieval/search")
        return json(HITS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    // 检索投
    fireEvent.change(screen.getByLabelText("Pergunta de busca"), {
      target: { value: "姐姐什么时候消失" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await screen.findByText(/第一章 灯下潮痕/);
    expect(screen.getByText(/score 82%/)).toBeInTheDocument();

    // 预测单
    await screen.findByText(/姐姐的失踪与旧邮局/);
    expect(screen.getByText("Previsões de enredo")).toBeInTheDocument();
    expect(screen.getByText("+3 capítulos à frente")).toBeInTheDocument();
    expect(screen.getByText(/基于第三章灯下潮痕的缝隙/)).toBeInTheDocument();

    // 故事记忆
    await screen.findByText("EPISODIC");
    expect(screen.getByText(/第三章stamp、preface的按需印/)).toBeInTheDocument();
    expect(screen.getByLabelText("Capítulos à frente")).toHaveAttribute("max", "20");
    expect(screen.getByLabelText("Quantidade de candidatos")).toHaveAttribute("max", "5");
  });

  it("记忆查询失败时显示故障，不伪装成空仓", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions") return json([]);
      if (url.startsWith("/api/projects/p-1/memories")) {
        return json(
          { error: { code: "storage.unavailable", message: "memory unavailable" } },
          500,
        );
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    expect(await screen.findByText("Não foi possível carregar as memórias agora")).toBeInTheDocument();
    expect(screen.queryByText("Ainda não há memórias guardadas")).not.toBeInTheDocument();
  });

  it("采纳预测调 PUT /predictions/:id；body 与决策一致，不含 profileId", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions") return json(PREDICTIONS);
      if (url.startsWith("/api/projects/p-1/memories")) return json(MEMORIES);
      if (url === "/api/projects/p-1/retrieval/search") return json(HITS);
      if (url.startsWith("/api/projects/p-1/predictions/pp-1"))
        return json({
          ...PREDICTIONS[0],
          status: "adopted",
          updatedAt: "2026-08-11T10:00:00.000Z",
        });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    await screen.findByText(/姐姐的失踪与旧邮局/);
    const adoptButtons = await screen.findAllByRole("button", { name: "Adotar" });
    fireEvent.click(adoptButtons[0]!);

    await screen.findByText(/Adotada ·/);
    const call = fetchMock.mock.calls.find(
      ([u, init]) =>
        String(u).includes("/api/projects/p-1/predictions/pp-1") &&
        init?.method === "PUT",
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.status).toBe("adopted");
    expect(body).not.toHaveProperty("profileId");
    expect(body).not.toHaveProperty("outputReserve");
  });

  it("故事状态变化后的预测显示失效且不能采纳", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions")
        return json([{ ...PREDICTIONS[0], stale: true }]);
      if (url.startsWith("/api/projects/p-1/memories")) return json(MEMORIES);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    await screen.findByText(/姐姐的失踪与旧邮局/);
    expect(screen.getByText("Desatualizada")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Adotar" }),
    ).not.toBeInTheDocument();
  });

  it("mostra o índice de busca e reindexa sob demanda", async () => {
    const status = {
      documents: 3,
      indexedDocuments: 2,
      passages: 12,
      legacySegments: 1,
      embeddedPassages: 4,
      embeddingModel: {
        id: "model-embed",
        modelId: "text-embedding-3-small",
        providerName: "OpenAI",
      },
      currentModelPassages: 4,
      models: [
        { model: "text-embedding-3-small", dimensions: 1536, segments: 4 },
      ],
    };
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/projects/p-1/predictions") return json([]);
        if (url.startsWith("/api/projects/p-1/memories")) return json([]);
        if (url === "/api/projects/p-1/retrieval/index") return json(status);
        if (
          url === "/api/projects/p-1/retrieval/reindex" &&
          init?.method === "POST"
        )
          return json({
            indexed: 1,
            relinked: 0,
            removed: 1,
            status: {
              ...status,
              indexedDocuments: 3,
              passages: 15,
              legacySegments: 0,
            },
          });
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    expect(
      await screen.findByText("text-embedding-3-small · OpenAI"),
    ).toBeInTheDocument();
    expect(screen.getByText("2 de 3")).toBeInTheDocument();
    expect(screen.getByText("4 de 12")).toBeInTheDocument();
    expect(
      screen.getByText(/Os vetores que faltam são gerados na próxima escrita/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 capítulo mudou/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reindexar agora" }));
    expect(
      await screen.findByText(/1 capítulo reindexado/),
    ).toBeInTheDocument();
    expect(screen.getByText("3 de 3")).toBeInTheDocument();
    expect(screen.queryByText(/desde a última indexação/)).not.toBeInTheDocument();
  });

  it("explica a busca sem modelo de embedding", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions") return json([]);
      if (url.startsWith("/api/projects/p-1/memories")) return json([]);
      if (url === "/api/projects/p-1/retrieval/index")
        return json({
          documents: 1,
          indexedDocuments: 1,
          passages: 3,
          legacySegments: 0,
          embeddedPassages: 0,
          embeddingModel: null,
          currentModelPassages: 0,
          models: [],
        });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    expect(await screen.findByText("Nenhum atribuído")).toBeInTheDocument();
    expect(
      screen.getByText(/Sem modelo de embedding, a busca usa palavras/),
    ).toBeInTheDocument();
  });

  it("无项目时不发请求，藏书室回回链接在", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab("/missing");

    expect(screen.getByRole("heading", { name: "Laboratório narrativo" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar à estante" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
