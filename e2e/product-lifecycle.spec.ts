import { expect, test, type Locator } from "@playwright/test";

async function selectEditorRange(editor: Locator, start: number, end: number) {
  await editor.evaluate(
    (element, range) => {
      element.focus();
      const walker = element.ownerDocument.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
      );
      let pos = 0;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const length = node.data.length;
        if (!startNode && pos + length >= range.start) {
          startNode = node;
          startOffset = range.start - pos;
        }
        if (pos + length >= range.end) {
          endNode = node;
          endOffset = range.end - pos;
          break;
        }
        pos += length;
      }
      if (!startNode || !endNode) return;
      const selectionRange = element.ownerDocument.createRange();
      selectionRange.setStart(startNode, startOffset);
      selectionRange.setEnd(endNode, endOffset);
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(selectionRange);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      element.ownerDocument.dispatchEvent(new Event("selectionchange"));
    },
    { start, end },
  );
}

test("主链只经由 UI: 设置 → 建书 → 大纲 → 写作 → AI 接续 → 交付", async ({
  page,
}, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const providerName = `E2E 模型服务 ${suffix}`;
  const modelName = `e2e-writer-${suffix}`;
  const title = `潮汐回归-${suffix}`;
  const chapterTitle = `雾港失灯-${suffix}`;
  const body =
    "林昇回港当夜，灯塔突然熄灭。退潮前，他在石阶下找到一封没有署名的信。";
  const comment = "这里要保留失灯发生的突然感。";
  const backupLabel = `交付验收-${suffix}`;

  await page.goto("/settings");
  await expect(
    page.getByRole("main").getByText("Configurações", { exact: true }),
  ).toBeVisible();

  // 供给管理收纳在 <details> 里，先展开再进“模型渠道”列。
  await page
    .getByRole("group", { name: "Gestão de provedores e modelos" })
    .locator("summary")
    .click();
  const providerSection = page.getByRole("region", {
    name: "Provedores de modelo",
  });
  await providerSection.getByRole("button", { name: "Novo" }).click();
  const providerForm = providerSection.locator("form.supply__editor");
  await providerForm.getByLabel("Nome do provedor").fill(providerName);
  await providerForm.getByLabel("Base URL").fill("https://e2e.example.com/v1");
  await providerForm
    .getByLabel("Chave ou env:NAME")
    .fill("e2e-placeholder-key");
  await providerForm.getByRole("button", { name: "Salvar" }).click();
  await expect(
    providerSection.getByText(providerName, { exact: true }),
  ).toBeVisible();

  const modelSection = page.getByRole("region", {
    name: "Modelos",
    exact: true,
  });
  await modelSection.getByRole("button", { name: "Novo" }).click();
  const modelForm = modelSection.locator("form.supply__editor");
  await modelForm.getByLabel("Nome do modelo na origem").fill(modelName);
  await modelForm.getByLabel("Limite de contexto").fill("16000");
  await modelForm.getByLabel("Limite de saída").fill("2000");
  await modelForm.getByRole("button", { name: "Salvar" }).click();
  await expect(
    modelSection.getByText(modelName, { exact: true }),
  ).toBeVisible();

  const writingRole = page.locator(".supply__role", {
    hasText: "Modelo padrão de geração",
  });
  await writingRole
    .getByRole("button", { name: new RegExp(modelName) })
    .click();
  await expect(
    writingRole.getByText("Atribuído", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Ir para Estante" }).click();
  await expect(
    page.getByRole("heading", { name: "A Estante", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Livro em branco/ }).click();
  await page.getByLabel("Título").fill(title);
  await page
    .getByLabel(/Premissa/)
    .fill("失灯的守塔人必须在退潮前找回一封信。");
  await page
    .getByRole("button", { name: "Criar e colocar na estante" })
    .click();

  await expect(page).toHaveURL(/\/projects\/[^/]+\/overview$/);
  const projectUrl = new URL(page.url());
  const projectId = projectUrl.pathname.split("/")[2];
  expect(projectId).toBeTruthy();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  const storyLink = page.getByRole("link", { name: "Ir para História" });
  await expect(storyLink).toHaveAttribute(
    "href",
    `/projects/${projectId}/bible`,
  );
  await storyLink.click();
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
  await page.getByRole("button", { name: "Criar", exact: true }).click();
  const editor = page.getByLabel("Editor do corpo em Markdown");
  await expect(editor).toBeVisible();
  await editor.fill(body);
  await selectEditorRange(editor, 0, 8);
  await page.getByRole("tab", { name: "Seleção" }).click();
  await page.getByLabel("Comentário").fill(comment);
  const saveCommentButton = page.getByRole("button", {
    name: "Salvar versão e comentar",
  });
  await expect(saveCommentButton).toBeEnabled();
  await saveCommentButton.click();
  await page.getByRole("tab", { name: "Comentários" }).click();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();

  await selectEditorRange(editor, 9, 17);
  await page.getByRole("tab", { name: "Seleção" }).click();
  await page
    .getByLabel("Instrução de reescrita da IA")
    .fill("让这句话更克制。 ");
  const createProposalButton = page.getByRole("button", {
    name: "Gerar proposta de reescrita",
  });
  await expect(createProposalButton).toBeEnabled();
  await createProposalButton.click();
  await expect(
    page.getByRole("link", { name: "Ver o andamento da execução" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Passar para a IA" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${projectId}/studio\\?.*run=`),
  );
  await expect(
    page.getByRole("region", { name: "Tarefa de escrita com IA" }),
  ).toBeVisible();
  await expect(
    page.getByText("Rascunho candidato da IA", { exact: true }),
  ).toBeVisible();

  if (testInfo.project.name === "mobile-375") {
    const railBox = await page.locator(".rail").boundingBox();
    expect(railBox?.height ?? 999).toBeLessThanOrEqual(80);
    const links = page.locator(".rail__nav .rail__item");
    await expect(links).toHaveCount(5);
    for (let index = 0; index < 5; index += 1) {
      const box = await links.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator(".rail__nav .rail__item-label")).toHaveCount(5);
  }

  await page.getByRole("link", { name: "Ir para Entrega" }).click();
  await expect(
    page.getByRole("main").getByText("Entrega", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/As checagens de qualidade só avisam/),
  ).toBeVisible();
  await page.getByLabel("Rótulo do backup").fill(backupLabel);
  await page
    .getByRole("button", { name: "Criar instantâneo do conteúdo" })
    .click();
  await expect(page.getByText(backupLabel, { exact: true })).toBeVisible();

  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Exportar a obra atual como Markdown" })
    .click();
  await expect((await download).suggestedFilename()).toMatch(/\.md$/);

  const backupRow = page.locator(".delivery__backup-row", {
    hasText: backupLabel,
  });
  await backupRow
    .getByRole("button", { name: "Restaurar cópia do conteúdo" })
    .click();
  await page
    .getByRole("alertdialog", { name: "Restaurar instantâneo do conteúdo" })
    .getByRole("button", { name: "Restaurar cópia do conteúdo" })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Restaurado como um projeto novo." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Abrir a cópia restaurada" }),
  ).toBeVisible();

  if (testInfo.project.name === "desktop-1440") {
    await page.getByRole("link", { name: "Ir para Configurações" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/settings\\?project=${projectId}`),
    );
    await expect(
      page.getByRole("link", { name: "Voltar ao projeto" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Voltar ao projeto" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/delivery`));
  }
});
