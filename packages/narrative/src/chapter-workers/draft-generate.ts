import {
  type NarrativeRunStep,
  type RunStepError,
  type RunSnapshot,
} from "@narralume/domain";
import type { StepExecutionResult } from "@narralume/harness";

import {
  type ChapterWorkerDeps,
  chapterAuthoredInstructions,
  chapterWritingReference,
  cleanManuscript,
  continuationPrefixOf,
  isOutputLimitFinish,
  paragraphs,
  policyNumber,
  purposeContextText,
  requiredArtifact,
  retryable,
  sha256,
} from "./helpers.js";

export async function generateDraft(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
  step: NarrativeRunStep,
  signal: AbortSignal,
): Promise<StepExecutionResult> {
  const context = requiredArtifact(snapshot, "context.compile");
  const plan = requiredArtifact(snapshot, "scene.plan");
  // Set by POST /api/runs/:runId/streams/continue: the interrupted partial
  // becomes the chapter's existing beginning; the model only writes the
  // continuation and the final manuscript is prefix + generated part.
  const continuationPrefix = continuationPrefixOf(snapshot.run.policy);
  const writingReference = chapterWritingReference(context);
  const result = await deps.model.text(
    snapshot.run,
    step,
    "chapter-draft",
    {
      instructions: chapterAuthoredInstructions(
        deps,
        snapshot.run.projectId,
        "prompt.chapter-draft",
      ),
      messages: [
        {
          role: "user",
          content: [
            ...(writingReference
              ? [
                  "<chapter-writing-reference>",
                  `A extensão de referência do capítulo completo é cerca de ${writingReference.targetCharacters} caracteres. É só ritmo, não teto rígido; completeza e naturalidade vêm primeiro, não encha mecânica.`,
                  "Se a nota de direção ou o autor derem um tamanho mais específico, esse pedido vale.",
                  ...(continuationPrefix
                    ? [
                        `O começo já escrito tem ${[...continuationPrefix].length} caracteres; a referência é o total do capítulo, não um pedido de mais ${writingReference.targetCharacters} caracteres.`,
                      ]
                    : []),
                  "</chapter-writing-reference>",
                ]
              : []),
            "<compiled-context>",
            purposeContextText(context, "chapter-draft"),
            "</compiled-context>",
            "<scene-plan>",
            JSON.stringify(plan),
            "</scene-plan>",
            ...(continuationPrefix
              ? [
                  "<existing-beginning>",
                  continuationPrefix,
                  "</existing-beginning>",
                  "O <existing-beginning> acima é o começo já escrito deste capítulo e pode cortar no meio da frase. Continue daí: não repita, resuma nem reescreva o que já existe; entregue só a continuação nova.",
                ]
              : ["Escreva a prosa agora."]),
          ].join("\n"),
        },
      ],
      maxOutputTokens: policyNumber(
        snapshot.run.policy,
        "draftMaxOutputTokens",
        8_000,
      ),
      temperature: 0.82,
      reasoningEffort: "low",
    },
    signal,
  );
  const generated = cleanManuscript(result.text);
  if (isOutputLimitFinish(result.finishReason)) {
    throw <RunStepError>{
      code: "draft.output_limit",
      message:
        "The chapter manuscript hit the model output/context limit; generation can continue from the saved partial",
      retryable: true,
      details: {
        finishReason: result.finishReason,
        partial: true,
        recoveryActions: ["continue", "adopt", "regenerate"],
        partialCharacters: [...generated].length,
        partialHash: sha256(generated),
      },
      usage: result.usage,
    };
  }
  if (!generated) {
    throw {
      ...retryable("draft.empty", "The model returned no chapter manuscript"),
      usage: result.usage,
    };
  }
  const content = continuationPrefix
    ? continuationPrefix + generated
    : generated;
  return {
    artifactKind: "chapter-draft",
    output: {
      content,
      characters: [...content].length,
      paragraphs: paragraphs(content).length,
      contentHash: sha256(content),
      ...(continuationPrefix
        ? { continuationPrefixCharacters: [...continuationPrefix].length }
        : {}),
    },
    usage: result.usage,
  };
}
