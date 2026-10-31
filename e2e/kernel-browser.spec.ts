import { expect, test } from "@playwright/test";

const KERNEL_READY_TIMEOUT = 40_000;

/**
 * M3 acceptance: the in-browser local kernel (Worker + OPFS) carries the main
 * UI flow. The driver is pinned to local explicitly (localStorage override) and
 * nothing depends on the Node API: although the Playwright webServer is still
 * running, every page request goes through the kernel RouteTable.
 * Flow: create project → outline → write by hand in the studio and save a
 * version → delivery backup → reload persists → the run center is reachable.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lapis:driver", "local"));
});

test("local kernel main UI flow: create project → outline → write → version persists → run center", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}`;
  const title = `内核潮汐-${suffix}`;
  const chapterTitle = `雾港内核-${suffix}`;
  const body =
    "林昇回港当夜，灯塔突然熄灭。退潮前，他在石阶下找到一封没有署名的信。";

  await page.goto("/");
  await expect(page.locator(".status-pill__label").first()).toHaveText(
    "Núcleo online",
    { timeout: KERNEL_READY_TIMEOUT },
  );

  // Blank book creation (plain project creation that works without a model).
  await page.getByRole("button", { name: /Livro em branco/ }).click();
  await page.getByLabel("Título").fill(title);
  await page
    .getByLabel(/Premissa/)
    .fill("失灯的守塔人必须在退潮前找回一封信。");
  await page
    .getByRole("button", { name: "Criar e colocar na estante" })
    .click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/overview$/);
  const projectId = new URL(page.url()).pathname.split("/")[2];
  expect(projectId).toBeTruthy();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // Outline: create a chapter node.
  await page.getByRole("link", { name: "Ir para História" }).click();
  await page.getByRole("button", { name: "Ver Estrutura" }).click();
  await page.getByLabel("Tipo").selectOption({ label: "Capítulo" });
  await page.getByLabel("Título").fill(chapterTitle);
  await page.getByLabel("Resumo").fill("林昇回港当夜，灯塔突然熄灭。");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Salvo no servidor" }),
  ).toBeVisible();
  await page.getByLabel("Alvo da edição").selectOption({ label: chapterTitle });
  await page
    .getByRole("link", { name: "Escrever este capítulo na mesa de escrita" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/studio\\?outline=`),
  );
  const chapterId = new URL(page.url()).searchParams.get("outline")!;
  expect(chapterId).toBeTruthy();

  // Studio: create a document + write text by hand and save a version (manual
  // writing is always available).
  await page.getByRole("button", { name: "Criar", exact: true }).click();
  const editor = page.getByLabel("Editor do corpo em Markdown");
  await expect(editor).toBeVisible();
  await editor.fill(body);
  await page.getByRole("button", { name: "Salvar nova versão" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /Versão registrada|versões/ }),
  ).toBeVisible();

  // Restart persistence: after reload the kernel reopens from OPFS and the
  // chapter document and text are still there.
  await page.reload();
  await expect(page.locator(".status-pill__label").first()).toHaveText(
    "Núcleo online",
    { timeout: KERNEL_READY_TIMEOUT },
  );
  await expect(editor).toBeVisible();
  await expect(editor).toContainText(/灯塔突然熄灭/);

  // The same chapter-state route also runs in the browser's local database.
  await page.goto(
    `/projects/${projectId}/bible?spread=outline&view=state&chapter=${encodeURIComponent(chapterId)}`,
  );
  const stateView = page.getByRole("region", {
    name: "Estado do capítulo",
    exact: true,
  });
  await expect(stateView.getByLabel("Até o capítulo")).toHaveValue(chapterId);
  await expect(
    stateView.getByText(
      "Não há conhecimento pertinente registrado até este capítulo. Isso não estabelece que o personagem ou o leitor desconheça o fato.",
    ),
  ).toBeVisible();

  // Manual knowledge follows the same local route/transaction path, including
  // correction history after reopening the OPFS database.
  await page.goto(`/projects/${projectId}/bible?spread=timeline`);
  const timelineEditor = page.getByRole("region", {
    name: "Editar Linha do tempo",
    exact: true,
  });
  await timelineEditor
    .getByLabel("Título", { exact: true })
    .fill("内核中的失灯事件");
  await timelineEditor.getByLabel("Início", { exact: true }).fill("第一夜");
  await timelineEditor
    .getByRole("button", { name: "Salvar", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Salvo no servidor" }),
  ).toBeVisible();
  await page.goto(
    `/projects/${projectId}/bible?spread=outline&view=state&chapter=${encodeURIComponent(chapterId)}`,
  );
  await page
    .getByRole("button", { name: "Registrar e corrigir conhecimento" })
    .click();
  const knowledgeEditor = page.getByRole("region", {
    name: "Manutenção do conhecimento da obra",
    exact: true,
  });
  await knowledgeEditor
    .getByRole("button", {
      name: "Registrar mudança de conhecimento",
      exact: true,
    })
    .click();
  const registration = knowledgeEditor.getByRole("form", {
    name: "Registrar mudança de conhecimento",
    exact: true,
  });
  await registration
    .getByLabel("Afirmação conhecida")
    .selectOption({ label: "内核中的失灯事件 · Sem nó vinculado" });
  await registration.getByLabel("Estado de crença").selectOption("suspected");
  await registration
    .getByRole("button", { name: "Salvar registro de conhecimento" })
    .click();
  await expect(knowledgeEditor.getByRole("status")).toContainText(
    "Conhecimento salvo",
  );
  await knowledgeEditor
    .getByRole("article")
    .getByRole("button", { name: "Corrigir registro", exact: true })
    .click();
  const correction = knowledgeEditor.getByRole("form", {
    name: "Corrigir registro",
    exact: true,
  });
  await correction.getByLabel("Estado de crença").selectOption("known");
  await correction
    .getByLabel("Motivo da correção ou da retirada")
    .fill("正文中已明确点出事件");
  await correction
    .getByRole("button", { name: "Salvar registro de conhecimento" })
    .click();
  await expect(knowledgeEditor.getByRole("status")).toContainText(
    "Conhecimento salvo",
  );
  await page.reload();
  const knowledge = stateView.getByRole("region", {
    name: "Registros de conhecimento",
    exact: true,
  });
  await expect(knowledge.getByText("Soube", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Registrar e corrigir conhecimento" })
    .click();
  await expect(knowledgeEditor.getByText("正文中已明确点出事件")).toBeVisible();
  await knowledgeEditor
    .getByRole("article")
    .filter({ hasText: "Registro válido" })
    .getByRole("button", { name: "Retirar registro", exact: true })
    .click();
  const withdrawal = knowledgeEditor.getByRole("form", {
    name: "Retirar registro",
    exact: true,
  });
  await withdrawal
    .getByLabel("Motivo da correção ou da retirada")
    .fill("认知主体有误，撤销后重登");
  await withdrawal
    .getByRole("button", { name: "Retirar registro", exact: true })
    .click();
  await expect(knowledgeEditor.getByRole("status")).toContainText(
    "Conhecimento salvo",
  );
  await page.reload();
  await expect(knowledge.getByRole("article")).toHaveCount(0);

  // The runs ledger works under the local driver (run center empty state; on
  // narrow screens the navigation collapses, so go by URL).
  await page.goto(`/projects/${projectId}/runs`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/runs`));

  // Download my library (D6): the local driver exports the full SQLite bytes
  // from the kernel.
  const download = page.waitForEvent("download");
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: /Baixar minha biblioteca/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Baixar minha biblioteca/ }).click();
  const library = await download;
  expect(library.suggestedFilename()).toMatch(/\.sqlite$/);
});
