import { estimateTokens } from "@lapis/context";
import { describe, expect, it } from "vitest";

import { chunkManuscript } from "../src/passage-chunker.js";

const paragraph = (words: number, stem = "palavra") =>
  `${Array.from({ length: words }, (_, index) => `${stem}${index}`).join(" ")}.`;

describe("chunkManuscript", () => {
  it("returns nothing for empty text and one passage for short text", () => {
    expect(chunkManuscript("")).toEqual([]);
    expect(chunkManuscript("  \n\n \n")).toEqual([]);
    expect(chunkManuscript("Uma frase só.")).toEqual([
      { ordinal: 0, text: "Uma frase só.", start: 0, end: 13 },
    ]);
  });

  it("keeps paragraphs whole and offsets that slice back to the passage", () => {
    const text = [paragraph(60), paragraph(60), paragraph(60)].join("\n\n");
    const passages = chunkManuscript(text, { targetTokens: 200 });
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) {
      expect(text.slice(passage.start, passage.end)).toBe(passage.text);
      expect(passage.text.startsWith("palavra0")).toBe(true);
      expect(passage.text.endsWith(".")).toBe(true);
    }
    expect(passages.map((passage) => passage.ordinal)).toEqual(
      passages.map((_, index) => index),
    );
  });

  it("never crosses a scene break and drops the break line", () => {
    const text = [
      "Primeira cena, curta.",
      "* * *",
      "Segunda cena, também curta.",
      "⁂",
      "Terceira.",
    ].join("\n\n");
    expect(chunkManuscript(text).map((passage) => passage.text)).toEqual([
      "Primeira cena, curta.",
      "Segunda cena, também curta.",
      "Terceira.",
    ]);
  });

  it("splits an oversized paragraph at sentence ends within the ceiling", () => {
    const sentences = Array.from(
      { length: 80 },
      (_, index) => `Frase número ${index} com algumas palavras a mais.`,
    ).join(" ");
    const passages = chunkManuscript(sentences, {
      targetTokens: 120,
      maxTokens: 160,
    });
    expect(passages.length).toBeGreaterThan(2);
    for (const passage of passages) {
      expect(estimateTokens(passage.text)).toBeLessThanOrEqual(160);
      expect(passage.text.endsWith(".")).toBe(true);
    }
    expect(passages.map((passage) => passage.text).join(" ")).toBe(sentences);
  });

  it("splits text without sentence ends or spaces by size", () => {
    const passages = chunkManuscript("A".repeat(5_000), {
      targetTokens: 200,
      maxTokens: 300,
    });
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.map((passage) => passage.text).join("")).toBe(
      "A".repeat(5_000),
    );
  });

  it("is deterministic and only reshapes the scene an edit touched", () => {
    const scene = (label: string) =>
      [paragraph(80, `${label}a`), paragraph(80, `${label}b`)].join("\n\n");
    const before = [scene("um"), "* * *", scene("dois")].join("\n\n");
    const after = [scene("um"), "* * *", `${scene("dois")} Mais uma.`].join(
      "\n\n",
    );
    const first = chunkManuscript(before, { targetTokens: 120 });
    expect(chunkManuscript(before, { targetTokens: 120 })).toEqual(first);
    const edited = chunkManuscript(after, { targetTokens: 120 });
    const unchanged = first.filter((passage) => passage.text.includes("uma"));
    expect(unchanged.length).toBeGreaterThan(0);
    for (const passage of unchanged)
      expect(edited.map((entry) => entry.text)).toContain(passage.text);
  });
});
