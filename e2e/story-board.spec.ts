import { expect, test } from "@playwright/test";

test("the whole-book board shows the structure, filters chapters and opens the manuscript", async ({
  page,
  request,
}, testInfo) => {
  const projectResponse = await request.post("/api/projects", {
    data: { requestId: crypto.randomUUID(), title: "Ver a história inteira" },
  });
  expect(projectResponse.ok()).toBe(true);
  const project = (await projectResponse.json()) as { id: string };
  const bible = (await (
    await request.get(`/api/projects/${project.id}/story-bible`)
  ).json()) as { outline: { id: string; kind: string }[] };
  const root = bible.outline.find((node) => node.kind === "book")!;
  const createNode = async (
    parentId: string,
    kind: string,
    title: string,
    ordinal: number,
  ) => {
    const response = await request.post(`/api/projects/${project.id}/outline`, {
      data: {
        parentId,
        kind,
        title,
        ordinal,
        summary: "追索旧港的失踪事件，保留人物选择与后续展开空间。",
        goal: "查明信件来源",
        conflict: "证人不愿透露旧事",
        metadata: {},
      },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { id: string };
  };
  const volume = await createNode(root.id, "volume", "第一卷 · 旧港", 0);
  const arc = await createNode(volume.id, "arc", "回声与失踪者", 0);
  const first = await createNode(arc.id, "chapter", "第一章 · 退潮后的信", 0);
  const second = await createNode(arc.id, "chapter", "第二章 · 沉默的证人", 1);
  const nextVolume = await createNode(root.id, "volume", "第二卷 · 新城", 1);
  const nextArc = await createNode(nextVolume.id, "arc", "新城线索", 0);
  const createClue = async (title: string) => {
    const response = await request.post(
      `/api/projects/${project.id}/foreshadows`,
      {
        data: {
          title,
          description: "信件在证人口中获得解释",
          status: "planted",
          importance: 3,
          targetFromNodeId: first.id,
          targetToNodeId: second.id,
          resolutionNodeId: null,
          dependencies: [],
          evidenceNodeIds: [first.id],
        },
      },
    );
    expect(response.ok()).toBe(true);
  };
  await createClue("信件的来历");
  await page.goto(`/projects/${project.id}/bible?spread=outline&view=board`);
  const board = page.getByRole("region", {
    name: "Ver a história inteira",
    exact: true,
  });
  await expect(
    board.getByRole("heading", { name: "第一章 · 退潮后的信" }),
  ).toBeVisible();
  await expect(board.getByText("第一卷 · 旧港 / 回声与失踪者")).toHaveCount(2);
  await board
    .getByRole("button", { name: "Mover “第一章 · 退潮后的信” para depois" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Salvar mudança de estrutura" })
    .click();
  await expect(board.getByRole("status")).toHaveText(
    "Ordem dos capítulos salva.",
  );
  await expect(
    board.getByRole("complementary", {
      name: "Janelas de antecipação a ajustar",
    }),
  ).toBeVisible();
  await expect(board.locator("article h3").first()).toHaveText(
    "第二章 · 沉默的证人",
  );
  await page.reload();
  await expect(board.locator("article h3").first()).toHaveText(
    "第二章 · 沉默的证人",
  );
  await board.getByLabel("Status do capítulo").selectOption("committed");
  await expect(
    board.getByText("Nenhum capítulo corresponde a estes filtros."),
  ).toBeVisible();
  await board.getByLabel("Status do capítulo").selectOption("all");
  await board.getByLabel("Personagem de POV").selectOption("unknown");
  await expect(
    board.getByRole("button", {
      name: "Mover “第一章 · 退潮后的信” para antes",
    }),
  ).toBeDisabled();
  await board.getByLabel("Personagem de POV").selectOption("all");
  await board
    .getByRole("button", { name: "Mover “第一章 · 退潮后的信” para antes" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Salvar mudança de estrutura" })
    .click();
  await expect(board.locator("article h3").first()).toHaveText(
    "第一章 · 退潮后的信",
  );
  await expect(
    board.getByRole("complementary", {
      name: "Janelas de antecipação a ajustar",
    }),
  ).toHaveCount(0);
  await board
    .getByRole("button", {
      name: "Mover “第一章 · 退潮后的信” para outro lugar",
    })
    .click();
  const dialog = page.getByRole("alertdialog", {
    name: "Revisar mudança de estrutura",
  });
  await dialog.getByLabel("Volume ou arco de destino").selectOption(nextArc.id);
  await dialog
    .getByRole("button", { name: "Atualizar prévia de impacto" })
    .click();
  await expect(
    dialog.getByText(
      "A janela de pagamento começa depois de terminar. Ajuste esta janela de antecipação depois de salvar.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText("Nenhuma tarefa ativa é afetada."),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("structure-preview.png"),
    fullPage: true,
  });
  // A new promise added after preview must be reviewed before the move saves.
  await createClue("后来补充的承诺");
  await dialog
    .getByRole("button", { name: "Salvar mudança de estrutura" })
    .click();
  await expect(
    dialog.getByText(
      "A estrutura, as tarefas relacionadas ou as antecipações mudaram. Atualize a prévia de impacto antes de salvar.",
    ),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Atualizar prévia de impacto" })
    .click();
  await expect(
    dialog.getByText("后来补充的承诺", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Salvar mudança de estrutura" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    board.getByText("第二卷 · 新城 / 新城线索", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    board.getByText("第二卷 · 新城 / 新城线索", { exact: true }),
  ).toBeVisible();
  await expect(
    board.getByRole("complementary", {
      name: "Janelas de antecipação a ajustar",
    }),
  ).toBeVisible();
  await expect(
    board.getByRole("link", { name: "Abrir na mesa de escrita" }),
  ).toHaveCount(2);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("story-board.png"),
    fullPage: true,
  });
  await board
    .locator("article")
    .filter({
      has: page.getByRole("heading", {
        name: "第一章 · 退潮后的信",
        exact: true,
      }),
    })
    .getByRole("link", { name: "Abrir na mesa de escrita" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/studio\\?outline=${first.id}`));
});
