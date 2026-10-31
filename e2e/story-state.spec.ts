import { expect, test } from "@playwright/test";

test("按章核对认知、关系与伏笔证据，刷新和导航保留定位", async ({
  page,
}, testInfo) => {
  await page.goto(
    "/projects/state-fixture/bible?spread=outline&view=state&chapter=state-c2",
  );
  const view = page.getByRole("region", {
    name: "Estado do capítulo",
    exact: true,
  });
  const knowledge = () =>
    view.getByRole("region", {
      name: "Registros de conhecimento",
      exact: true,
    });
  await expect(knowledge().getByRole("article")).toHaveCount(4);
  const clue = view.getByRole("article", { name: "两份证词的矛盾" });
  await expect(
    clue.getByText("Status atual do plano: Resolvida"),
  ).toBeVisible();
  await expect(
    clue.getByRole("link", { name: "第1章 · 旧证词" }),
  ).toBeVisible();
  await expect(
    clue.getByRole("link", { name: "第2章 · 熄灯之夜 / 塔下的目击者" }),
  ).toBeVisible();
  await expect(
    clue.getByRole("link", { name: "第12章 · 证词翻转" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("chapter-state-author.png"),
    fullPage: true,
  });
  await view
    .getByRole("link", { name: "Gerenciar antecipações", exact: true })
    .click();
  await expect(page).toHaveURL(
    /spread=foreshadows&view=state&chapter=state-c2/,
  );
  await page
    .getByRole("button", { name: "Ver Estrutura", exact: true })
    .click();
  await expect(view.getByLabel("Até o capítulo")).toHaveValue("state-c2");

  await view
    .getByLabel("Perspectiva do conhecimento")
    .selectOption("character:state-hero");
  await expect(knowledge().getByRole("article")).toHaveCount(2);
  await expect(
    knowledge().getByText("Crença falsa", { exact: true }),
  ).toBeVisible();
  await expect(
    knowledge().getByText("Suspeita", { exact: true }),
  ).toBeVisible();
  await expect(knowledge().getByText("林澈 · 灯塔控制者 · 议会")).toBeVisible();
  await expect(view.getByText("守灯人", { exact: false })).toHaveCount(0);
  await expect(clue).toHaveCount(0);
  const relationships = view.getByRole("region", {
    name: "Relações registradas",
    exact: true,
  });
  await expect(relationships.getByRole("article")).toHaveCount(1);
  await expect(
    relationships.getByText("互相怀疑", { exact: false }),
  ).toBeVisible();
  const evidence = knowledge().getByRole("link", {
    name: "第2章 · 熄灯之夜 / 塔下的目击者",
  });
  await expect(evidence).toHaveAttribute(
    "href",
    "/projects/state-fixture/studio?outline=state-c2",
  );
  await evidence.click();
  await expect(page).toHaveURL(/studio\?outline=state-c2$/);
  await page.goBack();
  await expect(view.getByLabel("Perspectiva do conhecimento")).toHaveValue(
    "character:state-hero",
  );

  await view.getByLabel("Até o capítulo").selectOption("state-c12");
  await expect(knowledge().getByText("Soube", { exact: true })).toHaveCount(2);
  await expect(
    knowledge().getByText("Crença falsa", { exact: true }),
  ).toHaveCount(0);
  await expect(
    knowledge().getByText("林澈 · 灯塔控制者 · 守灯人"),
  ).toBeVisible();
  await expect(
    relationships.getByText("交换证据后结盟", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(view.getByLabel("Até o capítulo")).toHaveValue("state-c12");
  await expect(view.getByLabel("Perspectiva do conhecimento")).toHaveValue(
    "character:state-hero",
  );
  await expect(knowledge().getByText("Soube", { exact: true })).toHaveCount(2);
  await view.getByLabel("Até o capítulo").selectOption("state-c2");
  await view.getByLabel("Perspectiva do conhecimento").selectOption("reader");
  await expect(knowledge().getByRole("article")).toHaveCount(1);
  await expect(
    knowledge().getByText("Acredita", { exact: true }),
  ).toBeVisible();
  await view
    .getByLabel("Perspectiva do conhecimento")
    .selectOption("character:state-outsider");
  await expect(
    knowledge().getByText(
      "Não há conhecimento pertinente registrado até este capítulo. Isso não estabelece que o personagem ou o leitor desconheça o fato.",
    ),
  ).toBeVisible();

  await view
    .getByLabel("Perspectiva do conhecimento")
    .selectOption("character:state-hero");
  await expect(
    knowledge().getByText("Crença falsa", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("chapter-state-character.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => localStorage.setItem("lapis:ui-locale", "en"));
  await page.reload();
  const englishView = page.getByRole("region", {
    name: "Chapter state",
    exact: true,
  });
  await expect(
    englishView.getByText("False belief", { exact: true }),
  ).toBeVisible();
  await expect(
    englishView.getByText("Suspected", { exact: true }),
  ).toBeVisible();
  await expect(englishView.getByLabel("Through chapter")).toHaveValue(
    "state-c2",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("章节状态空作品入口与看板直达", async ({ page, request }) => {
  const response = await request.post("/api/projects", {
    data: { requestId: crypto.randomUUID(), title: "空作品状态" },
  });
  expect(response.ok()).toBe(true);
  const project = (await response.json()) as { id: string };
  await page.goto(`/projects/${project.id}/bible?spread=outline&view=state`);
  await expect(
    page.getByText(
      "Adicione um capítulo para inspecionar o estado da história capítulo a capítulo.",
    ),
  ).toBeVisible();
  await page.goto("/projects/state-fixture/bible?spread=outline&view=board");
  await page
    .getByRole("link", { name: "Ver estado do capítulo", exact: true })
    .nth(1)
    .click();
  await expect(page.getByLabel("Até o capítulo")).toHaveValue("state-c2");
  await expect(
    page
      .getByRole("region", { name: "Registros de conhecimento", exact: true })
      .getByRole("article"),
  ).toHaveCount(4);
  await page.goto(
    "/projects/state-fixture/bible?spread=outline&view=state&chapter=missing",
  );
  await expect(
    page.getByText(
      "O capítulo selecionado está ausente ou abandonado. Selecione outro capítulo.",
    ),
  ).toBeVisible();
  await page.getByLabel("Até o capítulo").selectOption("state-c1");
  await expect(
    page
      .getByRole("region", { name: "Registros de conhecimento", exact: true })
      .getByRole("article"),
  ).toHaveCount(1);
});
