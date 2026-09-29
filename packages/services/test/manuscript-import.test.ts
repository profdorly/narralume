import { describe, expect, it } from "vitest";

import {
  docxDocumentText,
  HEADING_MAX_CHARACTERS,
  htmlToText,
  inferStylePayload,
  manuscriptHeadingTitle,
  splitManuscriptSections,
  trimLineEnds,
  UNTITLED_HTML_HEADING,
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
    "Capítulo 3: O Retorno",
    "CAPÍTULO II — A Queda",
    "Capítulo 1. A Chegada",
    "Epílogo: Depois",
    "Capítulo 5: O Fim.",
    "Capítulo 6 – Onde?",
    "Parte Segunda - O Inverno",
    "Capítulo 1: 1985",
    // 问号、感叹号结尾的章名，以及 : – — - 之后以句号结尾的章名
    "Capítulo 5: Quem Matou Laura?",
    "Capítulo 12 — Onde Está o Corpo?",
    "Capítulo 3: E Agora, José?",
    "Capítulo 8 — Nunca Mais Volte!",
    "Capítulo 2 — O Fim do Mundo.",
    "Capítulo 1: ¿Quién mató a Laura?",
    "Capítulo 4 ¿Quién mató a Laura?",
    "Chapter Five: Who Killed Laura?",
    "Capítulo 3. Quem Matou Laura?",
    "Capítulo 4 Onde Está Laura?",
    "Capítulo 9. E Depois...",
    "Parte 3 - Tudo Acabou.",
    // 序数标记与紧贴序号的 -
    "Capítulo 1º",
    "Capítulo 1ª",
    "Capítulo 1°",
    "CAPÍTULO 2º: O Rio",
    "Parte 2ª — O Inverno",
    "Capítulo 1- A Chegada",
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
    "**第一章**",
    "#",
    "***",
    "* * *",
    "⁂",
    "# # #",
    "## #",
    "# ***",
    "## ⁂",
    // 分隔符后的标题部分像句子
    "Capítulo 3. Era a última página.",
    "Livro 1: leia antes de dormir.",
    "Capítulo 3 Ela saiu cedo.",
    "Prólogo. Era uma noite sem lua.",
    "Capítulo 2 — e então ela partiu",
    "Parte 4: “a casa caiu”",
    "**Capítulo 3. Era a última página.**",
    "Capítulo 4: e depois?",
    "Capítulo 6. Ela disse “adeus.”",
    // 序号在词边界结束；连字符分隔符后须有空白
    "Parte segunda-feira para Lisboa.",
    "Parte quinta-feira",
    "Parte sexta-feira, bem cedo",
    "Parte 2-3 vezes por semana.",
    "Capítulo 12-A Fuga",
    "Capítulo 1ºA",
    "Livro-caixa 3",
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

  it("keeps prose lines that start with a heading keyword inside the chapter", () => {
    const text = [
      "Capítulo 1: A Chegada",
      "Ela abriu o livro.",
      "Capítulo 3. Era a última página.",
      "Livro 1: leia antes de dormir.",
      "Parte segunda-feira para Lisboa.",
      "Capítulo 2 — O Rio",
      "A água subia.",
    ].join("\n\n");
    expect(splitManuscriptSections(text, "Livro")).toEqual([
      {
        title: "Capítulo 1: A Chegada",
        content: [
          "Ela abriu o livro.",
          "Capítulo 3. Era a última página.",
          "Livro 1: leia antes de dormir.",
          "Parte segunda-feira para Lisboa.",
        ].join("\n\n"),
      },
      { title: "Capítulo 2 — O Rio", content: "A água subia." },
    ]);
  });

  it("splits at question, exclamation and period-ended titles after a separator", () => {
    const text = [
      "Capítulo 1: Quem Matou Laura?",
      "Ninguém sabia.",
      "Capítulo 2 — Nunca Mais Volte!",
      "Ela partiu.",
      "Capítulo 3 — O Fim do Mundo.",
      "Capítulo 3. Era a última página.",
      "Chapter Four: Who Killed Laura?",
      "Nobody knew.",
      "Capítulo 5: ¿Quién mató a Laura?",
      "Nadie lo sabía.",
    ].join("\n\n");
    expect(splitManuscriptSections(text, "Livro")).toEqual([
      { title: "Capítulo 1: Quem Matou Laura?", content: "Ninguém sabia." },
      { title: "Capítulo 2 — Nunca Mais Volte!", content: "Ela partiu." },
      {
        title: "Capítulo 3 — O Fim do Mundo.",
        content: "Capítulo 3. Era a última página.",
      },
      { title: "Chapter Four: Who Killed Laura?", content: "Nobody knew." },
      { title: "Capítulo 5: ¿Quién mató a Laura?", content: "Nadie lo sabía." },
    ]);
  });

  it("keeps plain-text scene breaks, including # # #, inside the chapter", () => {
    const text = [
      "Capítulo 1",
      "Um.",
      "# # #",
      "Dois.",
      "#",
      "Três.",
      "***",
      "Quatro.",
      "* * *",
      "Cinco.",
      "⁂",
      "Seis.",
      "# ***",
      "Sete.",
    ].join("\n\n");
    expect(splitManuscriptSections(text, "Livro")).toEqual([
      { title: "Capítulo 1", content: text.replace(/^Capítulo 1\n\n/u, "") },
    ]);
  });

  it("merges a bare number heading with the Markdown title heading right after it", () => {
    const text = [
      "# Capítulo 1º",
      "## A Chegada",
      "Texto um.",
      "Capítulo 2",
      "## O Rio",
      "Texto dois.",
      "# Capítulo 3: O Mar",
      "## Uma cena",
      "Texto três.",
      "# Parte II",
      "## Capítulo 4",
      "Texto quatro.",
    ].join("\n\n");
    expect(splitManuscriptSections(text, "Livro")).toEqual([
      { title: "Capítulo 1º — A Chegada", content: "Texto um." },
      { title: "Capítulo 2 — O Rio", content: "Texto dois." },
      { title: "Uma cena", content: "Texto três." },
      { title: "Capítulo 4", content: "Texto quatro." },
    ]);
  });

  it("drops a table of contents whose entries hold only page numbers", () => {
    const text = [
      "O Farol",
      "Sumário",
      "Prólogo",
      "vii",
      "Capítulo 1 — A chegada",
      "7",
      "Capítulo 2 — O rio",
      "15",
      "Capítulo 3 — O fim",
      "31",
      "Prólogo",
      "A noite caiu.",
      "Capítulo 1 — A chegada",
      "Texto do capítulo um.",
      "Capítulo 2 — O rio",
      "Texto do capítulo dois.",
      "Capítulo 3 — O fim",
      "Texto do capítulo três.\n\n42",
    ].join("\n\n");
    expect(splitManuscriptSections(text, "O Farol")).toEqual([
      { title: "O Farol", content: "O Farol\n\nSumário" },
      { title: "Prólogo", content: "A noite caiu." },
      { title: "Capítulo 1 — A chegada", content: "Texto do capítulo um." },
      { title: "Capítulo 2 — O rio", content: "Texto do capítulo dois." },
      {
        title: "Capítulo 3 — O fim",
        content: "Texto do capítulo três.\n\n42",
      },
    ]);
  });

  it("drops an English table of contents under spelled-out chapter numbers", () => {
    const text = [
      "Contents",
      "Chapter One — Arrival",
      "7",
      "Chapter Two — The Storm",
      "15",
      "Chapter One — Arrival",
      "They landed at dawn.",
      "Chapter Two — The Storm",
      "It rained.",
    ].join("\n\n");
    expect(splitManuscriptSections(text, "The Book")).toEqual([
      { title: "The Book", content: "Contents" },
      { title: "Chapter One — Arrival", content: "They landed at dawn." },
      { title: "Chapter Two — The Storm", content: "It rained." },
    ]);
  });

  it("keeps a chapter whose text merely starts with a number", () => {
    expect(
      splitManuscriptSections(
        "Capítulo 1\n\n7 de maio.\n\nCapítulo 2\n\nFim.",
        "Livro",
      ),
    ).toEqual([
      { title: "Capítulo 1", content: "7 de maio." },
      { title: "Capítulo 2", content: "Fim." },
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

/** main 上 delivery-service 的 splitIntoSections 原样副本，作为既有标题形式的行为基准。 */
function mainSplitIntoSections(text: string, fallbackTitle: string) {
  const heading =
    /^(?:#{1,3}\s+(.+)|\s*((?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回]|Chapter\s+\d+)\s*[^\n]*))\s*$/gimu;
  const matches = [...text.matchAll(heading)];
  if (!matches.length) return [{ title: fallbackTitle, content: text.trim() }];
  const sections: { title: string; content: string }[] = [];
  const prefix = text.slice(0, matches[0]!.index).trim();
  if (prefix) sections.push({ title: "卷首", content: prefix });
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const next = matches[index + 1];
    const start = (match.index ?? 0) + match[0].length;
    const end = next?.index ?? text.length;
    const title = (match[1] ?? match[2] ?? `章节 ${index + 1}`).trim();
    const content = text.slice(start, end).trim();
    if (content) sections.push({ title, content });
  }
  return sections.length
    ? sections
    : [{ title: fallbackTitle, content: text.trim() }];
}

describe("legacy heading forms keep their previous behavior", () => {
  const longChineseHeading = `第一章 ${"长".repeat(HEADING_MAX_CHARACTERS + 10)}`;
  const longChapterHeading = `CHAPTER 14 ${"long ".repeat(30).trim()}`;

  it.each([
    [
      "Chinese front matter",
      "楔子\n\n风从海上来。\n\n第一章 退潮信\n沈砚发现空白信。\n\n第二章 无名地址\n她把信举到灯前。",
    ],
    [
      "a Chinese heading longer than the keyword cap",
      `序\n\n题记。\n\n${longChineseHeading}\n正文。\n\n第二章 终\n更多。`,
    ],
    [
      "an emphasis-wrapped Chinese heading",
      "**第一章**\n\n强调包裹不是标题。\n\n第二章 真正的标题\n正文。",
    ],
    [
      "节 / 卷 / 部 / 回 with full-width indentation",
      "　　第一节 全角缩进\n正文一。\n\n第二卷 卷名\n正文二。\n\n第三部 部名\n正文三。\n\n第五回 回目\n正文四。",
    ],
    ["Markdown headings", "# 第一章 标题\n正文。\n\n## 小节\n更多。"],
    [
      "a Chinese table of contents with page numbers",
      "目录\n\n第一章 起\n\n7\n\n第二章 承\n\n15\n\n第一章 起\n正文一。\n\n第二章 承\n正文二。",
    ],
    [
      "Chapter plus digits in any case, followed by anything",
      `Chapter 12 the storm\nIt rained.\n\nchapter 13 calm\nIt stopped.\n\n${longChapterHeading}\nEnd.`,
    ],
    [
      "an English Chapter-plus-digits table of contents with page numbers",
      "Chapter 1 — Arrival\n\n7\n\nChapter 2 — The Storm\n\n15\n\nChapter 1 — Arrival\nThey landed.\n\nChapter 2 — The Storm\nIt rained.",
    ],
    [
      "a Chinese number heading followed by a title heading",
      "# 第一章\n\n## 退潮信\n沈砚发现空白信。\n\n# 第二章\n## 无名地址\n她把信举到灯前。",
    ],
  ])("matches main for %s", (_, text) => {
    expect(splitManuscriptSections(text, "作品")).toEqual(
      mainSplitIntoSections(text, "作品"),
    );
  });

  it("keeps the line after a bare heading as content; main folded it into the title or lost it", () => {
    const text = "第一章\n\n正文第一段。\n\n第二段。\n\nChapter 2\nNext.";
    expect(mainSplitIntoSections(text, "作品")).toEqual([
      { title: "第一章\n\n正文第一段。", content: "第二段。" },
    ]);
    expect(splitManuscriptSections(text, "作品")).toEqual([
      { title: "第一章", content: "正文第一段。\n\n第二段。" },
      { title: "Chapter 2", content: "Next." },
    ]);
  });

  it("titles Chinese front matter 卷首 and keeps long and emphasized forms as before", () => {
    expect(
      splitManuscriptSections(
        `楔子\n\n风从海上来。\n\n${longChineseHeading}\n正文。\n\n**第二章**\n仍在第一章里。`,
        "退潮信",
      ),
    ).toEqual([
      { title: "卷首", content: "楔子\n\n风从海上来。" },
      {
        title: longChineseHeading,
        content: "正文。\n\n**第二章**\n仍在第一章里。",
      },
    ]);
  });

  it("splits on Chapter plus digits regardless of length or case", () => {
    expect(manuscriptHeadingTitle("Chapter 12 the storm")).toBe(
      "Chapter 12 the storm",
    );
    expect(manuscriptHeadingTitle("  chapter 3 was hard  ")).toBe(
      "chapter 3 was hard",
    );
    expect(manuscriptHeadingTitle(longChapterHeading)).toBe(longChapterHeading);
    expect([...longChapterHeading].length).toBeGreaterThan(
      HEADING_MAX_CHARACTERS,
    );
  });

  it("names non-CJK front matter after the work", () => {
    expect(
      splitManuscriptSections("Title page.\n\nChapter 1\nText.", "The Book"),
    ).toEqual([
      { title: "The Book", content: "Title page." },
      { title: "Chapter 1", content: "Text." },
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

  it("keeps scene-break paragraphs as text and never turns them into headings", () => {
    const text = docxDocumentText(
      document(
        paragraph("Chapter 1", '<w:pStyle w:val="Heading1"/>'),
        paragraph("First scene."),
        paragraph("#"),
        paragraph("Second scene."),
        paragraph("***"),
        paragraph("Third scene."),
        paragraph("* * *"),
        paragraph("Fourth scene."),
        paragraph("⁂"),
        paragraph("Fifth scene."),
        paragraph("#", '<w:pStyle w:val="Heading2"/>'),
        paragraph("Sixth scene."),
        paragraph("* * *", '<w:pStyle w:val="Heading1"/>'),
        paragraph("Seventh scene."),
        paragraph("# # #"),
        paragraph("Eighth scene."),
        paragraph("# # #", '<w:pStyle w:val="Heading2"/>'),
        paragraph("Ninth scene."),
        paragraph("***", '<w:outlineLvl w:val="0"/>'),
        paragraph("Tenth scene."),
      ),
      null,
    );
    // 套了标题样式的分隔符不加 # 前缀。
    expect(text).not.toMatch(/^#{1,3} (?:# # #|\*\*\*)$/mu);
    expect(splitManuscriptSections(text.trim(), "Book")).toEqual([
      {
        title: "Chapter 1",
        content: [
          "First scene.",
          "#",
          "Second scene.",
          "***",
          "Third scene.",
          "* * *",
          "Fourth scene.",
          "⁂",
          "Fifth scene.",
          "#",
          "Sixth scene.",
          "* * *",
          "Seventh scene.",
          "# # #",
          "Eighth scene.",
          "# # #",
          "Ninth scene.",
          "***",
          "Tenth scene.",
        ].join("\n\n"),
      },
    ]);
  });

  it("merges a number heading with the title heading that follows it", () => {
    const text = docxDocumentText(
      document(
        paragraph("Capítulo 1", '<w:pStyle w:val="Heading1"/>'),
        paragraph("A Chegada", '<w:pStyle w:val="Heading2"/>'),
        paragraph("Primeiro texto."),
        paragraph("Capítulo 2", '<w:pStyle w:val="Heading1"/>'),
        paragraph("O Rio", '<w:pStyle w:val="Heading2"/>'),
        paragraph("Segundo texto."),
      ),
      null,
    );
    expect(splitManuscriptSections(text.trim(), "Livro")).toEqual([
      { title: "Capítulo 1 — A Chegada", content: "Primeiro texto." },
      { title: "Capítulo 2 — O Rio", content: "Segundo texto." },
    ]);
  });
});

describe("malformed markup stays linear", () => {
  // 约 500 KB 正文；main 上的线性管线处理这类输入约 1 ms，平方级扫描需要数秒。
  const prose = "Texto do capítulo. ".repeat(26_000);
  const BUDGET_MS = 500;
  const timed = <T>(run: () => T): T => {
    const started = performance.now();
    const result = run();
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    return result;
  };

  it.each([
    ["unclosed <w:pPr>", "<w:pPr>".repeat(40_000)],
    ["unclosed <w:pPrChange>", "<w:pPrChange>".repeat(40_000)],
    [
      "<w:pStyle> tags without > inside a paragraph",
      `<w:p><w:pPr>${'<w:pStyle w:val="'.repeat(40_000)}</w:pPr>`,
    ],
    ["unclosed <w:tab", "<w:tab ".repeat(40_000)],
    ["bare <", "<".repeat(40_000)],
  ])("DOCX document with 40k %s", (_, markup) => {
    const text = timed(() => docxDocumentText(markup + prose, null));
    expect(text).toContain("Texto do capítulo. Texto do capítulo.");
  });

  it.each([
    [
      "unclosed <w:style>",
      '<w:style w:type="paragraph" w:styleId="S">'.repeat(40_000),
    ],
    [
      "<w:name> tags without > inside a style",
      `<w:style w:styleId="S">${"<w:name ".repeat(40_000)}</w:style>`,
    ],
  ])("DOCX styles with 40k %s", (_, styles) => {
    const text = timed(() =>
      docxDocumentText(
        `<w:p><w:pPr><w:pStyle w:val="S"/></w:pPr><w:r><w:t>${prose}</w:t></w:r></w:p>`,
        styles + prose,
      ),
    );
    expect(text).toContain("Texto do capítulo. Texto do capítulo.");
  });

  it.each([
    ["unclosed <head>", "<head>".repeat(40_000)],
    ["unclosed <script>", "<script>".repeat(40_000)],
    ["unclosed <style>", "<style>".repeat(40_000)],
    ["unclosed <h1>", "<h1>".repeat(40_000)],
    ["unclosed <h2 class>", '<h2 class="c">'.repeat(40_000)],
    ["bare <", "<".repeat(40_000)],
    ["unclosed <br", "<br ".repeat(40_000)],
  ])("HTML page with 40k %s", (_, markup) => {
    const text = timed(() => htmlToText(markup + prose));
    expect(text).toContain("Texto do capítulo. Texto do capítulo.");
  });

  it("HTML headings closed only after the markup bound", () => {
    const text = timed(() =>
      htmlToText(`${"<h1>".repeat(40_000)}${prose}</h1><p>Fim.</p>`),
    );
    expect(text).toContain("Texto do capítulo. Texto do capítulo.");
    expect(text).toContain("Fim.");
  });

  it("long whitespace runs in headings and line ends", () => {
    const spaces = " ".repeat(200_000);
    const sections = timed(() =>
      splitManuscriptSections(
        `# Capítulo 1${spaces}x\n\nCapítulo 2${spaces}y\n\nTexto.`,
        "Livro",
      ),
    );
    expect(sections).toEqual([
      {
        title: `Capítulo 1${spaces}x`,
        content: `Capítulo 2${spaces}y\n\nTexto.`,
      },
    ]);
    expect(
      timed(() => trimLineEnds(`a${spaces}b${" \t".repeat(100_000)}\nc `)),
    ).toBe(`a${spaces}b\nc`);
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

  it("keeps an unescaped < that does not start a tag", () => {
    expect(htmlToText("<p>a < b &lt;3</p><p>c</p>")).toBe("a < b <3\n\nc\n\n");
  });

  it("keeps a scene break wrapped in heading markup as text", () => {
    const sections = splitManuscriptSections(
      htmlToText(
        "<h1>Capítulo 1</h1><p>Um.</p><h2>* * *</h2><p>Dois.</p><h3>⁂</h3><p>Três.</p><h2># # #</h2><p>Quatro.</p><p># # #</p><p>Cinco.</p><h1>***</h1><p>Seis.</p>",
      ).trim(),
      "Livro",
    );
    expect(sections.map((section) => section.title)).toEqual(["Capítulo 1"]);
    expect(sections[0]!.content).toMatch(
      /^Um\.\s+\* \* \*\s+Dois\.\s+⁂\s+Três\.\s+# # #\s+Quatro\.\s+# # #\s+Cinco\.\s+\*\*\*\s+Seis\.$/u,
    );
  });

  it("keeps apostrophes and the other quote inside image alt titles", () => {
    const text = htmlToText(
      [
        `<h1><img src="c1.png" alt="Sant'Ana"/></h1><p>Um.</p>`,
        `<h1><img src='c2.png' alt='O "Farol" d&apos;Ávila'/></h1><p>Dois.</p>`,
        `<h1><img src="c3.png" alt="Don't Look Back"/></h1><p>Três.</p>`,
      ].join(""),
    );
    expect(
      splitManuscriptSections(text.trim(), "Livro").map(
        (section) => section.title,
      ),
    ).toEqual(["Sant'Ana", `O "Farol" d'Ávila`, "Don't Look Back"]);
  });

  it("merges a number heading with the title heading that follows it", () => {
    const text = htmlToText(
      [
        "<h1>Capítulo 1</h1><h2>A Chegada</h2><p>Um.</p>",
        '<h1>Capítulo 2</h1><h2><img src="o.png"/></h2><p>Dois.</p>',
        "<h1>Parte II</h1><h1>Capítulo 3</h1><h2>O Fim</h2><p>Três.</p>",
        "<h1>Chapter 4</h1><h2>The Storm</h2><p>Four.</p>",
        "<h1>Capítulo 5</h1><p>Cinco.</p><h2>Uma cena</h2><p>Mais.</p>",
      ].join(""),
    );
    expect(splitManuscriptSections(text.trim(), "Livro")).toEqual([
      { title: "Capítulo 1 — A Chegada", content: "Um." },
      { title: "Capítulo 2", content: "Dois." },
      { title: "Capítulo 3 — O Fim", content: "Três." },
      { title: "Chapter 4 — The Storm", content: "Four." },
      { title: "Capítulo 5", content: "Cinco." },
      { title: "Uma cena", content: "Mais." },
    ]);
  });

  it("titles image-only headings with the alt text, or a neutral title without one", () => {
    const text = htmlToText(
      [
        '<h1><img src="c1.png" alt="Capítulo 1 &amp; Mar"/></h1><p>Um.</p>',
        '<h2 class="c"><img src="ornament.png" alt=""/><svg><image href="c2.png"/></svg></h2><p>Dois.</p>',
        "<h1><span></span></h1><p>Ainda dois.</p>",
        '<h1><img src="x.png" alt="ornamento"/>Capítulo 3</h1><p>Três.</p>',
      ].join(""),
    );
    expect(
      splitManuscriptSections(text.trim(), "Livro").map((section) => [
        section.title,
        section.content,
      ]),
    ).toEqual([
      ["Capítulo 1 & Mar", "Um."],
      [UNTITLED_HTML_HEADING, "Dois.\n\nAinda dois."],
      ["Capítulo 3", "Três."],
    ]);
  });

  it.each([
    [
      "an oversized heading",
      `<h1 class="chapter">${'<span style="font-weight:bold">'.repeat(80)}Capítulo 1${"</span>".repeat(80)}</h1><p>Texto.</p>`,
    ],
    ["an unclosed heading", "<h2>Capítulo 1</h3><p>Texto.</p>"],
    [
      "an unclosed heading on its own line",
      '<h1 class="c">\n  <span>Capítulo 1</span>\n<p>Texto.</p>',
    ],
  ])("turns %s into plain paragraphs without a stray #", (_, html) => {
    const text = htmlToText(html);
    expect(text).not.toContain("#");
    expect(text).toContain("Texto.");
    expect(splitManuscriptSections(trimLineEnds(text).trim(), "Livro")).toEqual(
      [{ title: "Capítulo 1", content: "Texto." }],
    );
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
