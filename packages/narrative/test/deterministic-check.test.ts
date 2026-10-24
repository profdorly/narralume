import { describe, expect, it } from "vitest";

import { draftIssues } from "../src/chapter-workers/deterministic-check.js";

/** Short fixtures: skip the minimum length so each test sees one rule. */
const POLICY = { minChapterCharacters: 1 };

function codes(content: string): string[] {
  return draftIssues(content, POLICY).map((issue) => issue.code);
}

describe("draftIssues placeholders", () => {
  it("does not mistake the everyday word “todo” for a TODO marker", () => {
    expect(
      codes(
        "Ela passou o dia todo esperando. Todo mundo sabia que ele não vinha.\n\n“El perro salió todo mojado”, contou Carin.\n\n— TODO MUNDO PRA FORA! — gritou o porteiro.",
      ),
    ).toEqual([]);
  });

  it.each([
    ["TODO: descrever a chegada ao porto."],
    ["Ela abriu a porta. [TODO]"],
    ["Ela abriu a porta (TODO revisar)."],
    ["Olá, {{nome_do_personagem}}."],
    ["他推开门。[待补：门后的场景]"],
    ["Ela olhou para [inserir descrição do quarto]."],
    ["He looked at [Insert description here]."],
    ["As an AI language model, I cannot write this scene."],
    ["Como um modelo de linguagem, não posso continuar."],
    ["作为一个AI，我无法继续。"],
  ])("reports %j as a placeholder", (content) => {
    const issues = draftIssues(content, POLICY);
    expect(issues.map((issue) => issue.code)).toContain("draft.placeholder");
    expect(
      issues.find((issue) => issue.code === "draft.placeholder")?.severity,
    ).toBe("critical");
  });
});

describe("draftIssues repeated phrases", () => {
  it("does not count a character's full name as a repeated phrase", () => {
    const prose = [
      "Lady Catherine de Bourgh arrived before noon.",
      "Nobody had expected Lady Catherine de Bourgh to stay for dinner.",
      "Elizabeth watched Lady Catherine de Bourgh inspect the furniture.",
      "When Lady Catherine de Bourgh finally left, the house exhaled.",
      "Even the servants talked about Lady Catherine de Bourgh for a week.",
    ].join("\n\n");
    expect(codes(prose)).toEqual([]);
  });

  it("reports a six-word run repeated four times in space-delimited prose", () => {
    const loop = "ela olhou para a janela e pensou no irmão";
    const prose = [
      `De manhã, ${loop}.`,
      `Depois do almoço, ${loop} outra vez.`,
      `À tarde, ${loop} sem saber por quê.`,
      `À noite, ${loop} até dormir.`,
    ].join("\n\n");
    const issues = draftIssues(prose, POLICY);
    expect(issues.map((issue) => issue.code)).toEqual([
      "draft.repeated_phrase_density",
    ]);
    expect(issues[0].evidence).toBe("ela olhou para a janela e");
  });

  it("keeps the character window for Chinese prose", () => {
    const prose = "他把手机扣在桌上又拿起来看".repeat(20);
    expect(codes(prose)).toEqual(["draft.repeated_phrase_density"]);
  });
});
