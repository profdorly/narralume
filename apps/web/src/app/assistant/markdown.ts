import DOMPurify from "dompurify";
import { marked } from "marked";

/* Assistant replies use restricted Markdown: marked parses, DOMPurify
   sanitizes against XSS. Loaded on demand (see timeline.tsx), so the two
   libraries stay out of the main bundle. */
export function renderMarkdown(content: string): string {
  const raw = marked.parse(content, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "b", "i", "code", "pre", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "a", "hr", "del", "span",
    ],
    ALLOWED_ATTR: ["href", "title", "target", "rel"],
  });
}
