// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/app/shell";
import { setLocale } from "../src/i18n";

// The workspace itself is not under test; keep its requests out of the fetch log.
vi.mock("../src/workspaces/overview", () => ({
  OverviewWorkspace: () => <p>overview</p>,
}));

const CONVERSATION = {
  id: "assistant-conversation-1",
  projectId: "project-1",
  title: "Conversa do projeto",
  status: "active",
  settings: { modelId: null, reasoningEffort: null },
  createdAt: "2026-08-13T01:00:00.000Z",
  updatedAt: "2026-08-13T01:03:00.000Z",
};

class EventSourceStub {
  close = vi.fn();
  addEventListener() {}
}

function json(value: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

let requests: string[] = [];

function renderShell() {
  window.history.pushState({}, "", "/projects/project-1/overview");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppShell />
    </QueryClientProvider>,
  );
}

const assistantRequests = () => requests.filter((url) => url.includes("/assistant/"));

beforeEach(() => {
  setLocale("pt-BR");
  window.localStorage.clear();
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  requests = [];
  vi.stubGlobal("EventSource", EventSourceStub);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/health") {
        return json({ status: "ok", service: "lapis", version: "0.2.0", database: { status: "ready", migration: 1 }, now: "2026-08-13T01:00:00.000Z" });
      }
      if (url === "/api/projects/project-1/assistant/conversations") return json([CONVERSATION]);
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json({ conversation: CONVERSATION, messages: [], activities: [] });
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("壳层的协作侧栏与命令面板", () => {
  it("首屏只渲染协作入口；首次打开时才加载侧栏，关闭后入口回来", async () => {
    renderShell();
    expect(await screen.findByText("overview")).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "Abrir colaboração no projeto" });
    expect(screen.queryByRole("complementary", { name: "Colaboração no projeto" })).not.toBeInTheDocument();
    expect(assistantRequests()).toEqual([]);

    fireEvent.click(trigger);
    expect(await screen.findByRole("complementary", { name: "Colaboração no projeto" })).toBeInTheDocument();
    expect(window.localStorage.getItem("lapis:assistant-open")).toBe("1");

    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(screen.queryByRole("complementary", { name: "Colaboração no projeto" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir colaboração no projeto" })).toBeInTheDocument();
    expect(window.localStorage.getItem("lapis:assistant-open")).toBe("0");
  });

  it("上次保持打开时，载入后直接显示侧栏", async () => {
    window.localStorage.setItem("lapis:assistant-open", "1");
    renderShell();

    expect(await screen.findByRole("complementary", { name: "Colaboração no projeto" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir colaboração no projeto" })).not.toBeInTheDocument();
  });

  it("⌘J 在首次加载前也能打开侧栏", async () => {
    renderShell();
    expect(await screen.findByText("overview")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(await screen.findByRole("complementary", { name: "Colaboração no projeto" })).toBeInTheDocument();
  });

  it("命令面板经快捷键或按钮打开", async () => {
    renderShell();
    expect(await screen.findByText("overview")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Paleta de comandos" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Buscar comandos" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Fechar paleta de comandos" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Rail and top bar each carry the button.
    fireEvent.click(screen.getAllByRole("button", { name: "Paleta de comandos (⌘K)" })[0]!);
    expect(await screen.findByRole("dialog", { name: "Paleta de comandos" })).toBeInTheDocument();
  });
});
