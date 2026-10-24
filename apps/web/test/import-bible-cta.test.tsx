// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import "./i18n-en";
import { ImportManager } from "../src/workspaces/delivery/production-tools";
import { ShelfWorkspace } from "../src/workspaces/shelf";

/* 导入应用成功后提供「用 AI 补全故事圣经」入口（藏书室对话框与交付台导入管理）。 */

const NOW = "2026-09-28T10:00:00.000Z";

function candidate(id: string, kind: string, title: string) {
  return {
    id,
    batchId: "batch-1",
    kind,
    ordinal: 0,
    title,
    payload: {},
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function importDetail(
  candidates: ReturnType<typeof candidate>[],
  status = "ready",
  targetProjectId: string | null = null,
) {
  return {
    batch: {
      id: "batch-1",
      targetProjectId,
      filename: "draft.md",
      format: "markdown",
      sourceHash: "hash",
      sourceCharacters: 1200,
      status,
      metadata: {},
      analysisRunId: null,
      appliedProjectId: status === "applied" ? "p-new" : null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    candidates,
  };
}

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function LocationProbe({ label }: { label: string }) {
  const location = useLocation();
  return (
    <p>
      {label}: {location.pathname}
      {location.search}
    </p>
  );
}

beforeEach(() => {
  setLocale("en");
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

function stubShelfImport(detail: ReturnType<typeof importDetail>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/projects")) return json([]);
    if (url === "/api/imports/preview") return json(detail, 201);
    if (url === "/api/imports/batch-1/actions" && init?.method === "POST")
      return json({ projectId: "p-new", detail: { ...detail, batch: { ...detail.batch, status: "applied" } } });
    return json({ error: { code: "route.not_found", message: `unexpected ${url}` } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderShelf() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/shelf"]}>
        <Routes>
          <Route path="/shelf" element={<ShelfWorkspace />} />
          <Route path="/projects/:projectId/overview" element={<LocationProbe label="overview" />} />
          <Route path="/projects/:projectId/bible" element={<LocationProbe label="bible" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function uploadAndApply(view: ReturnType<typeof render>, count: number) {
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["# Chapter 1\n\nText"], "draft.md")] } });
  fireEvent.click(await screen.findByRole("button", { name: `Shelve ${count} items` }));
}

describe("Import follow-up: Generate Story Bible with AI", () => {
  it("shelf import with manuscript offers the Story Bible completion", async () => {
    stubShelfImport(
      importDetail([
        candidate("c-doc", "document", "Chapter 1"),
        candidate("c-intent", "intent", "Author intent"),
      ]),
    );
    const view = renderShelf();
    await uploadAndApply(view, 2);

    const dialog = await screen.findByRole("dialog", { name: "“draft.md” is on the shelf" });
    expect(dialog).toHaveTextContent(/hasn't been filled in chapter by chapter yet/);
    expect(screen.getByRole("button", { name: "Open project overview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate Story Bible with AI" }));

    expect(await screen.findByText("bible: /projects/p-new/bible?backfill=open")).toBeInTheDocument();
  });

  it("shelf import without manuscript still opens the project overview directly", async () => {
    stubShelfImport(importDetail([candidate("c-intent", "intent", "Author intent")]));
    const view = renderShelf();
    await uploadAndApply(view, 1);

    expect(await screen.findByText("overview: /projects/p-new/overview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate Story Bible with AI" })).not.toBeInTheDocument();
  });

  it("delivery import manager links to the Story Bible completion after apply", async () => {
    const ready = importDetail(
      [candidate("c-doc", "document", "Chapter 1"), candidate("c-intent", "intent", "Author intent")],
      "ready",
      "p-1",
    );
    const applied = {
      ...ready,
      batch: { ...ready.batch, status: "applied", appliedProjectId: "p-1" },
      candidates: ready.candidates.map((entry) => ({ ...entry, status: "applied" })),
    };
    let isApplied = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/imports") return json([]);
      if (url === "/api/imports/preview") return json(ready, 201);
      if (url === "/api/imports/batch-1") return json(isApplied ? applied : ready);
      if (url === "/api/imports/batch-1/actions" && init?.method === "POST") {
        isApplied = true;
        return json({ projectId: "p-1", detail: applied });
      }
      return json({ error: { code: "route.not_found", message: `unexpected ${url}` } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ImportManager projectId="p-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["# Chapter 1"], "draft.md")] } });
    fireEvent.click(await screen.findByRole("button", { name: /Apply 2 items/ }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Import applied.");
    expect(screen.getByRole("link", { name: "Generate Story Bible with AI" })).toHaveAttribute(
      "href",
      "/projects/p-1/bible?backfill=open",
    );
    expect(screen.getByRole("link", { name: "Open the target project" })).toHaveAttribute(
      "href",
      "/projects/p-1/bible",
    );
  });
});
