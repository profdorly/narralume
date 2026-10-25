import type { lab as labPt } from "../pt-BR/lab";

export const lab: typeof labPt = {
  title: "Narrative Lab",
  meta: "Semantic search · Plot predictions · Impact preview · Story memory",
  missing: {
    seal: "L",
    description:
      "Select a project to simulate plot directions, story memory, and the potential impact of setting changes here.",
  },
  authority: {
    reference: "Reference",
    draft: "Draft",
    candidate: "Candidate",
    confirmed: "Confirmed",
    locked: "Locked",
  },
  actions: {
    eyebrow: "Explicit maintenance · ACTIONS",
    title: "Generate predictions & maintain memory",
    directionLabel: "Direction to simulate",
    horizonLabel: "Horizon chapters",
    countLabel: "Candidate count",
    generate: "Generate predictions",
    generating: "Generating…",
    rebuild: "Rebuild all memories",
    consolidate: "Consolidate working memory",
    generateError: "Prediction not generated",
    memoryError: "Memory maintenance did not complete",
  },
  search: {
    eyebrow: "Semantic search · SEARCH-01",
    title: "Search related story memory",
    placeholder:
      "e.g. What signs appeared before the sister vanished in chapter 3?",
    inputLabel: "Search question",
    button: "Search",
    resultsLabel: "Search results",
    error: "Search failed",
    empty: "No related story memory found.",
    hint: "Enter a question and related settings, text, and memories will appear here.",
  },
  index: {
    title: "Manuscript search index",
    loadError: "The index cannot be loaded right now",
    documents: "Indexed chapters",
    documentsValue: "{indexed} of {total}",
    passages: "Passages",
    model: "Embedding model",
    noModel: "None assigned",
    vectors: "Passages with a vector from this model",
    vectorsValue: "{embedded} of {total}",
    hintEmpty:
      "The index is still empty. It is built before the next AI task, or now with “Reindex now”.",
    hintNoModel:
      "Without an embedding model, search uses words and named characters. Assign one in Settings so search also finds passages by meaning.",
    hintPending:
      "Missing vectors are created by the next AI chapter writing run, with the assigned embedding model.",
    hintReady:
      "Every passage has a vector from the assigned model; search combines words, characters, and meaning.",
    stale:
      "{count, plural, one {# chapter changed since the last indexing; the next search or AI writing run reindexes it.} other {# chapters changed since the last indexing; the next search or AI writing run reindexes them.}}",
    reindex: "Reindex now",
    reindexing: "Reindexing…",
    reindexed: "{indexed, plural, one {# chapter reindexed} other {# chapters reindexed}} · {relinked} with updated character links",
    reindexError: "Reindexing did not complete",
  },
  predictions: {
    title: "Plot predictions",
    count: "{count, plural, one {# entry} other {# entries}}",
    loadError: "Predictions cannot be loaded right now",
    empty: "No simulations have become predictions yet.",
    horizon: "+{horizon, plural, one {# chapter later} other {# chapters later}}",
    stale: "Stale",
    adopt: "Adopt",
    dismiss: "Dismiss",
    flash: "{status} · “{title}”",
    status: {
      candidate: "Pending",
      adopted: "Adopted",
      dismissed: "Dismissed",
    },
  },
  memories: {
    title: "Story memory · {count}",
    loadError: "Memories cannot be loaded right now",
    empty: "No memories stored yet",
  },
  dryRun: {
    title: "Impact preview",
    intro:
      "Before making a change, check which settings, chapters, and story states it would affect.",
    placeholder: "e.g. Make Lia someone who never really existed.",
    inputLabel: "Change to preview",
    submit: "Preview impact",
    error: "Impact preview failed",
    resultLabel: "Impact preview result",
    safe: "Safe to proceed; no conflicting links found",
    unsafe: "Not recommended; the following are not isolated",
    empty: "No impact preview yet.",
  },
};
