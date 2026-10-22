import { describe, expect, it } from "vitest";

import {
  authoredInstructions,
  editableInstructionOf,
  workCraftLayer,
} from "../src/prompt-language.js";

const FALLBACK = {
  "pt-BR": "Camada de ofício padrão em português.",
  en: "Default English craft layer.",
} as const;

const INVARIANTS = {
  "pt-BR": "O cânone travado vence; entregue só a prosa.",
  en: "Locked canon wins; output prose only.",
} as const;

describe("editableInstructionOf", () => {
  it("picks the requested language from bilingual JSON content", () => {
    const content = JSON.stringify({
      "pt-BR": "Camada em português",
      en: "English layer",
    });
    expect(editableInstructionOf(content, "en")).toBe("English layer");
    expect(editableInstructionOf(content, "pt-BR")).toBe("Camada em português");
  });

  it("treats plain text as Portuguese-only content", () => {
    expect(editableInstructionOf("instrução em texto puro", "pt-BR")).toBe(
      "instrução em texto puro",
    );
    expect(editableInstructionOf("instrução em texto puro", "en")).toBeNull();
  });

  it("returns null for blank or language-missing content", () => {
    expect(editableInstructionOf("   ", "pt-BR")).toBeNull();
    const missingEn = JSON.stringify({ "pt-BR": "só português" });
    expect(editableInstructionOf(missingEn, "en")).toBeNull();
  });
});

describe("authoredInstructions", () => {
  it("falls back to the shipped default and appends invariants", () => {
    const result = authoredInstructions({
      language: "pt-BR",
      templateContent: null,
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(result).toBe(
      "Camada de ofício padrão em português.\nO cânone travado vence; entregue só a prosa.",
    );
  });

  it("lets the template override fully replace the craft layer", () => {
    const override = JSON.stringify({
      "pt-BR": "Ofício do autor.",
      en: "Author craft layer.",
    });
    const pt = authoredInstructions({
      language: "pt-BR",
      templateContent: override,
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(pt).toBe(
      "Ofício do autor.\nO cânone travado vence; entregue só a prosa.",
    );
    const en = authoredInstructions({
      language: "en",
      templateContent: override,
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(en).toContain("Author craft layer.");
    expect(en).not.toContain("Default English craft layer.");
  });

  it("keeps invariants intact even when the override omits them", () => {
    const result = authoredInstructions({
      language: "pt-BR",
      templateContent: JSON.stringify({
        "pt-BR": "Escreva à vontade.",
        en: "",
      }),
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(
      result.endsWith("O cânone travado vence; entregue só a prosa."),
    ).toBe(true);
  });

  it("falls back to defaults when the stored override is unusable", () => {
    const result = authoredInstructions({
      language: "en",
      templateContent: JSON.stringify({ "pt-BR": "só português." }),
      fallback: FALLBACK,
      invariants: INVARIANTS,
    });
    expect(result).toBe(
      "Default English craft layer.\nLocked canon wins; output prose only.",
    );
  });

  it("inserts the craft block between the step layer and invariants", () => {
    const result = authoredInstructions({
      language: "pt-BR",
      templateContent: null,
      fallback: FALLBACK,
      invariants: INVARIANTS,
      craft: "Primeiro, lute contra o instinto.",
    });
    expect(result).toBe(
      [
        "Camada de ofício padrão em português.",
        "<writing-craft>",
        "Primeiro, lute contra o instinto.",
        "</writing-craft>",
        "O cânone travado vence; entregue só a prosa.",
      ].join("\n"),
    );
  });

  it("omits the craft block when craft is missing or blank", () => {
    const base = {
      language: "pt-BR" as const,
      templateContent: null,
      fallback: FALLBACK,
      invariants: INVARIANTS,
    };
    expect(authoredInstructions({ ...base, craft: null })).toBe(
      "Camada de ofício padrão em português.\nO cânone travado vence; entregue só a prosa.",
    );
    expect(authoredInstructions({ ...base, craft: "   " })).toBe(
      "Camada de ofício padrão em português.\nO cânone travado vence; entregue só a prosa.",
    );
  });
});

describe("workCraftLayer", () => {
  it("resolves the shipped default when no template exists", () => {
    expect(
      workCraftLayer({
        language: "pt-BR",
        templateContent: null,
        fallback: FALLBACK,
      }),
    ).toBe("Camada de ofício padrão em português.");
  });

  it("follows the user override of the chapter-draft template", () => {
    expect(
      workCraftLayer({
        language: "pt-BR",
        templateContent: JSON.stringify({
          "pt-BR": "Ofício do autor.",
          en: "Author craft layer.",
        }),
        fallback: FALLBACK,
      }),
    ).toBe("Ofício do autor.");
  });

  it("falls back to the default when the override lacks the language", () => {
    expect(
      workCraftLayer({
        language: "en",
        templateContent: JSON.stringify({ "pt-BR": "só português." }),
        fallback: FALLBACK,
      }),
    ).toBe("Default English craft layer.");
  });
});
