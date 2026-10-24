import { describe, expect, it } from "vitest";

import { proseLintIssues } from "../src/prose-lint.js";

/** 干净段落：无命中词、密度正常，不应产生任何发现。 */
const CLEAN = [
  "太阳落下去，屋里的光变成橘色的。她把凉掉的茶倒掉，重新烧上水。",
  "“你疯了？”她把签好的合同抽回去，“行，你自己玩。”",
  "他把手机扣在桌上，又拿起来看一眼，再扣回去。窗外有人喊孩子回家吃饭。",
].join("\n\n");

function repeat(fragment: string, times: number): string {
  return Array.from({ length: times }, () => fragment).join("");
}

describe("proseLintIssues", () => {
  it("reports nothing for clean prose", () => {
    expect(proseLintIssues(CLEAN)).toEqual([]);
  });

  it("ignores single hits of tic terms", () => {
    const prose = `${CLEAN}\n\n他不禁回头看了眼门口，又把目光收回来。`;
    expect(proseLintIssues(prose)).toEqual([]);
  });

  it("ignores weak adverbs below the per-1000-char budget", () => {
    const prose = [
      CLEAN,
      "他缓缓坐下，又觉得不对，站起来把椅子挪了挪。",
      "她轻轻带上门。灯还亮着，她也没回去关。",
    ].join("\n\n");
    expect(proseLintIssues(prose)).toEqual([]);
  });

  it("reports major when a single cliche term repeats three times", () => {
    const prose = `${repeat("他眼中闪过一丝犹豫。", 3)}${CLEAN}`;
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("draft.ai_cliche_density");
    expect(issues[0].severity).toBe("major");
    expect(issues[0].message).toContain("眼中闪过×3");
    expect(issues[0].evidence).toContain("眼中闪过");
  });

  it("reports major when five distinct tic terms accumulate", () => {
    const prose = [
      CLEAN,
      "他不禁停下了脚步。",
      "人群中不由自主地安静下来。",
      "深吸一口气，他推开了那扇门。",
      "远处传来取而代之的轰鸣。",
      "她显得有些不知所措。",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("draft.ai_cliche_density");
  });

  it("reports major when weak adverbs exceed three per thousand chars", () => {
    const prose = [
      repeat("他缓缓开口，又缓缓合上嘴。", 3),
      "她微微点头，轻轻放下杯子，淡淡补了一句。",
      CLEAN,
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("draft.ai_adverb_density");
    expect(issues[0].severity).toBe("major");
  });

  it("reports major when negation flips reach three", () => {
    const prose = [
      CLEAN,
      "他不是生气，是把话咽了回去。",
      "那不是道歉，而是一种了结。",
      "她要的不是答案，而是有人肯听完。",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("draft.ai_negation_flip");
    expect(issues[0].evidence).toContain("不是");
  });

  it("ignores negation flips below three", () => {
    const prose = `${CLEAN}\n\n他不是生气，是把话咽了回去。`;
    expect(proseLintIssues(prose)).toEqual([]);
  });
});

/** Clean Portuguese and English scenes: no tics, adverbs at a human rate. */
const CLEAN_PT = [
  "A chuva começou depois do almoço e não parou mais. Marta fechou as janelas da cozinha, pôs a chaleira no fogo e ficou olhando o quintal encharcado. O cachorro dormia embaixo da mesa.",
  "— Você vai mesmo sair com esse tempo? — perguntou o irmão, sem tirar os olhos do jornal.",
  "— Vou. Prometi à dona Lurdes que levava os remédios hoje.",
  "Ela pegou o guarda-chuva, conferiu a sacola duas vezes e saiu pela porta dos fundos. Na esquina, um ônibus passou levantando água, e ela teve que recuar até a calçada.",
].join("\n\n");

const CLEAN_EN = [
  "The rain started after lunch and didn't stop. Martha shut the kitchen windows, put the kettle on, and stood watching the yard turn to mud. The dog slept under the table.",
  '"You\'re really going out in this?" her brother asked, without looking up from the paper.',
  '"I am. I promised Mrs. Lewis I\'d bring her prescriptions today."',
  "She took the umbrella, checked the bag twice, and left through the back door. At the corner a bus went by throwing up water, and she had to step back onto the curb.",
].join("\n\n");

describe("proseLintIssues in Portuguese", () => {
  it("reports nothing for clean prose", () => {
    expect(proseLintIssues(CLEAN_PT)).toEqual([]);
  });

  it("ignores a single tic and a couple of soft adverbs", () => {
    const prose = `${CLEAN_PT}\n\nEla respirou fundo e fechou lentamente o portão. O vento soprava suavemente.`;
    expect(proseLintIssues(prose)).toEqual([]);
  });

  it("reports one tic repeated three times", () => {
    const prose = [
      CLEAN_PT,
      "Ela respirou fundo antes de bater.",
      "Lá dentro, respirou fundo outra vez.",
      "Respirando fundo, aceitou o café.",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "draft.ai_cliche_density",
      severity: "major",
    });
    expect(issues[0].message).toContain("respirou fundo×3");
    expect(issues[0].evidence).toMatch(/^respirou fundo/);
  });

  it("reports five different tics in a short scene", () => {
    const prose = [
      CLEAN_PT,
      "Um arrepio percorreu sua espinha quando a luz piscou.",
      "O coração disparou. Ele engoliu em seco e sentiu um nó na garganta.",
      "Um silêncio pesado tomou conta da sala.",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues.map((issue) => issue.code)).toEqual([
      "draft.ai_cliche_density",
    ]);
    expect(issues[0].message).toContain("(5 no total)");
  });

  it("reports dense soft adverbs", () => {
    const prose = [
      CLEAN_PT,
      "Ela caminhou lentamente até a porta, abriu-a suavemente e olhou levemente para trás. Sorriu delicadamente e saiu silenciosamente.",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues.map((issue) => issue.code)).toEqual([
      "draft.ai_adverb_density",
    ]);
    expect(issues[0].evidence).toMatch(/^lentamente/);
  });

  it("reports three “não era X, era Y” flips", () => {
    const prose = [
      CLEAN_PT,
      "Não era medo. Era cansaço.",
      "E não é raiva, é saudade.",
      "Não foi sorte — foi teimosia.",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues.map((issue) => issue.code)).toEqual([
      "draft.ai_negation_flip",
    ]);
    expect(issues[0].message).toContain("3 ocorrências");
    expect(issues[0].evidence).toMatch(/^Não era medo/);
  });

  it("does not count negations that are not flips", () => {
    const prose = [
      CLEAN_PT,
      "Não é preciso dizer que era ela. São coisas que se adivinham.",
      "Não era tarde, mas quase.",
      "Não estava em casa; o carro também não.",
      "Não era medo. Era cansaço.",
    ].join("\n\n");
    expect(proseLintIssues(prose)).toEqual([]);
  });
});

describe("proseLintIssues in English", () => {
  it("reports nothing for clean prose", () => {
    expect(proseLintIssues(CLEAN_EN)).toEqual([]);
  });

  it("reports one tic repeated three times", () => {
    const prose = `${CLEAN_EN}\n\n${"He took a deep breath. ".repeat(3)}`;
    const issues = proseLintIssues(prose);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("took a deep breath×3");
  });

  it("reports five different tics in a short scene", () => {
    const prose = [
      CLEAN_EN,
      "A shiver ran down her spine. Her heart pounded.",
      "She swallowed hard. The silence hung in the air, a testament to everything they had lost.",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues.map((issue) => issue.code)).toEqual([
      "draft.ai_cliche_density",
    ]);
  });

  it("reports dense soft adverbs", () => {
    const prose = [
      CLEAN_EN,
      "She walked slowly to the door, opened it gently, and glanced back softly. She smiled faintly and left quietly.",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues.map((issue) => issue.code)).toEqual([
      "draft.ai_adverb_density",
    ]);
  });

  it("reports three “it wasn't X, it was Y” flips", () => {
    const prose = [
      CLEAN_EN,
      "It wasn't fear. It was exhaustion.",
      "He wasn't angry, he was tired.",
      "This isn't a game—it's war.",
    ].join("\n\n");
    const issues = proseLintIssues(prose);
    expect(issues.map((issue) => issue.code)).toEqual([
      "draft.ai_negation_flip",
    ]);
    expect(issues[0].evidence).toMatch(/^It wasn't fear/);
  });

  it("does not count a change of subject as a flip", () => {
    const prose = [
      CLEAN_EN,
      "He wasn't there. She was.",
      "They weren't home, we were.",
      "It wasn't fear. It was exhaustion.",
    ].join("\n\n");
    expect(proseLintIssues(prose)).toEqual([]);
  });
});
