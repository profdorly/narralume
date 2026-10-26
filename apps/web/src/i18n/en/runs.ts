import type { runs as runsPt } from "../pt-BR/runs";

export const runs: typeof runsPt = {
  title: "Run Center",
  volumeMeta: "{runs, plural, one {# run} other {# runs}} / {issues, plural, one {# issue} other {# issues}}",
  issueArchiveLabel: "Issue archive",
  catalog: {
    title: "Volume catalog",
    count: "{count, plural, one {# issue} other {# issues}}",
  },
  emptyGuide: "No runs yet; generate a chapter from the story bible outline.",
  issueTitle: "Issue {issue} · {count, plural, one {# run} other {# runs}}",
  currentIssueLabel: "Current issue",
  emptyArchive: "No archive yet",
  volumePrefix: "This volume · {issue}",
  sheetCount: "{count, plural, one {# entry} other {# entries}}",
  sheetMeta:
    "Completed {completed} · Failed {failed} · Awaiting retry {retry} · Running {running}",
  revisionCycles: "{count, plural, one {# revision cycle} other {# revision cycles}}",
  retryIncluded: "Includes automatic retries",
  modelCallsCount: "{count, plural, one {# model call} other {# model calls}}",
  modelCallsWithId: "{count, plural, one {# model call} other {# model calls}} · {id}",
  selectHint:
    "Select a run to view its persisted text, policy, receipts, model snapshots, and call ledger.",
  actionSubmitted: "Action submitted; details are refreshing from the server.",
  detailLabel: "Run details {id}",
  handleCanonChange: "Resolve story changes",
  backToAutopilot: "Back to quick-creation task",
  flowProgress: "Steps {done}/{total}",
  inputTokens: "Input {count, plural, one {# token} other {# tokens}}",
  outputTokens: "Output {count, plural, one {# token} other {# tokens}}",
  wallTime: "Model time {seconds}s",
  attempt: "Attempt {attempt}/{max}",
  blocks: {
    streams: "Text streams",
    noStreams: "No text streams yet.",
    liveIncrement: "Live increment · not yet persisted",
    steps: "Steps and errors",
    events: "Events, checkpoints, and reviews",
    policy: "Effective execution policy",
    receipts: "Context receipts {count}",
    snapshots: "Model snapshots {count}",
    calls: "Call ledger {count}",
    noCalls: "No calls yet.",
    callMetrics: "TTFT {ttft}ms · total {duration}ms · tokens {tokens}",
  },
  confirmCancel: {
    title: "Cancel run",
    confirm: "Confirm cancellation",
    body: "Cancelling terminates unfinished steps; persisted partial text remains in the details for recovery.",
  },
  revision: {
    ariaLabel: "Revision instruction",
    placeholder:
      "Instruction for the revision model; leave empty to use the default revision directive.",
    defaultInstruction:
      "Revise and improve this version of the text while preserving its existing strengths.",
  },
  stream: {
    attemptOnly: "Attempt {attempt}",
    continue: "Continue",
    discard: "Discard",
    tooShortTitle:
      "Fewer than {count} characters; cannot continue or adopt",
    tooShortWarning:
      "Partial is fewer than {count} characters; it can only be discarded or regenerated.",
  },
  missing: {
    description:
      "Select a project to review each AI run's process, results, model usage, and failure reasons here.",
  },
  error: {
    loadList: "Task records cannot be loaded right now",
    loadDetail: "Task details cannot be loaded right now",
    action: "The run operation did not complete",
  },
};
