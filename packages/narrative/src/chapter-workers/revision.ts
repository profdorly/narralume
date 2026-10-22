import {
  type NarrativeRunStep,
  type RunStepError,
  type RunSnapshot,
} from "@narralume/domain";
import type { StepExecutionResult } from "@narralume/harness";

import {
  type ChapterWorkerDeps,
  chapterAuthoredInstructions,
  finalContent,
  isOutputLimitFinish,
  isRecord,
  isRevisionNoop,
  latestGateArtifact,
  permanent,
  policyNumber,
  purposeContextText,
  requestedRevisionSource,
  requiredArtifact,
  revisionManuscript,
  sha256,
  stringField,
  stringOrNull,
  buildTextDiff,
} from "./helpers.js";

export async function generateRevision(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
  step: NarrativeRunStep,
  signal: AbortSignal,
): Promise<StepExecutionResult> {
  const isRequestedRevision =
    snapshot.run.recipe === "chapter-candidate-revision" &&
    step.id.endsWith(":revise:requested");
  const requestedSource = isRequestedRevision
    ? requestedRevisionSource(deps, snapshot)
    : null;
  const baseContent = requestedSource
    ? finalContent(requestedSource)
    : finalContent(snapshot);
  if (!baseContent.trim()) {
    throw permanent(
      "revision.base_manuscript.missing",
      "The revision run has no complete source manuscript available",
    );
  }
  const revisionInstruction = isRequestedRevision
    ? stringField(snapshot.run.policy, "revisionInstruction")
    : null;
  const review = isRequestedRevision
    ? {
        verdict: "revise",
        summary: revisionInstruction,
        issues: [],
        source: "author_revision_request",
      }
    : latestGateArtifact(snapshot);
  const context = requiredArtifact(snapshot, "context.compile");
  const result = await deps.model.text(
    snapshot.run,
    step,
    "chapter-revision",
    {
      instructions: chapterAuthoredInstructions(
        deps,
        snapshot.run.projectId,
        "prompt.chapter-revision",
        { craft: true },
      ),
      messages: [
        {
          role: "user",
          content: [
            `<authoritative-context>${purposeContextText(context, "chapter-revision")}</authoritative-context>`,
            revisionInstruction
              ? `<author-revision-instruction>${revisionInstruction}</author-revision-instruction>`
              : "",
            `<review>${JSON.stringify(review)}</review>`,
            "<base-manuscript>",
            baseContent,
            "</base-manuscript>",
          ].join("\n"),
        },
      ],
      maxOutputTokens: policyNumber(
        snapshot.run.policy,
        "draftMaxOutputTokens",
        8_000,
      ),
      temperature: 0.55,
      reasoningEffort: "low",
    },
    signal,
  );
  const content = revisionManuscript(result.text);
  if (isOutputLimitFinish(result.finishReason)) {
    throw <RunStepError>{
      code: "revision.output_limit",
      message:
        "The full revision hit the model output/context limit; truncated text cannot be promoted to a new manuscript",
      retryable: true,
      details: {
        finishReason: result.finishReason,
        partial: true,
        partialCharacters: [...content].length,
        partialHash: sha256(content),
      },
      usage: result.usage,
    };
  }
  if (isRevisionNoop(baseContent, content)) {
    const reason = content.length === 0 ? "empty_output" : "line_endings_only";
    if (isRequestedRevision) {
      throw <RunStepError>{
        code: "revision.requested_noop",
        message: "AI did not produce a materially changed version as requested",
        retryable: true,
        details: { reason, baseHash: sha256(baseContent) },
        usage: result.usage,
      };
    }
    return {
      artifactKind: "revision_noop",
      output: {
        content: baseContent,
        noop: true,
        reason,
        baseHash: sha256(baseContent),
        contentHash: sha256(baseContent),
        characters: [...baseContent].length,
      },
      usage: result.usage,
    };
  }
  const characters = [...content].length;
  const minimumCharacters = policyNumber(
    snapshot.run.policy,
    "minChapterCharacters",
    1_200,
  );
  if (characters < minimumCharacters) {
    throw <RunStepError>{
      code: "revision.incomplete",
      message: `The revision returned only ${characters} characters, below the full manuscript minimum of ${minimumCharacters}`,
      retryable: true,
      details: {
        characters,
        minimumCharacters,
        outputHash: sha256(content),
      },
      usage: result.usage,
    };
  }
  const proposalId = `${step.id}:proposal`;
  const issueIds = Array.isArray(review.issues)
    ? review.issues
        .map((issue) =>
          isRecord(issue) && typeof issue.id === "string" ? issue.id : null,
        )
        .filter((id): id is string => Boolean(id))
    : [];
  deps.reviews.insertRevisionProposal({
    id: proposalId,
    projectId: snapshot.run.projectId,
    runId: snapshot.run.id,
    stepId: step.id,
    baseDocumentVersionId: stringOrNull(context.baseVersionId),
    revisedContent: content,
    diff: buildTextDiff(baseContent, content),
    addressedIssueIds: issueIds,
    status: "proposed",
    createdAt: deps.now().toISOString(),
  });
  return {
    artifactKind: "chapter-revision",
    output: {
      content,
      proposalId,
      baseHash: sha256(baseContent),
      contentHash: sha256(content),
      characters: [...content].length,
      diff: buildTextDiff(baseContent, content),
    },
    usage: result.usage,
  };
}
