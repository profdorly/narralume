import { type NarrativeRunStep, type RunSnapshot } from "@narralume/domain";
import type { StepExecutionResult } from "@narralume/harness";

import { ParagraphLocator } from "../paragraph-locator.js";
import {
  REVIEW_CONTRACT,
  ReviewResultSchema,
  deriveReviewResult,
  zodValidator,
} from "../schemas.js";

import {
  type ChapterWorkerDeps,
  chapterAuthoredInstructions,
  documentReviewTarget,
  finalContent,
  groundReviewEvidence,
  paragraphLocator,
  policyNumber,
  purposeContextText,
  requestedRevisionSource,
  requiredArtifact,
  reviewSemanticIssues,
} from "./helpers.js";

export async function semanticReview(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
  step: NarrativeRunStep,
  signal: AbortSignal,
): Promise<StepExecutionResult> {
  const documentReview = documentReviewTarget(deps, snapshot);
  const content = documentReview?.content ?? finalContent(snapshot);
  const context = requiredArtifact(snapshot, "context.compile");
  const plan = documentReview
    ? {
        chapterTitle: documentReview.outlineNode.title,
        goal: documentReview.outlineNode.goal,
        summary: documentReview.outlineNode.summary,
        mode: "review-current-version",
      }
    : requiredArtifact(
        snapshot.run.recipe === "chapter-candidate-revision"
          ? requestedRevisionSource(deps, snapshot)
          : snapshot,
        "scene.plan",
      );
  const locator = documentReview
    ? new ParagraphLocator(content, {
        documentVersionId: documentReview.version.id,
      })
    : paragraphLocator(deps, snapshot.run.projectId, content, context);
  const result = await deps.model.structured(
    snapshot.run,
    step,
    "semantic-review",
    {
      instructions: chapterAuthoredInstructions(
        deps,
        snapshot.run.projectId,
        "prompt.semantic-review",
      ),
      messages: [
        {
          role: "user",
          content: [
            "<compiled-context>",
            purposeContextText(context, "semantic-review"),
            "</compiled-context>",
            `<scene-plan>${JSON.stringify(plan)}</scene-plan>`,
            "<manuscript>",
            locator.render(),
            "</manuscript>",
          ].join("\n"),
        },
      ],
      maxOutputTokens: policyNumber(
        snapshot.run.policy,
        "reviewMaxOutputTokens",
        16_000,
      ),
      temperature: 0.2,
      reasoningEffort: "low",
    },
    REVIEW_CONTRACT,
    zodValidator(ReviewResultSchema, (value) =>
      reviewSemanticIssues(value, locator),
    ),
    signal,
  );
  const grounded = groundReviewEvidence(
    deriveReviewResult(result.value),
    locator,
  );
  const reportId = `${step.id}:report`;
  const persistedIssues = grounded.issues.map((issue, index) => ({
    ...issue,
    id: `${reportId}:issue:${index}`,
  }));
  deps.reviews.insertReport({
    id: reportId,
    projectId: snapshot.run.projectId,
    runId: snapshot.run.id,
    stepId: step.id,
    documentVersionId: locator.documentVersionId,
    verdict: grounded.verdict,
    summary: grounded.summary,
    scores: grounded.scores,
    reviewedContent: content,
    reviewedContentHash: locator.contentHash,
    issues: persistedIssues.map((issue) => ({
      id: issue.id,
      category: issue.category,
      severity: issue.severity,
      message: issue.message,
      evidence: issue.evidence,
      suggestedDirection: issue.suggestedDirection,
      requiresAuthorDecision: issue.requiresAuthorDecision,
    })),
    createdAt: deps.now().toISOString(),
  });
  return {
    artifactKind: "semantic-review",
    output: {
      ...grounded,
      issues: persistedIssues,
      reportId,
      generation: { mode: result.mode, attempts: result.attempts },
    },
    usage: result.usage,
  };
}
