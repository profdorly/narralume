import { describe, expect, it } from "vitest";

import { detectManuscriptLanguage } from "../src/manuscript-language.js";

describe("best-effort manuscript language detection", () => {
  it.each([
    [
      "Portuguese",
      "Ela abriu a porta e não viu ninguém. O farol ainda girava quando o barco chegou à baía.",
    ],
    [
      "Portuguese",
      "— Você vai voltar? — perguntou ela. Ele disse que sim, mas já era tarde.",
    ],
    [
      "Spanish",
      "Ella abrió la puerta y no vio a nadie. El faro todavía giraba cuando el barco llegó a la bahía.",
    ],
    [
      "Spanish",
      "¿Quién mató a Laura? Nadie lo sabía, pero todos tenían miedo del hombre.",
    ],
    [
      "English",
      "She opened the door and saw no one. The lighthouse was still turning when the boat reached the bay.",
    ],
    [
      "English",
      "I do not know what he said to her, but it was late and they had to go.",
    ],
    ["Chinese", "沈砚发现一封空白信。她把信举到灯前，看见了潮水的影子。"],
  ])("detects %s", (language, text) => {
    expect(detectManuscriptLanguage(text)).toBe(language);
  });

  it("reads decomposed accents like composed ones", () => {
    expect(
      detectManuscriptLanguage(
        "Ela não sabia. Ele também não, e já era tarde.".normalize("NFD"),
      ),
    ).toBe("Portuguese");
  });

  it.each([
    ["empty text", ""],
    ["too short", "Olá."],
    ["no function words", "AAAA BBBB CCCC"],
    ["French", "Elle ouvrit la porte et ne vit personne. Le phare tournait."],
    [
      "Japanese",
      "彼女はドアを開けたが、誰もいなかった。灯台はまだ回っていた。",
    ],
    ["too few Chinese characters", "退潮"],
    [
      "an even Portuguese / English mix",
      "The door was open. A porta estava aberta e não havia ninguém.",
    ],
  ])("returns unknown for %s", (_, text) => {
    expect(detectManuscriptLanguage(text)).toBe("unknown");
  });
});
