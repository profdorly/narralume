import { describe, expect, it } from "vitest";

import { getLocale, loadLocale, setLocale, translate } from "../src/i18n";

// No "./i18n-en" import here: this file checks the on-demand English chunk.
describe("on-demand English dictionary", () => {
  it("falls back to pt-BR until English loads, then switches", async () => {
    setLocale("pt-BR");
    expect(translate("en", "common.action.save")).toBe("Salvar");

    setLocale("en");
    expect(getLocale()).toBe("pt-BR");

    await loadLocale("en");
    expect(getLocale()).toBe("en");
    expect(translate("en", "common.action.save")).toBe("Save");
    expect(translate("pt-BR", "common.action.save")).toBe("Salvar");
  });

  it("switches synchronously once the dictionary is loaded", () => {
    setLocale("pt-BR");
    expect(getLocale()).toBe("pt-BR");
    setLocale("en");
    expect(getLocale()).toBe("en");
  });
});
