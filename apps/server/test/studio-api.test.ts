import type { NarrativeModelClient } from "@lapis/narrative";
import { NodeNarrativeDatabase } from "@lapis/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};
const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop();
    await resource?.app.close();
    resource?.database.close();
  }
});

describe("studio API", () => {
  it("saves drafts, resolves comments, and accepts selection-edit diffs", async () => {
    const database = new NodeNarrativeDatabase();
    const app = await buildApp({
      config,
      database,
      environment: {
        NARRATIVE_LLM_API_KEY: "server-only-test-key",
        NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
        NARRATIVE_LLM_MODEL: "test-model",
        NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
        NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
      },
      narrativeModelClient: studioModel(),
      enableRunWorker: false,
      logger: false,
    });
    resources.push({ app, database });

    const project = await request<{ id: string }>(
      app,
      "POST",
      "/api/projects",
      {
        requestId: globalThis.crypto.randomUUID(),
        title: "回声邮局",
        premise: "退潮时，未寄出的信会抵达记忆消失之前。",
      },
      201,
    );
    const created = await request<{ id: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/documents`,
      {
        requestId: "studio-manuscript",
        kind: "manuscript",
        title: "灯下潮痕",
        outlineNodeId: null,
      },
      201,
    );
    const documentId = created.id;
    await request(
      app,
      "POST",
      `/api/projects/${project.id}/documents/${documentId}/versions`,
      {
        content:
          "沈砚把空白信移到煤油灯上方。盐粒从纸背析出，在灯光里连成一道潮线。她没有立刻拆开信封，只用指腹触了触边缘。",
        source: "manual",
        expectedCurrentVersionId: null,
      },
      201,
    );
    let document = await request<StudioDocument>(
      app,
      "GET",
      `/api/projects/${project.id}/studio/documents/${documentId}`,
      undefined,
      200,
    );
    expect(document.currentVersion?.content).toContain("盐粒");
    const autosavedDraft = await request<{
      baseVersionId: string | null;
      content: string;
      contentHash: string;
    }>(
      app,
      "PUT",
      `/api/projects/${project.id}/studio/documents/${documentId}/draft`,
      {
        baseVersionId: document.currentVersion!.id,
        expectedDraftUpdatedAt: null,
        content: `${document.currentVersion!.content}\n这是一段尚未发布的草稿。`,
      },
      200,
    );
    expect(autosavedDraft).toMatchObject({
      baseVersionId: document.currentVersion!.id,
    });
    expect(autosavedDraft.contentHash).toMatch(/^[a-f0-9]{64}$/);
    document = await request<StudioDocument>(
      app,
      "GET",
      `/api/projects/${project.id}/studio/documents/${documentId}`,
      undefined,
      200,
    );
    expect(document.draft?.content).toContain("尚未发布的草稿");
    expect(document.versions).toHaveLength(1);
    const selectionStart = autosavedDraft.content.indexOf("盐粒");
    const selectionEnd = selectionStart + 2;
    const comment = await request<{ id: string; status: string }>(
      app,
      "POST",
      `/api/projects/${project.id}/studio/documents/${documentId}/comments`,
      {
        versionId: document.currentVersion!.id,
        startOffset: selectionStart,
        endOffset: selectionEnd,
        quote: "盐粒",
        body: "把触感写得更清楚。",
      },
      201,
    );
    expect(comment.status).toBe("open");
    expect(
      await request<{ status: string }>(
        app,
        "PUT",
        `/api/studio/comments/${comment.id}`,
        { status: "resolved" },
        200,
      ),
    ).toMatchObject({ status: "resolved" });

    const editRun = await request<{
      run: { id: string; policy: Record<string, unknown> };
      origin: {
        surface: string;
        documentId: string;
        selection: { start: number; end: number };
      };
    }>(
      app,
      "POST",
      `/api/projects/${project.id}/studio/documents/${documentId}/selection-edits`,
      {
        baseVersionId: document.currentVersion!.id,
        draftContentHash: autosavedDraft.contentHash,
        selectionStart,
        selectionEnd,
        instruction: "增强触觉，但不改变事实。",
        policy: { maxRetries: 0 },
      },
      202,
    );
    expect(editRun.run.policy).toMatchObject({
      maxRetries: 0,
      qualityPreset: "standard",
    });
    expect(editRun.origin).toEqual({
      surface: "writing",
      documentId,
      selection: { start: selectionStart, end: selectionEnd },
    });
    expect(await finishRun(app, project.id, editRun.run.id)).toBe("completed");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/runs/${editRun.run.id}?projectId=${project.id}`,
        })
      ).json(),
    ).toMatchObject({
      result: { editProposalId: `${editRun.run.id}:proposal` },
    });
    document = await request<StudioDocument>(
      app,
      "GET",
      `/api/projects/${project.id}/studio/documents/${documentId}`,
      undefined,
      200,
    );
    expect(document.proposals[0]).toMatchObject({ status: "proposed" });
    const accepted = await request<{
      status: string;
      acceptedVersionId: string;
    }>(
      app,
      "POST",
      `/api/studio/edit-proposals/${document.proposals[0]!.id}/actions`,
      {
        action: "accept",
        requestId: `${document.proposals[0]!.id}:accept`,
      },
      200,
    );
    expect(accepted.status).toBe("accepted");
    const replayed = await request<{
      status: string;
      acceptedVersionId: string;
    }>(
      app,
      "POST",
      `/api/studio/edit-proposals/${document.proposals[0]!.id}/actions`,
      {
        action: "accept",
        requestId: `${document.proposals[0]!.id}:accept`,
      },
      200,
    );
    expect(replayed).toEqual(accepted);
    const conflicting = await app.inject({
      method: "POST",
      url: `/api/studio/edit-proposals/${document.proposals[0]!.id}/actions`,
      payload: {
        action: "reject",
        requestId: `${document.proposals[0]!.id}:reject`,
      },
    });
    expect(conflicting.statusCode, conflicting.body).toBe(409);
    expect(conflicting.json()).toMatchObject({
      error: { code: "edit_proposal.already_decided" },
    });
    document = await request<StudioDocument>(
      app,
      "GET",
      `/api/projects/${project.id}/studio/documents/${documentId}`,
      undefined,
      200,
    );
    expect(document.versions).toHaveLength(3);
    expect(document.currentVersion?.content).toContain("粗粝盐粒");
    expect(document.currentVersion?.content).toContain("尚未发布的草稿");
  });
});

