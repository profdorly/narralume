import type { shell as shellPt } from "../pt-BR/shell";

export const shell: typeof shellPt = {
  nav: {
    shelf: "Shelf",
    shelfBlurb: "Catalog, search, and create books",
    overview: "Overview",
    overviewBlurb: "Current progress, active tasks, and next steps",
    bible: "Story",
    bibleBlurb: "Intent, characters, outline, and story facts",
    studio: "Writing",
    studioBlurb: "Manuscript, versions, drafts, and review",
    delivery: "Delivery",
    deliveryBlurb: "Quality gates, press export, and backups",
    autopilot: "AI Quick Create",
    autopilotBlurb: "Finishes multiple chapters along the default pipeline; the author can step in anytime",
    runs: "Runs",
    runsBlurb: "Issue archive of every run",
    lab: "Narrative Lab",
    labBlurb: "Plot prediction, story memory, and change-impact rehearsal",
    settings: "Settings",
    settingsBlurb: "Default generation model and role inheritance (providers, models, and role assignment)",
    goTo: "Go to {label}",
    aria: "Main navigation",
  },
  groups: {
    quick: "AI Create",
    advanced: "Advanced tools",
  },
  status: {
    connecting: "Connecting to the local kernel",
    online: "Kernel online",
    offline: "Kernel offline",
  },
  repository: {
    viewSource: "View source on GitHub",
  },
  brand: {
    tagline: "You have the last word.",
  },
  rail: {
    expand: "Expand navigation",
    collapse: "Collapse navigation",
  },
  loading: {
    workspace: "Unfolding the workspace…",
  },
  theme: {
    followSystem: "Follow system theme again",
    toDark: "Switch to night light",
    toLight: "Switch to daylight",
  },
  language: {
    switch: "Switch interface language (Português)",
  },
  palette: {
    button: "Command palette (⌘K)",
    title: "Command palette",
    search: "Search commands",
    placeholder: "Type a command or workspace…",
    close: "Close command palette",
    noResults: "No matching commands",
    footerSelect: "Select",
    footerRun: "Run",
    hintAdvanced: "Advanced",
  },
};
