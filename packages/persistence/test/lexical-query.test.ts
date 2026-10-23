import { describe, expect, it } from "vitest";

import { buildEntityMentionMatcher } from "../src/entity-mentions.js";
import { buildLexicalQuery, foldText } from "../src/lexical-query.js";

describe("buildLexicalQuery", () => {
  it("drops chapter headings, stopwords and short numbers", () => {
    expect(buildLexicalQuery("Capítulo 11")).toEqual({
      words: null,
      trigrams: null,
      likeTerms: [],
      terms: [],
    });
    expect(buildLexicalQuery("Chapter 7 of the book").words).toBe('"book"');
  });

  it("ORs folded word terms and turns long words into prefixes", () => {
    const plan = buildLexicalQuery(
      "Helena volta à gruta na maré baixa levando a chave",
    );
    expect(plan.words).toBe(
      '"helen"* OR "volt"* OR "grut"* OR "mare" OR "baix"* OR "levan"* OR "chav"*',
    );
    expect(plan.trigrams).toBeNull();
  });

  it("keeps years and quotes terms safely", () => {
    const plan = buildLexicalQuery('naufrágio de 1987 "estrela"');
    expect(plan.words).toBe('"naufra"* OR "1987" OR "estre"*');
  });

  it("keeps a final consonant of mid-length words", () => {
    expect(buildLexicalQuery("farol").words).toBe('"farol"*');
    expect(buildLexicalQuery("caixas").words).toBe('"caixa"*');
  });

  it("sends CJK runs to the trigram index and two-character terms to LIKE", () => {
    const plan = buildLexicalQuery("铜钥匙 林昭 and the harbor");
    expect(plan.words).toBe('"harbor"*');
    expect(plan.trigrams).toBe('"铜钥匙"');
    expect(plan.likeTerms).toEqual(["铜钥匙", "铜钥", "钥匙", "林昭"]);
  });

  it("caps the number of word terms, preferring longer words", () => {
    // 40 distinct stems ("aapalavra", "bapalavra", ...) plus one short word.
    const words = [
      "mar",
      ...Array.from(
        { length: 40 },
        (_, index) =>
          `${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}palavra`,
      ),
    ].join(" ");
    const terms = buildLexicalQuery(words).words!.split(" OR ");
    expect(terms).toHaveLength(24);
    expect(terms).not.toContain('"mar"');
  });

  it("folds case and diacritics", () => {
    expect(foldText("Coração INÊS Ação")).toBe("coracao ines acao");
  });
});

describe("buildEntityMentionMatcher", () => {
  const matcher = buildEntityMentionMatcher([
    { id: "ana", name: "Ana", aliases: [] },
    { id: "ines", name: "Inês Prates", aliases: ["Inês"] },
    { id: "lin", name: "林昭", aliases: [] },
    { id: "x", name: "X", aliases: [] },
  ]);

  it("matches whole words after folding, counting every mention", () => {
    expect(
      matcher("Ananias viu Ana. INES   Prates sorriu; depois inês saiu."),
    ).toEqual(
      new Map([
        ["ana", 1],
        ["ines", 2],
      ]),
    );
  });

  it("matches CJK names as substrings and ignores one-letter names", () => {
    expect(matcher("林昭来了。X marca o lugar.")).toEqual(
      new Map([["lin", 1]]),
    );
  });
});
