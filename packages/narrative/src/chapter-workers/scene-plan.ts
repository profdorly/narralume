import { type NarrativeRunStep, type RunSnapshot } from "@narralume/domain";
import type { StepExecutionResult } from "@narralume/harness";

import {
  SCENE_PLAN_CONTRACT,
  ScenePlanSchema,
  zodValidator,
} from "../schemas.js";

import {
  type ChapterWorkerDeps,
  chapterAuthoredInstructions,
  chapterWritingReference,
  purposeContextText,
  requiredArtifact,
} from "./helpers.js";

export async function planScenes(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
  step: NarrativeRunStep,
  signal: AbortSignal,
): Promise<StepExecutionResult> {
  const context = requiredArtifact(snapshot, "context.compile");
  const writingReference = chapterWritingReference(context);
  const result = await deps.model.structured(
    snapshot.run,
    step,
    "scene-plan",
    {
      instructions: chapterAuthoredInstructions(
        deps,
        snapshot.run.projectId,
        "prompt.scene-plan",
      ),
      messages: [
        {
          role: "user",
          content: [
            ...(writingReference
              ? [
                  "<chapter-writing-reference>",
                  `A extensão de referência do capítulo completo é cerca de ${writingReference.targetCharacters} caracteres. É só ritmo, não teto rígido; completeza e naturalidade vêm primeiro.`,
                  "Distribua número e amplitude das cenas para que a soma de scenes[].targetCharacters gire em torno dessa referência; não acrescente miolo só para encher.",
                  "Se a nota de direção ou o autor derem um tamanho mais específico, esse pedido vale.",
                  "</chapter-writing-reference>",
                ]
              : []),
            "Segue o contexto já compilado, com as fronteiras de autoridade:",
            purposeContextText(context, "scene-plan"),
          ].join("\n\n"),
        },
      ],
      maxOutputTokens: 3_000,
      temperature: 0.65,
      reasoningEffort: "low",
    },
    SCENE_PLAN_CONTRACT,
    zodValidator(ScenePlanSchema),
    signal,
  );
  return {
    artifactKind: "scene-plan",
    output: {
      ...result.value,
      generation: { mode: result.mode, attempts: result.attempts },
    },
    usage: result.usage,
  };
}
