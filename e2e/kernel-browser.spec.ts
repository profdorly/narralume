import { expect, test } from "@playwright/test";

const KERNEL_READY_TIMEOUT = 40_000;

/**
 * M3 验收：浏览器本地内核（Worker + OPFS）承载 UI 主链。
 * 显式把驱动锁到 local（localStorage 覆盖），全程不依赖 Node API——
 * 尽管Playwright webServer 仍在，页面请求一律走内核 RouteTable。
 * 链路：建项目 → 大纲 → 写作台手写并保存版本 → 交付备份 → reload 持久
 * → 运行中心可访问。
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("narralume:driver", "local"),
  );
});

test("本地内核 UI 主链: 建项目 → 大纲 → 写作 → 版本持久 → 运行中心", async ({
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

  // 空白建书（无模型也可用的纯项目创建）。
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

  // 大纲：创建章节节点。
  await page.getByRole("link", { name: "Ir para História" }).click();
  await page.getByRole("button", { name: "Ver Estrutura" }).click();
  await page.getByLabel("Tipo").selectOption({ label: "Capítulo" });
  await page.getByLabel("Título").fill(chapterTitle);
  await page.getByLabel("Resumo").fill("林昇回港当夜，灯塔突然熄灭。");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByRole("status")).toContainText("Salvo no servidor");
  await page.getByLabel("Alvo da edição").selectOption({ label: chapterTitle });
  await page
    .getByRole("link", { name: "Escrever este capítulo na mesa de escrita" })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/studio\\?outline=`),
  );
  const chapterId = new URL(page.url()).searchParams.get("outline")!;
  expect(chapterId).toBeTruthy();

  // 写作台：创建文档 + 手写正文并保存版本（手动创作永远可用）。
  await page.getByRole("button", { name: "Criar" }).click();
  const editor = page.getByLabel("Editor do corpo em Markdown");
  await expect(editor).toBeVisible();
  await editor.fill(body);
  await page.getByRole("button", { name: "Salvar nova versão" }).click();
  await expect(page.getByRole("status")).toContainText(
    /Versão registrada|versões/,
  );

  // 重启持久性：reload 后内核从 OPFS 重开，章节文档与正文仍在。
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
  await expect(page.getByRole("status")).toContainText("Salvo no servidor");
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

  // runs 账本在 local 驱动下可用（运行中心空态；窄屏导航折叠，直接按地址访问）。
  await page.goto(`/projects/${projectId}/runs`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/runs`));

  // 下载我的库（D6）：local 驱动从内核导出完整 SQLite bytes。
  const download = page.waitForEvent("download");
  await page.goto("/settings");
  await expect(
    page.getByRole("button", { name: /Baixar minha biblioteca/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Baixar minha biblioteca/ }).click();
  const library = await download;
  expect(library.suggestedFilename()).toMatch(/\.sqlite$/);
});
