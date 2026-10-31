import { type NarrativeRunStep, type RunSnapshot } from "@lapis/domain";
import type { StepExecutionResult } from "@lapis/harness";

import {
  detectManuscriptLanguage,
  manuscriptLanguageHint,
} from "../manuscript-language.js";
import { ParagraphLocator } from "../paragraph-locator.js";
import { promptLanguageOf } from "../prompt-language.js";
import { unanchoredTimelineBlock } from "../unanchored-timeline.js";
import {
  SETTLEMENT_CONTRACT,
  SettlementSchema,
  zodValidator,
} from "../schemas.js";

import {
  type ChapterWorkerDeps,
  anchorableTimeline,
  chapterAuthoredInstructions,
  existingStoryStateNote,
  finalContent,
  groundSettlementEvidence,
  manualSettlementContext,
  manualSettlementTarget,
  paragraphLocator,
  policyNumber,
  projectLanguage,
  purposeContextText,
  requiredArtifact,
  rereadNote,
  settlementSemanticIssues,
  stripContextTagPrefixes,
} from "./helpers.js";

export async function settleChapter(
  deps: ChapterWorkerDeps,
  snapshot: RunSnapshot,
  step: NarrativeRunStep,
  signal: AbortSignal,
): Promise<StepExecutionResult> {
  const manual = manualSettlementTarget(deps, snapshot);
  const content = manual ? manual.content : finalContent(snapshot);
  const locator = manual
    ? new ParagraphLocator(content, {
        documentVersionId: manual.version.id,
      })
    : paragraphLocator(
        deps,
        snapshot.run.projectId,
        content,
        requiredArtifact(snapshot, "context.compile"),
      );
  const authoritative = manual
    ? manualSettlementContext(
        deps,
        snapshot.run.projectId,
        manual.outlineNode.id,
      )
    : purposeContextText(
        requiredArtifact(snapshot, "context.compile"),
        "chapter-settlement",
      );
  const entities = deps.canon.listEntities(snapshot.run.projectId);
  const entityIds = new Set(entities.map((entity) => entity.id));
  const settlementState = {
    facts: new Map(
      deps.canon
        .listEffectiveFacts(snapshot.run.projectId)
        .map((fact) => [fact.id, fact]),
    ),
    relationships: new Map(
      deps.state
        .listCurrentRelationships(snapshot.run.projectId)
        .map((relationship) => [relationship.id, relationship]),
    ),
    timelineEvents: new Map(
      deps.state
        .listTimeline(snapshot.run.projectId)
        .map((event) => [event.id, event]),
    ),
    foreshadows: new Map(
      deps.state
        .listForeshadows(snapshot.run.projectId)
        .map((foreshadow) => [foreshadow.id, foreshadow]),
    ),
    outlineNodeIds: new Set(
      deps.story.listOutline(snapshot.run.projectId).map((node) => node.id),
    ),
  };
  // Settlement output follows the language of the chapter text (the language
  // invariant in the instructions); when a language is detected, add a
  // reference line.
  const languageHint = manuscriptLanguageHint(
    promptLanguageOf(projectLanguage(deps, snapshot.run.projectId)),
    detectManuscriptLanguage(content),
  );
  const referenceExistingStoryState =
    manual !== null && snapshot.run.policy.referenceExistingStoryState === true;
  const result = await deps.model.structured(
    snapshot.run,
    step,
    "chapter-settlement",
    {
      instructions: chapterAuthoredInstructions(
        deps,
        snapshot.run.projectId,
        "prompt.chapter-settlement",
      ),
      messages: [
        {
          role: "user",
          content: [
            `<authoritative-context>${authoritative}</authoritative-context>`,
            ...(referenceExistingStoryState
              ? [
                  `<settlement-note>${existingStoryStateNote(deps, snapshot.run.projectId)}</settlement-note>`,
                  ...(snapshot.run.policy.bibleBackfillReread === true
                    ? [
                        `<reread-note>${rereadNote(deps, snapshot.run.projectId)}</reread-note>`,
                      ]
                    : []),
                  `<unanchored-timeline>${unanchoredTimelineBlock(
                    anchorableTimeline(
                      deps,
                      snapshot.run.projectId,
                      manual.outlineNode.id,
                      [...settlementState.timelineEvents.values()],
                    ),
                    entities,
                    promptLanguageOf(
                      projectLanguage(deps, snapshot.run.projectId),
                    ),
                  )}</unanchored-timeline>`,
                ]
              : []),
            `<entities>${JSON.stringify(entities.map(({ id, name, type }) => ({ id, name, type })))}</entities>`,
            ...(languageHint ? [languageHint] : []),
            "<manuscript>",
            locator.render(),
            "</manuscript>",
          ].join("\n"),
        },
      ],
      maxOutputTokens: policyNumber(
        snapshot.run.policy,
        "settlementMaxOutputTokens",
        16_000,
      ),
      temperature: 0.15,
      reasoningEffort: "low",
    },
    SETTLEMENT_CONTRACT,
    zodValidator(SettlementSchema, (value) =>
      settlementSemanticIssues(
        stripContextTagPrefixes(value),
        entityIds,
        settlementState,
        locator,
        referenceExistingStoryState,
      ),
    ),
    signal,
  );
  const grounded = groundSettlementEvidence(
    stripContextTagPrefixes(result.value),
    locator,
  );
  return {
    artifactKind: "chapter-settlement",
    output: {
      ...grounded,
      manuscriptHash: locator.contentHash,
      generation: { mode: result.mode, attempts: result.attempts },
    },
    usage: result.usage,
  };
}
