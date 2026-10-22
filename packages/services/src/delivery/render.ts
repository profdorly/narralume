import { randomUuid } from "@narralume/domain";
import JSZip from "jszip";
import { DOCX_TITLE_PAGE_STYLE } from "../manuscript-import.js";

function emptyManuscriptCopy(language: string): {
  title: string;
  content: string;
} {
  return language.startsWith("en")
    ? { title: "Untitled", content: "This work has no prose yet." }
    : { title: "Sem título", content: "Esta obra ainda não tem prosa." };
}

function tocLabel(language: string): string {
  return language.startsWith("en") ? "Contents" : "Sumário";
}

function titlePageLabel(language: string): string {
  return language.startsWith("en") ? "Title page" : "Folha de rosto";
}

export async function renderEpub(
  project: { title: string; language: string },
  sections: readonly { title: string; content: string }[],
) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  const safeSections = sections.length
    ? sections
    : [emptyManuscriptCopy(project.language)];
  const manifestItems: string[] = [];
  const spineItems: string[] = [];
  const navItems: string[] = [];
  safeSections.forEach((section, index) => {
    const file = `chapter-${index + 1}.xhtml`;
    const id = `chapter-${index + 1}`;
    manifestItems.push(
      `<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`,
    );
    spineItems.push(`<itemref idref="${id}"/>`);
    navItems.push(`<li><a href="${file}">${escapeXml(section.title)}</a></li>`);
    zip.file(
      `OEBPS/${file}`,
      `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(project.language)}"><head><title>${escapeXml(section.title)}</title><link rel="stylesheet" href="styles.css" type="text/css"/></head><body><h1>${escapeXml(section.title)}</h1>${markdownishToXhtml(section.content)}</body></html>`,
    );
  });
  zip.file(
    "OEBPS/title.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(project.language)}"><head><title>${escapeXml(titlePageLabel(project.language))}</title><link rel="stylesheet" href="styles.css" type="text/css"/></head><body class="title-page"><p class="publisher">NarraLume</p><h1>${escapeXml(project.title)}</h1></body></html>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${escapeXml(tocLabel(project.language))}</title></head><body><nav epub:type="toc"><h1>${escapeXml(tocLabel(project.language))}</h1><ol><li><a href="title.xhtml">${escapeXml(titlePageLabel(project.language))}</a></li>${navItems.join("")}</ol></nav></body></html>`,
  );
  zip.file(
    "OEBPS/styles.css",
    "body{font-family:serif;line-height:1.8;margin:5%;}h1{page-break-before:always;}p{text-indent:2em;margin:.6em 0;}h1+p{text-indent:0}",
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${randomUuid()}</dc:identifier><dc:title>${escapeXml(project.title)}</dc:title><dc:language>${escapeXml(project.language)}</dc:language><dc:publisher>NarraLume</dc:publisher><dc:creator>NarraLume</dc:creator><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/u, "Z")}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="title" href="title.xhtml" media-type="application/xhtml+xml"/><item id="css" href="styles.css" media-type="text/css"/>${manifestItems.join("")}</manifest><spine><itemref idref="title"/>${spineItems.join("")}</spine></package>`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export async function renderDocx(
  project: { title: string; language: string },
  sections: readonly { title: string; content: string }[],
) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  const bodySections = sections.length
    ? sections
    : [emptyManuscriptCopy(project.language)];
  const paragraphs = [
    docxTitleParagraph(project.title),
    docxTitlePageLabel(titlePageLabel(project.language)),
    ...bodySections.flatMap((section) => [
      docxParagraph(section.title, 1),
      ...section.content
        .split(/\n\s*\n/u)
        .filter(Boolean)
        .map((paragraph) => docxParagraph(paragraph, null)),
    ]),
  ].join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xml:lang="${escapeXml(project.language)}"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  const now = new Date().toISOString();
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(project.title)}</dc:title><dc:creator>NarraLume</dc:creator><dc:language>${escapeXml(project.language)}</dc:language><cp:category>Ficção</cp:category><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`,
  );
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function docxTitleParagraph(value: string): string {
  const runs = value
    .split("\n")
    .map(
      (line, index) =>
        `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`,
    )
    .join("");
  return `<w:p><w:pPr><w:pStyle w:val="${DOCX_TITLE_PAGE_STYLE}"/><w:jc w:val="center"/><w:spacing w:before="480" w:after="240"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="48"/></w:rPr>${runs}</w:r></w:p>`;
}

function docxTitlePageLabel(value: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="${DOCX_TITLE_PAGE_STYLE}"/><w:jc w:val="center"/><w:spacing w:after="480"/></w:pPr><w:r><w:rPr><w:i/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;
}

/** outlineLevel 写入段落大纲级别，Word 导航窗格与再次导入都据此识别标题。 */
export function docxParagraph(value: string, outlineLevel: 0 | 1 | null) {
  const heading = outlineLevel !== null;
  const lines = value.split("\n");
  const runs = lines
    .map(
      (line, index) =>
        `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`,
    )
    .join("");
  return `<w:p>${heading ? `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="160"/><w:outlineLvl w:val="${outlineLevel}"/></w:pPr>` : '<w:pPr><w:ind w:firstLineChars="200"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr>'}<w:r>${heading ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ""}${runs}</w:r></w:p>`;
}

export function renderMarkdown(
  project: { title: string; premise: string | null },
  sections: readonly { title: string; content: string }[],
) {
  return [
    `# ${project.title}`,
    project.premise ? `> ${project.premise}` : "",
    ...sections.flatMap((section) => [`## ${section.title}`, section.content]),
  ]
    .filter(Boolean)
    .join("\n\n")
    .trimEnd()
    .concat("\n");
}

export function renderText(
  project: { title: string; premise: string | null },
  sections: readonly { title: string; content: string }[],
) {
  return [
    project.title,
    project.premise ?? "",
    ...sections.flatMap((section) => [section.title, section.content]),
  ]
    .filter(Boolean)
    .join("\n\n")
    .trimEnd()
    .concat("\n");
}

export function markdownishToXhtml(content: string) {
  return content
    .split(/\n\s*\n/u)
    .map((paragraph) => {
      const value = paragraph.trim();
      const heading = value.match(/^#{1,3}\s+(.+)$/su);
      return heading
        ? `<h2>${escapeXml(heading[1]!)}</h2>`
        : `<p>${escapeXml(value).replace(/\n/gu, "<br/>")}</p>`;
    })
    .join("");
}

export function escapeXml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