async function finishRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  runId: string,
) {
  let status = "pending";
  for (let index = 0; index < 40; index += 1) {
    const response = await request<{ snapshot: { run: { status: string } } }>(
      app,
      "POST",
      `/api/runs/${runId}/advance`,
      { projectId },
      200,
    );
    status = response.snapshot.run.status;
    if (
      ["completed", "failed", "cancelled", "awaiting_user"].includes(status)
    ) {
      break;
    }
  }
  return status;
}

async function request<T = unknown>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload: Record<string, unknown> | undefined,
  expected: number,
): Promise<T> {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  expect(response.statusCode, response.body).toBe(expected);
  return response.json() as T;
}

function studioModel(): NarrativeModelClient {
  const usage = {
    inputTokens: 100,
    outputTokens: 100,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 5,
  };
  return {
    async text() {
      return { text: "unused", usage };
    },
    async structured(_run, _step, purpose, _request, _contract, validate) {
      if (purpose !== "selection-edit") {
        throw new Error(`unexpected purpose ${purpose}`);
      }
      const checked = validate({
        replacementText: "粗粝盐粒",
        rationale: "增加触觉而不改变物体与动作",
        risk: "low",
      });
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return { value: checked.data, usage, mode: "native", attempts: 1 };
    },
  } as NarrativeModelClient;
}

interface StudioDocument {
  currentVersion: { id: string; content: string } | null;
  draft: { content: string; baseVersionId: string | null } | null;
  versions: unknown[];
  proposals: { id: string; status: string }[];
}
