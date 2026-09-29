import { describe, expect, it } from "vitest";

import {
  docxDocumentText,
  HEADING_MAX_CHARACTERS,
  htmlToText,
  inferStylePayload,
  manuscriptHeadingTitle,
  splitManuscriptSections,
} from "../src/manuscript-import.js";

describe("manuscript chapter headings", () => {
  it.each([
    "Capítulo 1",
    "CAPÍTULO I",
    "Capítulo Um",
    "Capitulo 12 - A Fuga",
    "CAPÍTULO II — O Retorno",
    "Capítulo Três: A Tempestade",
    "Capítulo Vinte e Um",
    "Capítulo 7 O Farol",
    "Capítulo quinto",
    "Parte 2",
    "PARTE DOIS",
    "Livro Primeiro",
    "Prólogo",
    "Prologo: A chegada",
    "Epílogo",
    "Interlúdio II",
    "Capítulo Diez",
    "Libro Segundo",
    "Chapter 12",
    "Chapter 3 The Storm",
    "Chapter One",
    "Chapter Twenty-One",
    "CHAPTER XIV: The Storm",
    "Part Two — Winter",
    "Book III",
    "Prologue",
    "Epilogue.",
    "Interlude",
    "**Capítulo 4**",
    "第一章 退潮信",
    "第12章",
  ])("recognizes %j", (line) => {
    expect(manuscriptHeadingTitle(line)).toBe(
      line.replace(/^\*\*(.*)\*\*$/u, "$1"),
    );
  });

  it("keeps Markdown headings up to level three", () => {
    expect(manuscriptHeadingTitle("# Capítulo 1")).toBe("Capítulo 1");
    expect(manuscriptHeadingTitle("### Uma cena")).toBe("Uma cena");
    expect(manuscriptHeadingTitle("#### Nota")).toBeNull();
  });

  it.each([
    "Capítulo após capítulo, ela lia sem parar.",
    "Parte de mim queria ficar.",
    "Parte um do plano era simples.",
    "Capítulo 3 do livro anterior explicava tudo",
    "Prólogo de uma vida",
    "Book I read yesterday",
    "Chapter one was boring.",
    "Chapter",
    "Capítulo",
    "— Capítulo 1 — disse ele.",
    `Capítulo 1: ${"a".repeat(HEADING_MAX_CHARACTERS)}`,
    `第一章${"很".repeat(HEADING_MAX_CHARACTERS)}`,
  ])("rejects %j", (line) => {
    expect(manuscriptHeadingTitle(line)).toBeNull();
  });

  it("splits a Portuguese manuscript without Markdown and names front matter after the work", () => {
    const text = [
      "O Farol",
      "Para Ana.",
      "Prólogo",
      "A noite caiu sobre a baía.",
      "Capítulo 1",
      "Era uma vez uma cidade.",
      "Ninguém lembrava o nome do faroleiro.",
      "CAPÍTULO II — O Retorno",
      "Ele voltou com a maré.",
      "Epílogo",
      "Anos depois, a luz ainda girava.",
    ].join("\n\n");
    const sections = splitManuscriptSections(text, "O Farol");
    expect(sections.map((section) => section.title)).toEqual([
      "O Farol",
      "Prólogo",
      "Capítulo 1",
      "CAPÍTULO II — O Retorno",
      "Epílogo",
    ]);
    expect(sections[0]!.content).toBe("O Farol\n\nPara Ana.");
    expect(sections[2]!.content).toBe(
      "Era uma vez uma cidade.\n\nNinguém lembrava o nome do faroleiro.",
    );
  });

  it("does not split on a long prose paragraph that starts like a heading", () => {
    const paragraph = `Capítulo 2 — ${"a história continuou sem pausa, ".repeat(4)}`;
    expect([...paragraph.trim()].length).toBeGreaterThan(
      HEADING_MAX_CHARACTERS,
    );
    const text = `Primeira frase.\n\n${paragraph}\n\nÚltima frase.`;
    expect(splitManuscriptSections(text, "Livro")).toEqual([
      { title: "Livro", content: text },
    ]);
  });

  it("keeps the existing Chinese splitting", () => {
    expect(
      splitManuscriptSections(
        "# 第一章 退潮信\n沈砚发现空白信。\n\n第二章 无名地址\n她把信举到灯前。",
        "退潮信",
      ),
    ).toEqual([
      { title: "第一章 退潮信", content: "沈砚发现空白信。" },
      { title: "第二章 无名地址", content: "她把信举到灯前。" },
    ]);
  });
});

