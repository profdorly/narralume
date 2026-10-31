import { expect, test } from "@playwright/test";

test("story line suggestions: per-item decisions, evidence jumps, kept across reloads and stale protection", async ({
  page,
  request,
}, testInfo) => {
  const projectId = `line-proposals-${testInfo.project.name}`;
  const url = `/projects/${projectId}/bible?spread=outline&view=lines`;
  await page.goto(url);
  const panel = page.getByRole("region", {
    name: "Propostas de progresso das linhas da história",
    exact: true,
  });
  await expect(
    panel.getByRole("button", { name: "Aceitar proposta de progresso" }),
  ).toHaveCount(3);
  await panel
    .getByText("Resumos de evidência no momento da revisão", { exact: true })
    .first()
    .click();
  await expect(
    panel
      .getByText("见证者交出了旧信，潮声之谜仍未解决。", { exact: true })
      .first(),
  ).toBeVisible();
  await panel.getByRole("link", { name: "旧信的去向" }).first().click();
  await expect(page).toHaveURL(new RegExp(`outline=${projectId}-chapter`));
  await page.goto(url);
  await panel
    .getByRole("button", { name: "Aceitar proposta de progresso" })
    .first()
    .click();
  await expect(
    panel.getByText("Aceita e linha da história atualizada", { exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Recusar proposta" }).first().click();
  await expect(
    panel.getByText("Recusada; a linha da história permanece", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    panel.getByText("Aceita e linha da história atualizada", { exact: true }),
  ).toBeVisible();
  const compassUrl = `/api/projects/${projectId}/compass`;
  const {
    projectId: _id,
    version,
    updatedAt: _time,
    ...compass
  } = await (await request.get(compassUrl)).json();
  void _id;
  void _time;
  expect(
    (
      await request.put(compassUrl, {
        data: {
          ...compass,
          corePromise: "作者刚修改的方向",
          expectedVersion: version,
        },
      })
    ).ok(),
  ).toBe(true);
  await panel
    .getByRole("button", { name: "Aceitar proposta de progresso" })
    .click();
  await expect(
    panel.getByText(
      "As linhas da história ou as evidências do manuscrito mudaram. Revise uma proposta nova de etapa.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Aceitar proposta de progresso" }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("button", { name: "Recusar proposta" }),
  ).toBeEnabled();
  await expect(page.locator("body")).toHaveJSProperty(
    "scrollWidth",
    testInfo.project.use.viewport!.width,
  );
  await page.screenshot({
    path: testInfo.outputPath("story-line-proposals.png"),
    fullPage: true,
  });
  await page.evaluate(() => localStorage.setItem("lapis:ui-locale", "en"));
  await page.reload();
  const english = page.getByRole("region", {
    name: "Story line progress proposals",
    exact: true,
  });
  await expect(
    english.getByText("Accepted and story line updated", { exact: true }),
  ).toBeVisible();
  await expect(
    english.getByRole("button", { name: "Accept progress proposal" }),
  ).toBeDisabled();
  await expect(
    english.getByRole("button", { name: "Reject proposal" }),
  ).toBeEnabled();
});
