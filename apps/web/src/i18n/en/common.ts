import type { common as commonPt } from "../pt-BR/common";

export const common: typeof commonPt = {
  action: {
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    edit: "Edit",
    create: "Create",
    close: "Close",
    copy: "Copy",
    download: "Download",
    enable: "Enable",
    disable: "Disable",
    expand: "Expand",
    collapse: "Collapse",
  },
  state: {
    loading: "Loading…",
    saving: "Saving…",
    submitting: "Submitting…",
    creating: "Creating…",
    none: "None",
    unknown: "Unknown",
    unconfigured: "Not configured",
    characters: "{count, plural, one {# character} other {# characters}}",
  },
  time: {
    justNow: "Just now",
    today: "Today",
    yesterday: "Yesterday",
    daysAgo: "{days, plural, one {# day ago} other {# days ago}}",
  },
};
