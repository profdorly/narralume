import { expect, test, type Page } from "@playwright/test";

const TERMINAL_RUN_STATUSES = new Set([
  "awaiting_user",
  "cancelled",
  "completed",
  "failed",
]);

test("after the project assistant finishes dispatching, backup and restore keep the full collaboration history", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1440",
    "high-risk flows run only once, on the desktop baseline",
  );
  const projectId = await createProject(page, `协作恢复-${Date.now()}`);
  const userMessage = "帮我整理故事方向，并保留为待确认任务。";
  const assistantReply = "已整理为待确认的故事方向任务，确认后才会执行。";
  const backupLabel = `协作全量恢复-${Date.now()}`;

  await page.goto(`/projects/${projectId}/overview`);
  await page
    .getByRole("button", { name: "Abrir colaboração no projeto" })
    .click();
  const composer = page.getByLabel("Mensagem para o assistente do projeto");
  await composer.fill(userMessage);
  const acceptedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/assistant\/conversations\/[^/]+\/messages$/u.test(
        new URL(response.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  const accepted = (await (await acceptedResponse).json()) as { runId: string };
  await advanceRunToTerminal(page, projectId, accepted.runId, "completed");
  await expect(page.getByText(assistantReply, { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await expect(
    page.getByRole("button", { name: "Confirmar e executar" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Fechar colaboração no projeto" })
    .click();

  await page.goto(`/projects/${projectId}/delivery`);
  await page.getByLabel("Rótulo do backup").fill(backupLabel);
  await page
    .getByRole("button", { name: "Criar instantâneo do conteúdo" })
    .click();
  const backupRow = page.locator(".delivery__backup-row", {
    hasText: backupLabel,
  });
  await expect(backupRow).toBeVisible();
  await backupRow
    .getByRole("button", { name: "Restaurar cópia do conteúdo" })
    .click();
  await page
    .getByRole("alertdialog", { name: "Restaurar instantâneo do conteúdo" })
    .getByRole("button", { name: "Restaurar cópia do conteúdo" })
    .click();
  const restoredLink = page.getByRole("link", {
    name: "Abrir a cópia restaurada",
  });
  await expect(restoredLink).toBeVisible();
  await restoredLink.click();
  const restoredProjectId = new URL(page.url()).pathname.split("/")[2]!;
  const conversations = await apiGet<{ id: string }[]>(
    page,
    `/api/projects/${restoredProjectId}/assistant/conversations`,
  );
  const collaboration = await apiGet<{
    messages: { role: string; content: string }[];
    activities: { status: string }[];
  }>(page, `/api/assistant/conversations/${conversations[0]!.id}`);
  expect(collaboration.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: "user", content: userMessage }),
      expect.objectContaining({ role: "assistant", content: assistantReply }),
    ]),
  );
  expect(collaboration.activities).toContainEqual(
    expect.objectContaining({ status: "proposed" }),
  );

  await page
    .getByRole("button", { name: "Abrir colaboração no projeto" })
    .click();
  await expect(page.getByText(userMessage, { exact: true })).toBeVisible();
  await expect(page.getByText(assistantReply, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar e executar" }),
  ).toBeVisible();
});

test("a Canon candidate is generated and decided through the UI and written into the author intent", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1440",
    "high-risk flows run only once, on the desktop baseline",
  );
  const projectId = await createProject(page, `Canon候选-${Date.now()}`);

  await page.goto(`/projects/${projectId}/bible?spread=intent`);
  await page
    .getByLabel("Instrução de edição do cânone")
    .fill("收紧第一次熄灯的记忆代价。 ");
  const startedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(
        `/api/projects/${projectId}/canon-spreads/intent/candidates`,
      ),
  );
  await page.getByRole("button", { name: "Gerar mudanças candidatas" }).click();
  const started = (await (await startedResponse).json()) as { runId: string };
  await advanceRunToTerminal(page, projectId, started.runId, "completed");

  await expect(page.getByText("收紧失灯代价", { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await page.getByRole("button", { name: "Adotar este item" }).click();
  await expect(
    page.getByText("每次灯塔熄灭，都有人失去一段不能复原的记忆。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Adotado", { exact: true })).toBeVisible();
});

test("a fatal quick-creation failure parks and can be retried from the UI as a new task", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1440",
    "high-risk flows run only once, on the desktop baseline",
  );
  const projectId = await createProject(page, `失败恢复-${Date.now()}`);
  const created = await apiPost<{ id: string }>(
    page,
    `/api/projects/${projectId}/autopilot/sessions`,
    {
      requestId: crypto.randomUUID(),
      approvalMode: "continuous",
      targetChapters: 2,
      windowSize: 2,
      maxRevisionCycles: 0,
    },
    202,
  );
  await apiPost(
    page,
    `/api/autopilot/sessions/${created.id}/advance`,
    undefined,
  );
  let detail = await apiGet<AutopilotDetail>(
    page,
    `/api/autopilot/sessions/${created.id}`,
  );
  const failedRunId = detail.session.currentRunId!;
  await advanceRunToTerminal(page, projectId, failedRunId, "failed");
  await apiPost(
    page,
    `/api/autopilot/sessions/${created.id}/advance`,
    undefined,
  );
  detail = await apiGet<AutopilotDetail>(
    page,
    `/api/autopilot/sessions/${created.id}`,
  );
  expect(detail.session.status).toBe("awaiting_user");

  await page.goto(`/projects/${projectId}/autopilot?session=${created.id}`);
  await expect(
    page.getByText("Esta criação foi interrompida. Escolha o próximo passo:"),
  ).toBeVisible();
  const retriedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(
        `/api/autopilot/sessions/${created.id}/resolutions`,
      ),
  );
  await page
    .getByRole("button", { name: "Tentar de novo o capítulo atual" })
    .click();
  const retried = (await (await retriedResponse).json()) as AutopilotDetail;
  expect(retried.session.status).toBe("running");

  await apiPost(
    page,
    `/api/autopilot/sessions/${created.id}/advance`,
    undefined,
  );
  detail = await apiGet<AutopilotDetail>(
    page,
    `/api/autopilot/sessions/${created.id}`,
  );
  expect(detail.session.status).toBe("planning");
  expect(detail.session.currentRunId).not.toBe(failedRunId);
  await page.reload();
  await expect(
    page.getByText("Planejando", { exact: true }).first(),
  ).toBeVisible();
});

