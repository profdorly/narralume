import { randomUuid } from "@narralume/domain";
import type { RouteApp } from "@narralume/services";

import {
  CloneHarnessTemplateRequestSchema,
  HarnessTemplateSchema,
  RestoreHarnessTemplateRequestSchema,
  UpdateHarnessTemplateRequestSchema,
} from "@narralume/contracts";
import { validateRecipeTemplateContent } from "@narralume/harness";
import {
  PROMPT_TEMPLATE_DEFINITIONS,
  serializeBilingualPromptText,
  validatePromptTemplateContent,
} from "@narralume/harness";
import {
  SqliteTemplateRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

const ParamsSchema = z.object({ key: z.string().min(1) });

export function seedHarnessTemplates(
  database: NarrativeDatabase,
  now = new Date().toISOString(),
): void {
  const promptSeeds = PROMPT_TEMPLATE_DEFINITIONS.map((definition) => ({
    id: definition.id,
    kind: "prompt" as const,
    key: definition.key,
    name: definition.name,
    description: definition.description,
    systemInvariants: serializeBilingualPromptText(definition.invariants),
    defaultContent: serializeBilingualPromptText(definition.instructions),
    updatedAt: now,
  }));
  new SqliteTemplateRepository(database).seed([
    ...promptSeeds,
    CHAPTER_PRODUCTION_RECIPE(now),
    COCREATE_REPLY_RECIPE(now),
  ]);
}

export function registerTemplateRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
): void {
  const templates = new SqliteTemplateRepository(database);
  app.route("GET", "/api/harness/templates", async () =>
    templates.list().map((template) => HarnessTemplateSchema.parse(template)),
  );
  app.route("PUT", "/api/harness/templates/:key", async (request) => {
    const { key } = ParamsSchema.parse(request.params);
    const input = UpdateHarnessTemplateRequestSchema.parse(request.body);
    const current = templates.getByKey(key);
    if (current?.kind === "recipe")
      validateRecipeTemplateContent(key, input.content);
    if (current?.kind === "prompt")
      validatePromptTemplateContent(input.content);
    return HarnessTemplateSchema.parse(
      templates.updateOverride(
        key,
        input.content,
        input.expectedVersion,
        new Date().toISOString(),
      ),
    );
  });
  app.route("POST", "/api/harness/templates/:key/restore", async (request) => {
    const { key } = ParamsSchema.parse(request.params);
    const input = RestoreHarnessTemplateRequestSchema.parse(request.body);
    return HarnessTemplateSchema.parse(
      templates.restoreDefault(
        key,
        input.expectedVersion,
        new Date().toISOString(),
      ),
    );
  });
  app.route("POST", "/api/harness/templates/:key/clone", async (request) => {
    const { key } = ParamsSchema.parse(request.params);
    const input = CloneHarnessTemplateRequestSchema.parse(request.body);
    return {
      status: 201,
      body: HarnessTemplateSchema.parse(
        templates.clone(key, {
          id: randomUuid(),
          ...input,
          updatedAt: new Date().toISOString(),
        }),
      ),
    };
  });
}

const CHAPTER_PRODUCTION_RECIPE = (now: string) => ({
  id: "recipe-chapter-production",
  kind: "recipe" as const,
  key: "recipe.chapter-production",
  name: "Receita de produção de capítulo",
  description:
    "Contexto, plano, prosa, verificação dupla, revisão, assentamento e registro.",
  systemInvariants:
    "O commit sempre vem depois das verificações e do settle; a verificação determinística não pode ser removida.",
  defaultContent: JSON.stringify(
    {
      steps: [
        "context.compile",
        "scene.plan",
        "draft.generate",
        "deterministic.check",
        "semantic.review",
        "revision.generate?",
        "chapter.settle",
        "chapter.commit",
      ],
      maxRevisionCycles: 2,
    },
    null,
    2,
  ),
  updatedAt: now,
});

const COCREATE_REPLY_RECIPE = (now: string) => ({
  id: "recipe-cocreate-reply",
  kind: "recipe" as const,
  key: "recipe.cocreate-reply",
  name: "Receita de resposta da cocriação",
  description:
    "Monta o contexto da sala de história, responde e guarda candidatos.",
  systemInvariants:
    "A resposta nunca entra sozinha no cânone ou no manuscrito; adotar exige uma receita própria.",
  defaultContent: JSON.stringify(
    { steps: ["cocreate.context", "cocreate.respond", "cocreate.stage"] },
    null,
    2,
  ),
  updatedAt: now,
});
