import { expect, test } from "@playwright/test";
import type { StoryCompassDto } from "@lapis/contracts";

test("long-running story lines keep stage records and protect concurrent edits", async ({
  page,
  request,
}, testInfo) => {
  const projectResponse = await request.post("/api/projects", {
    data: { requestId: crypto.randomUUID(), title: "持续展开的雾港" },
  });
  expect(projectResponse.ok()).toBe(true);
  const { id: projectId } = (await projectResponse.json()) as { id: string };
  const url = `/api/projects/${projectId}/compass`;
  const initial = {
    corePromise: "每次遗忘都留下代价",
    endingDirection: null,
    longLines: [],
    themeQuestions: [],
    constraints: ["保持远期展开空间"],
    target: { chapters: 100, wordsPerChapter: 3000, volumes: 4 },
  };
  expect(
    (
      await request.put(url, { data: { ...initial, expectedVersion: null } })
    ).ok(),
  ).toBe(true);
  const bible = (await (
    await request.get(`/api/projects/${projectId}/story-bible`)
  ).json()) as { outline: { id: string; kind: string }[] };
  const root = bible.outline.find((node) => node.kind === "book")!;
  const node = async (
    parentId: string,
    kind: string,
    title: string,
    ordinal = 0,
  ) => {
    const response = await request.post(`/api/projects/${projectId}/outline`, {
      data: { parentId, kind, title, ordinal },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { id: string; updatedAt: string };
  };
  const volume = await node(root.id, "volume", "第一卷 · 港内");
  const arc = await node(volume.id, "arc", "寻找见证者");
  const chapter = await node(arc.id, "chapter", "第一章 · 旧信件");
  await node(arc.id, "chapter", "第二章 · 尚未发生的会面", 1);
  expect(
    (
      await request.put(`/api/projects/${projectId}/outline/${chapter.id}`, {
        data: { status: "committed", expectedUpdatedAt: chapter.updatedAt },
      })
    ).ok(),
  ).toBe(true);

  await page.goto(`/projects/${projectId}/bible?spread=outline&view=lines`);
  const lines = page.getByRole("region", {
    name: "Linhas longas da história",
    exact: true,
  });
  await expect(
    lines.getByText(
      "Ainda não há linhas longas da história. Comece por uma promessa que você queira desenvolver ao longo do tempo.",
    ),
  ).toBeVisible();
  await lines
    .getByRole("button", { name: "Adicionar linha da história", exact: true })
    .click();
  let form = lines.getByRole("form", {
    name: "Adicionar linha da história",
    exact: true,
  });
  await form.getByLabel("Nome da linha da história").fill("失踪者的名字");
  await form.getByLabel("Promessa geral").fill("逐步揭示遗忘规则与人的选择");
  await form
    .getByLabel("Status da linha da história")
    .selectOption("developing");
  await form.getByLabel("Etapa atual").selectOption(arc.id);
  await form.getByLabel("Objetivo da etapa").fill("找到另一名见证者");
  await form
    .getByLabel("Nota de progresso da autoria")
    .fill("已确认旧信件上的笔迹");
  await form
    .getByLabel("Promessas em aberto")
    .fill("信件的收件人\n灯塔关闭的代价");
  await form
    .getByLabel("Próximo desdobramento")
    .fill("让调查触及港口之外，保留远期问题");
  await expect(
    form.getByRole("checkbox", { name: "第二章 · 尚未发生的会面" }),
  ).toHaveCount(0);
  await form.getByRole("checkbox", { name: "第一章 · 旧信件" }).check();
  await form
    .getByRole("button", { name: "Salvar linha da história", exact: true })
    .click();
  await expect(lines.getByRole("status")).toHaveText(
    "Linha da história salva para o planejamento seguinte.",
  );
  await page.reload();
  const card = lines.getByRole("article", {
    name: "失踪者的名字",
    exact: true,
  });
  await expect(card.getByText("第一卷 · 港内 / 寻找见证者")).toBeVisible();
  await expect(card.getByText("已确认旧信件上的笔迹")).toBeVisible();
  await expect(
    card.getByRole("link", { name: "第一章 · 旧信件" }),
  ).toHaveAttribute(
    "href",
    `/projects/${projectId}/studio?outline=${chapter.id}`,
  );
  await expect(
    lines.getByText(
      "As revisões de etapa aparecem aqui depois que a escrita contínua conclui uma janela.",
    ),
  ).toBeVisible();

  await card
    .getByRole("button", { name: "Editar linha da história “失踪者的名字”" })
    .click();
  form = lines.getByRole("form", {
    name: "Editar linha da história",
    exact: true,
  });
  await form.getByLabel("Próximo desdobramento").fill("这次编辑尚未保存的方向");
  const current = (await (await request.get(url)).json()) as StoryCompassDto;
  const { projectId: _id, updatedAt: _time, version, ...fields } = current;
  void _id;
  void _time;
  expect(
    (
      await request.put(url, {
        data: {
          ...fields,
          corePromise: "另一窗口更新的全书承诺",
          expectedVersion: version,
        },
      })
    ).ok(),
  ).toBe(true);
  await form
    .getByRole("button", { name: "Salvar linha da história", exact: true })
    .click();
  await expect(
    form.getByText(
      "A bússola da história foi atualizada por outro processo; atualize e salve de novo",
    ),
  ).toBeVisible();
  await expect(form.getByLabel("Próximo desdobramento")).toHaveValue(
    "这次编辑尚未保存的方向",
  );
  expect(
    ((await (await request.get(url)).json()) as StoryCompassDto).longLines[0]!
      .development!.nextDevelopment,
  ).toBe("让调查触及港口之外，保留远期问题");
  await form
    .getByRole("button", { name: "Descartar alterações e recarregar" })
    .click();
  await expect(form).toHaveCount(0);
  await expect(
    lines.getByText("另一窗口更新的全书承诺", { exact: false }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Editar linha da história “失踪者的名字”" })
    .click();
  form = lines.getByRole("form", {
    name: "Editar linha da história",
    exact: true,
  });
  await form
    .getByLabel("Próximo desdobramento")
    .fill("保持作者最新方向，并展开新的调查阻力");
  await form
    .getByRole("button", { name: "Salvar linha da história", exact: true })
    .click();
  await expect(
    card.getByText("保持作者最新方向，并展开新的调查阻力"),
  ).toBeVisible();
  expect(
    ((await (await request.get(url)).json()) as StoryCompassDto).corePromise,
  ).toBe("另一窗口更新的全书承诺");
  await page.screenshot({
    path: testInfo.outputPath("story-lines.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await card
    .getByRole("button", { name: "Remover linha da história “失踪者的名字”" })
    .click();
  await page
    .getByRole("alertdialog", { name: "Remover linha longa da história" })
    .getByRole("button", { name: "Remover linha da história", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  const after = (await (await request.get(url)).json()) as StoryCompassDto;
  expect(after.longLines).toEqual([]);
  expect(after.constraints).toEqual(initial.constraints);
  await page.evaluate(() => localStorage.setItem("lapis:ui-locale", "en"));
  await page.reload();
  const english = page.getByRole("region", {
    name: "Long story lines",
    exact: true,
  });
  await expect(
    english.getByRole("button", { name: "Add story line", exact: true }),
  ).toBeVisible();
  await english
    .getByRole("button", { name: "Add story line", exact: true })
    .click();
  await expect(english.getByLabel("Author progress note")).toBeVisible();
});