interface AutopilotDetail {
  session: {
    status: string;
    currentRunId: string | null;
  };
}

async function createProject(page: Page, title: string): Promise<string> {
  const project = await apiPost<{ id: string }>(
    page,
    "/api/projects",
    {
      requestId: crypto.randomUUID(),
      title,
      premise: "灯塔每次熄灭，港口都会失去一段共同记忆。",
    },
    201,
  );
  return project.id;
}

async function advanceRunToTerminal(
  page: Page,
  projectId: string,
  runId: string,
  expectedStatus: string,
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await apiPost<{
      snapshot: { run: { status: string } };
    }>(page, `/api/runs/${runId}/advance`, { projectId });
    const status = result.snapshot.run.status;
    if (TERMINAL_RUN_STATUSES.has(status)) {
      expect(status).toBe(expectedStatus);
      return;
    }
  }
  throw new Error(`Run ${runId} did not reach a terminal status.`);
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  if (response.status() !== 200) {
    throw new Error(
      `GET ${path} returned ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

async function apiPost<T>(
  page: Page,
  path: string,
  data: unknown,
  expectedStatus = 200,
): Promise<T> {
  const response = await page.request.post(path, {
    ...(data === undefined ? {} : { data }),
  });
  if (response.status() !== expectedStatus) {
    throw new Error(
      `POST ${path} returned ${response.status()}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}
