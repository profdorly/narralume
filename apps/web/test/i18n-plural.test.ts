import { describe, expect, it } from "vitest";

import { translate } from "../src/i18n";
import { enMessages } from "../src/i18n/en";
import { ptBrMessages } from "../src/i18n/pt-BR";
import "./i18n-en";

/** The only plural form translate() understands. */
const PLURAL_BLOCK = /\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g;

function dictionaryStrings(node: unknown, path = ""): [string, string][] {
  if (typeof node === "string") return [[path, node]];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) =>
    dictionaryStrings(value, path ? `${path}.${key}` : key),
  );
}

describe("plural agreement in the dictionaries", () => {
  it("uses the singular for exactly 1 and the plural otherwise in pt-BR", () => {
    expect(translate("pt-BR", "shelf.book.chapters", { count: 1 })).toBe("1 capítulo");
    expect(translate("pt-BR", "shelf.book.chapters", { count: 2 })).toBe("2 capítulos");
    expect(translate("pt-BR", "shelf.book.chapters", { count: 0 })).toBe("0 capítulos");
    expect(translate("pt-BR", "studio.desk.versionCount", { count: 1 })).toBe("1 versão");
    expect(translate("pt-BR", "studio.desk.versionCount", { count: 2 })).toBe("2 versões");
    // Formatted counts: a thousand written with a separator is not "one".
    expect(translate("pt-BR", "shelf.book.chapters", { count: "1.000" })).toBe("1.000 capítulos");
    expect(translate("pt-BR", "shelf.book.chapters", { count: "1" })).toBe("1 capítulo");
  });

  it("uses the singular for exactly 1 and the plural otherwise in English", () => {
    expect(translate("en", "shelf.book.chapters", { count: 1 })).toBe("1 chapter");
    expect(translate("en", "shelf.book.chapters", { count: 2 })).toBe("2 chapters");
    expect(translate("en", "shelf.book.chapters", { count: 0 })).toBe("0 chapters");
    expect(translate("en", "studio.desk.versionCount", { count: 1 })).toBe("1 version");
    expect(translate("en", "studio.desk.versionCount", { count: 2 })).toBe("2 versions");
  });

  it("agrees the words around the noun and keeps other placeholders outside the block", () => {
    expect(translate("pt-BR", "lab.index.stale", { count: 1 })).toBe(
      "1 capítulo mudou desde a última indexação; a próxima busca ou escrita por IA o reindexa.",
    );
    expect(translate("pt-BR", "lab.index.stale", { count: 2 })).toBe(
      "2 capítulos mudaram desde a última indexação; a próxima busca ou escrita por IA os reindexa.",
    );
    expect(translate("en", "lab.index.stale", { count: 1 })).toBe(
      "1 chapter changed since the last indexing; the next search or AI writing run reindexes it.",
    );
    expect(
      translate("pt-BR", "bible.backfill.summary.paused", { done: 0, total: 1 }),
    ).toBe("Pausado · 0 de 1 capítulo concluído");
    expect(
      translate("en", "bible.backfill.summary.paused", { done: 1, total: 2 }),
    ).toBe("Paused · 1 of 2 chapters done");
    expect(
      translate("pt-BR", "overview.masthead.progress", { committed: 1, total: 2, words: 1 }),
    ).toBe("1 registrado · 2 capítulos · 1 caractere");
    expect(
      translate("pt-BR", "autopilot.deck.sessionDone", { completed: 0, target: 1 }),
    ).toBe("0/1 capítulo concluído");
    expect(
      translate("en", "autopilot.deck.sessionDone", { completed: 2, target: 3 }),
    ).toBe("2/3 chapters done");
  });

  it.each([
    ["pt-BR", ptBrMessages],
    ["en", enMessages],
  ] as const)("writes every %s plural block in the supported form", (_locale, messages) => {
    const plural = dictionaryStrings(messages).filter(([, text]) => /,\s*plural\b/.test(text));
    expect(plural.length).toBeGreaterThan(0);
    const malformed = plural
      .filter(([, text]) => /,\s*plural\b/.test(text.replace(PLURAL_BLOCK, "")))
      .map(([key]) => key);
    expect(malformed).toEqual([]);
  });
});
