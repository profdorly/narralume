import type { RunStepKind } from "@lapis/domain";

import type { ChapterRecipe, RunStepSeed } from "./recipe.js";

const CHAPTER_TEMPLATE_ORDER = [
  "context.compile",
  "scene.plan",
  "draft.generate",
  "deterministic.check",
  "semantic.review",
  "revision.generate?",
  "chapter.settle",
  "chapter.commit",
] as const;

/* Matches each recipe's step budget: model-call steps get 5 attempts,
   persistence/deterministic steps 1-2. */
const DEFAULT_ATTEMPTS: Readonly<Record<RunStepKind, number>> = {
  "context.compile": 2,
  "scene.plan": 5,
  "draft.generate": 5,
  "deterministic.check": 1,
  "semantic.review": 5,
  "revision.generate": 5,
  "chapter.settle": 5,
  "chapter.commit": 1,
  "foundation.generate": 5,
  "foundation.stage": 1,
  "outline.generate": 5,
  "outline.entities": 1,
  "outline.commit": 1,
  "steer.classify": 5,
  "arc.review": 5,
  "volume.review": 5,
  "cocreate.context": 2,
  "cocreate.respond": 5,
  "cocreate.stage": 1,
  "adoption.prepare": 1,
  "adoption.settle": 5,
  "adoption.commit": 1,
  "edit.transform": 5,
  "edit.stage": 1,
  "import.analyze": 5,
  "import.stage": 1,
  "style.extract": 3,
  "assistant.context": 1,
  "assistant.respond": 5,
  "assistant.stage": 1,
  "canon.context": 1,
  "canon.candidate": 5,
  "canon.stage": 1,
};

interface ParsedStep {
  kind: string;
  maxAttempts: number;
}

export function compileChapterRecipeTemplate(
  runId: string,
  content: string,
  requestedRevisionCycles: number,
  templateVersion: number,
): ChapterRecipe {
  const parsed = parseTemplate(content);
  assertExactOrder(parsed.steps, CHAPTER_TEMPLATE_ORDER, "chapter-production");
  const configuredCycles = integerInRange(
    parsed.root.maxRevisionCycles,
    0,
    5,
    2,
    "maxRevisionCycles",
  );
  const cycles = Math.min(
    Math.max(0, Math.min(requestedRevisionCycles, 5)),
    configuredCycles,
  );
  const attempts = new Map(
    parsed.steps.map((step) => [step.kind, step.maxAttempts]),
  );
  const steps: RunStepSeed[] = [];
  const append = (key: string, kind: RunStepKind, cycle: number) => {
    steps.push({
      id: `${runId}:${key}`,
      ordinal: steps.length,
      kind,
      cycle,
      idempotencyKey: `${runId}/${key}`,
      maxAttempts:
        attempts.get(kind) ??
        attempts.get(`${kind}?`) ??
        DEFAULT_ATTEMPTS[kind],
    });
  };
  append("context", "context.compile", 0);
  append("plan", "scene.plan", 0);
  append("draft", "draft.generate", 0);
  for (let cycle = 0; cycle <= cycles; cycle += 1) {
    append(`check:${cycle}`, "deterministic.check", cycle);
    append(`review:${cycle}`, "semantic.review", cycle);
    if (cycle < cycles) append(`revise:${cycle}`, "revision.generate", cycle);
  }
  append("settle", "chapter.settle", cycles);
  append("commit", "chapter.commit", cycles);
  return {
    name: "chapter-production",
    version: Math.max(1, templateVersion + 1),
    maxRevisionCycles: cycles,
    steps,
  };
}

/** Contos usam a mesma cadeia com zero ciclos de revisão. */
export function compileFormAwareChapterRecipe(
  runId: string,
  content: string,
  requestedRevisionCycles: number,
  templateVersion: number,
  form: string | null | undefined,
): ChapterRecipe {
  const short = form === "short-story";
  const recipe = compileChapterRecipeTemplate(
    runId,
    content,
    short ? 0 : requestedRevisionCycles,
    templateVersion,
  );
  return short ? { ...recipe, name: "short-story" } : recipe;
}

export function validateRecipeTemplateContent(
  key: string,
  content: string,
): void {
  if (key === "recipe.chapter-production") {
    compileChapterRecipeTemplate("validation", content, 5, 0);
    return;
  }
  parseTemplate(content);
}

function parseTemplate(content: string): {
  root: Record<string, unknown>;
  steps: ParsedStep[];
} {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new RecipeTemplateError(
      "recipe.template.invalid_json",
      `Recipe template is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RecipeTemplateError(
      "recipe.template.invalid",
      "Recipe template must be a JSON object",
    );
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.steps) || root.steps.length === 0)
    throw new RecipeTemplateError(
      "recipe.template.steps_missing",
      "Recipe template is missing steps",
    );
  const steps = root.steps.map((entry, index) => parseStep(entry, index));
  const kinds = steps.map((step) => step.kind);
  if (new Set(kinds).size !== kinds.length)
    throw new RecipeTemplateError(
      "recipe.template.duplicate_step",
      "Recipe template must not contain duplicate step definitions",
    );
  return { root, steps };
}

function parseStep(value: unknown, index: number): ParsedStep {
  const rawKind =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).kind
        : null;
  if (typeof rawKind !== "string" || !rawKind.trim())
    throw new RecipeTemplateError(
      "recipe.template.step_invalid",
      `Step ${index + 1} is missing kind`,
    );
  const kind = rawKind.trim();
  const baseKind = kind.endsWith("?") ? kind.slice(0, -1) : kind;
  if (!(baseKind in DEFAULT_ATTEMPTS))
    throw new RecipeTemplateError(
      "recipe.template.step_unsupported",
      `Unsupported recipe step: ${kind}`,
    );
  const candidate =
    typeof value === "object" && value && !Array.isArray(value)
      ? (value as Record<string, unknown>).maxAttempts
      : undefined;
  return {
    kind,
    maxAttempts: integerInRange(
      candidate,
      1,
      10,
      DEFAULT_ATTEMPTS[baseKind as RunStepKind],
      `steps[${index}].maxAttempts`,
    ),
  };
}

function assertExactOrder(
  steps: readonly ParsedStep[],
  expected: readonly string[],
  recipe: string,
): void {
  const actual = steps.map((step) => step.kind);
  if (
    actual.length !== expected.length ||
    actual.some((kind, index) => kind !== expected[index])
  )
    throw new RecipeTemplateError(
      "recipe.template.invariant",
      `${recipe} must keep ${expected.join(" -> ")}; settle and the safety gate must come before commit`,
    );
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new RecipeTemplateError(
      "recipe.template.value_invalid",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  return Number(value);
}

export class RecipeTemplateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RecipeTemplateError";
  }
}
