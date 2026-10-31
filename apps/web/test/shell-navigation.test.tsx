// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NaviLink, RepositoryLink } from "../src/app/shell";
import { WORKSPACES, workspaceByPath } from "../src/app/workspaces";
import { setLocale } from "../src/i18n";

afterEach(cleanup);
beforeEach(() => setLocale("pt-BR"));

describe("project navigation", () => {
  const shelf = WORKSPACES.find((item) => item.id === "shelf")!;
  const studio = WORKSPACES.find((item) => item.id === "studio")!;

  it("goes to the target workspace's empty state when no book is selected", () => {
    const view = render(<MemoryRouter>{NaviLink(studio, null, shelf, "/shelf")}</MemoryRouter>);
    expect(view.getByRole("link", { name: "Ir para Escrita" })).toHaveAttribute("href", "/studio");
    expect(workspaceByPath("/studio")).toBe(studio);
  });

  it("builds real workspace links once a book is selected", () => {
    const view = render(<MemoryRouter>{NaviLink(studio, "project-1", shelf, "/shelf")}</MemoryRouter>);
    expect(view.getByRole("link", { name: "Ir para Escrita" })).toHaveAttribute("href", "/projects/project-1/studio");
  });
});

describe("source code link", () => {
  it("points to the public repository and opens in a new window", () => {
    const view = render(<RepositoryLink />);
    const link = view.getByRole("link", { name: "Ver o código no GitHub" });

    expect(link).toHaveAttribute("href", "https://github.com/profdorly/narralume");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
