import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Page } from "@playwright/test";

import { EXAMPLE_PROJECT_ID } from "./fixtures/example-book.js";

/* npm run docs:screenshots — retakes the user-guide screenshots in
   assets/lapis-*-1920x1080.png (light theme, Portuguese UI).

   Needs the app running (npm run dev) on a library that has the example book
   (npm run seed:example) and a model assigned, so the assistant shows its
   composer. The script adds the three extra shelf books once, by title, and
   puts the demo cover on one of them. Pass --url=<web url> for another port. */

const root = fileURLToPath(new URL("..", import.meta.url));
const baseUrl = (
  process.argv.find((argument) => argument.startsWith("--url="))?.slice(6) ??
  "http://127.0.0.1:4318"
).replace(/\/$/, "");

const SHELF_BOOKS = [
  {
    title: "Inventário do Inverno",
    subtitle: "Novela",
    form: "novella",
    premise:
      "Uma tradutora herda a casa da avó em Curitiba e precisa decidir o que guardar antes da primeira geada.",
  },
  {
    title: "Contos de Rodoviária",
    subtitle: "Contos",
    form: "short-story",
    premise:
      "Doze contos curtos sobre quem espera, chega e vai embora na rodoviária de uma cidade do interior.",
  },
  {
    title: "A Serra das Sete Estrelas",
    subtitle: "Romance",
    form: "novel",
    premise:
      "Uma astrônoma amadora volta à cidade natal na serra para fechar o observatório do pai e encontra um caderno de observações que ele nunca mostrou a ninguém.",
    cover: { file: "assets/lapis-demo-cover.jpg", width: 900, height: 1200 },
  },
] as const;

interface ProjectSummary {
  id: string;
  title: string;
  subtitle: string | null;
  premise: string | null;
  archivedAt: string | null;
  updatedAt: string;
  cover: unknown;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function prepareLibrary(): Promise<void> {
  const projects = await api<ProjectSummary[]>("/api/projects");
  if (!projects.some((project) => project.id === EXAMPLE_PROJECT_ID)) {
    throw new Error(
      "The example book is missing; run npm run seed:example first.",
    );
  }
  for (const book of SHELF_BOOKS) {
    let project = projects.find((item) => item.title === book.title);
    if (!project) {
      project = await api<ProjectSummary>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          requestId: randomUUID(),
          title: book.title,
          subtitle: book.subtitle,
          premise: book.premise,
          language: "pt-BR",
          form: book.form,
        }),
      });
    }
    if ("cover" in book && !project.cover) {
      await api(`/api/projects/${project.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: project.title,
          subtitle: project.subtitle,
          premise: project.premise,
          archived: project.archivedAt !== null,
          expectedUpdatedAt: project.updatedAt,
          cover: {
            action: "put",
            mediaType: "image/jpeg",
            imageBase64: readFileSync(join(root, book.cover.file)).toString(
              "base64",
            ),
            width: book.cover.width,
            height: book.cover.height,
            crop: { x: 0.5, y: 0.5, zoom: 1 },
          },
        }),
      });
    }
  }
}

const project = `/projects/${EXAMPLE_PROJECT_ID}`;
const SHOTS: { name: string; path: string; assistant?: boolean }[] = [
  { name: "shelf", path: "/shelf" },
  { name: "overview", path: `${project}/overview` },
  { name: "bible", path: `${project}/bible` },
  { name: "studio", path: `${project}/studio` },
  { name: "autopilot", path: `${project}/autopilot` },
  { name: "assistant", path: `${project}/overview`, assistant: true },
  { name: "runs", path: `${project}/runs` },
  { name: "lab", path: `${project}/lab` },
  { name: "settings", path: "/settings" },
  { name: "delivery", path: `${project}/delivery` },
];

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // Lets entry transitions and lazy panels finish.
  await page.waitForTimeout(1200);
}

await prepareLibrary();
const browser = await chromium.launch();
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: "pt-BR",
      colorScheme: "light",
    });
    await context.addInitScript((assistantOpen) => {
      window.localStorage.setItem("lapis:ui-locale", "pt-BR");
      window.localStorage.setItem(
        "lapis:assistant-open",
        assistantOpen ? "1" : "0",
      );
    }, shot.assistant === true);
    const page = await context.newPage();
    await page.goto(`${baseUrl}${shot.path}`);
    await settle(page);
    const file = join(root, "assets", `lapis-${shot.name}-1920x1080.png`);
    await page.screenshot({ path: file });
    process.stdout.write(`${file}\n`);
    await context.close();
  }
} finally {
  await browser.close();
}