describe("DOCX heading styles", () => {
  const paragraph = (text: string, properties = "") =>
    `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  const document = (...paragraphs: string[]) =>
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}</w:body></w:document>`;

  it("maps localized style ids through their built-in English names", () => {
    const styles = `<w:styles>
      <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Ttulo"><w:name w:val="Title"/></w:style>
      <w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
      <w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
      <w:style w:type="paragraph" w:styleId="Cena"><w:name w:val="Cena"/><w:basedOn w:val="Ttulo2"/></w:style>
      <w:style w:type="character" w:styleId="Ttulo1Char"><w:name w:val="Título 1 Char"/></w:style>
    </w:styles>`;
    const text = docxDocumentText(
      document(
        paragraph("O Farol", '<w:pStyle w:val="Ttulo"/>'),
        paragraph("Capítulo Um", '<w:pStyle w:val="Ttulo1"/>'),
        paragraph("Era uma vez.", '<w:pStyle w:val="Normal"/>'),
        paragraph("Na praia", '<w:pStyle w:val="Cena"/>'),
        paragraph("A maré subia."),
      ),
      styles,
    );
    expect(text).toContain("\n# O Farol\n");
    expect(text).toContain("\n# Capítulo Um\n");
    expect(text).toContain("\n## Na praia\n");
    expect(text).not.toContain("# Era uma vez.");
    expect(text).not.toContain("# A maré subia.");
  });

  it("falls back to English style ids and honors paragraph outline levels", () => {
    const text = docxDocumentText(
      document(
        paragraph("Chapter 1", '<w:pStyle w:val="Heading1"/>'),
        paragraph("Body.", '<w:pStyle w:val="BodyText"/>'),
        paragraph("Interlúdio", '<w:outlineLvl w:val="2"/>'),
        paragraph(
          "Not a heading",
          '<w:pStyle w:val="Heading1"/><w:outlineLvl w:val="9"/>',
        ),
        paragraph("", '<w:pStyle w:val="Heading1"/>'),
        paragraph(
          "Revised",
          '<w:pPrChange><w:pPr><w:pStyle w:val="Heading1"/></w:pPr></w:pPrChange>',
        ),
      ),
      null,
    );
    expect(text).toContain("\n# Chapter 1\n");
    expect(text).toContain("\n### Interlúdio\n");
    expect(text).not.toMatch(/#\s*Not a heading/u);
    expect(text).not.toMatch(/^#+\s*$/mu);
    expect(text).not.toMatch(/#\s*Revised/u);
  });

  it("feeds DOCX headings into chapter splitting", () => {
    const text = docxDocumentText(
      document(
        paragraph("Capítulo Um", '<w:pStyle w:val="Heading1"/>'),
        paragraph("Primeiro texto."),
        paragraph("Capítulo Dois", '<w:pStyle w:val="Heading1"/>'),
        paragraph("Segundo texto."),
      ),
      null,
    );
    expect(
      splitManuscriptSections(text.trim(), "Livro").map(
        (section) => section.title,
      ),
    ).toEqual(["Capítulo Um", "Capítulo Dois"]);
  });
});

describe("HTML and EPUB pages", () => {
  it("turns h1-h3 into Markdown headings and drops the document head", () => {
    const text = htmlToText(
      `<html><head><title>Capítulo 1</title></head><body><h1 class="chapter">
        <span>Capítulo 1</span>
      </h1><p>Texto &amp; mar.</p><h2>Uma cena<br/>noturna</h2><p>Mais texto.</p><h4>Nota</h4></body></html>`,
    );
    expect(text).toMatch(/^# Capítulo 1$/mu);
    expect(text).toMatch(/^## Uma cena noturna$/mu);
    expect(text).toContain("Texto & mar.");
    expect(text.match(/Capítulo 1/gu)).toHaveLength(1);
    expect(
      splitManuscriptSections(text.trim(), "Livro").map(
        (section) => section.title,
      ),
    ).toEqual(["Capítulo 1", "Uma cena noturna"]);
  });
});

describe("statistical import style", () => {
  it("counts words and splits on periods and ellipses for non-CJK text", () => {
    const style = inferStylePayload(
      "Ela correu pela praia. Ele parou… Depois, silêncio!\n\n— Volte — disse ela.\n\n— Não posso.",
    );
    expect(style.name).toBe("Source text statistics style");
    expect(style.rules[0]).toBe(
      "Sentences run about 3 words on average; avoid drifting far from this unintentionally",
    );
    expect(style.rules[1]).toContain("about 4 words");
    expect(style.rules[2]).toBe(
      "Dialogue is prominent; preserve character voices and subtext",
    );
    expect(JSON.stringify(style)).not.toMatch(/[\p{Script=Han}]/u);
    expect(style.active).toBe(false);
  });

  it("keeps the character-based Chinese statistics for CJK text", () => {
    const style = inferStylePayload("沈砚发现一封信。她举到灯前。");
    expect(style).toMatchObject({
      name: "原文统计风格",
      rules: [
        "句长中位倾向约 6 字，避免无意中大幅漂移",
        "段落平均约 14 字，按场面节奏调整而非机械复制",
        "叙述占比较高，对话只承担必要动作",
      ],
      examples: ["沈砚发现一封信。她举到灯前。"],
    });
  });
});
