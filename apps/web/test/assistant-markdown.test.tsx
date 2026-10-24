// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MessageEntry } from "../src/app/assistant/timeline";
import { renderMarkdown } from "../src/app/assistant/markdown";
import { setLocale } from "../src/i18n";
import type { AssistantMessageDto } from "../src/lib/api";

beforeEach(() => setLocale("pt-BR"));
afterEach(cleanup);

function message(
  role: AssistantMessageDto["role"],
  content: string,
): AssistantMessageDto {
  return {
    id: `message-${role}`,
    conversationId: "conversation-1",
    role,
    content,
    context: null,
    sourceRunId: null,
    replyToMessageId: null,
    createdAt: "2026-10-24T12:00:00.000Z",
  };
}

describe("assistant Markdown", () => {
  it("keeps only the allowed tags and attributes", () => {
    const html = renderMarkdown(
      '**negrito** <img src=x onerror="alert(1)"> <script>alert(2)</script> [link](https://example.com "t")',
    );
    expect(html).toContain("<strong>negrito</strong>");
    expect(html).toContain('<a href="https://example.com" title="t">link</a>');
    expect(html).not.toMatch(/<img|<script|onerror/);
  });

  it("renders a reply as plain text first, then as sanitized Markdown", async () => {
    render(
      <MessageEntry message={message("assistant", "Um **ponto** importante")} />,
    );
    await waitFor(() =>
      expect(screen.getByText("ponto").tagName).toBe("STRONG"),
    );
  });

  it("never parses the author's own message as Markdown", () => {
    render(<MessageEntry message={message("user", "Meu **texto**")} />);
    expect(screen.getByText("Meu **texto**").tagName).toBe("P");
  });
});
