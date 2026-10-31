// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";

import { CommandPalette } from "../src/app/command-palette";
import { ConfirmDialog } from "../src/components/confirm-dialog";
import { setLocale } from "../src/i18n";

beforeEach(() => setLocale("pt-BR"));

function Harness() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Excluir</button>{open ? <ConfirmDialog title="Confirmar exclusão" confirmLabel="Confirmado" onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)}><p>Confirme esta operação.</p></ConfirmDialog> : null}</>;
}

it("a dialog closed with Esc restores focus to its trigger (CR-107)", () => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Excluir" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("alertdialog", { name: "Confirmar exclusão" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("the command palette links the active option through combobox", () => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  render(
    <MemoryRouter>
      <CommandPalette projectId="p-1" onClose={vi.fn()} />
    </MemoryRouter>,
  );
  const input = screen.getByRole("combobox", { name: "Buscar comandos" });
  const listbox = screen.getByRole("listbox");
  expect(input).toHaveAttribute("aria-controls", listbox.id);
  expect(input).toHaveAttribute("aria-expanded", "true");
  const initial = input.getAttribute("aria-activedescendant");
  expect(initial).toBeTruthy();
  expect(document.getElementById(initial!)).toHaveAttribute("role", "option");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).not.toBe(initial);
});
