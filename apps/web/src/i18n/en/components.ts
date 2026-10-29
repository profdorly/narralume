import type { components as componentsPt } from "../pt-BR/components";

export const components: typeof componentsPt = {
  confirmDialog: {
    pending: "Working…",
  },
  errorNote: {
    defaultTitle: "Something went wrong",
  },
  projectRequired: {
    backToShelf: "Back to the library",
  },
  kernel: {
    lockBusy:
      "The local kernel is in use by another tab. Close other Lapis pages and try again.",
    deserializeFailed: "Failed to deserialize a kernel message",
    workerTerminated: "The kernel worker has terminated",
    bootTimeout:
      "Kernel startup timed out (the worker may have failed to load or is held by another tab)",
    workerBootFailed: "The kernel worker failed to start",
    pageClosed: "The page was closed and the kernel has stopped",
    requestFailed: "Kernel request failed",
  },
};
