/**
 * M3 dual-driver transport: the three low-level helpers in api.ts (requestJson
 * / requestVoid / raw fetch) dispatch through here. Server mode uses a relative
 * fetch (unchanged); local mode uses the kernel's kernelRequest. The driver is
 * detected by probing /api/health the first time a dispatch actually needs it,
 * then cached; localStorage("lapis:driver") can override it explicitly.
 *
 * Detection is deliberately lazy: unit tests (jsdom with a stubbed fetch) and
 * the first render should not be disturbed by an eager probe.
 */

export type DriverMode = "server" | "local" | "pending";

const DRIVER_KEY = "lapis:driver";

let mode: DriverMode = "pending";
let probe: Promise<DriverMode> | null = null;
const modeListeners = new Set<(mode: DriverMode) => void>();

export function currentDriverMode(): DriverMode {
  return mode;
}

export function onDriverModeChange(
  listener: (mode: DriverMode) => void,
): () => void {
  modeListeners.add(listener);
  return () => modeListeners.delete(listener);
}

function setMode(next: DriverMode): void {
  if (mode === next) return;
  mode = next;
  for (const listener of modeListeners) listener(mode);
}

/**
 * Detection: an explicit override wins; otherwise fetch /api/health (1.5 s
 * timeout) to decide.
 */
export function resolveDriverMode(): Promise<DriverMode> {
  probe ??= (async () => {
    const override = readOverride();
    if (override === "local" || override === "server") {
      setMode(override);
      return override;
    }
    if (typeof Worker === "undefined") {
      // Hosts without Worker support (old browsers / test environments) cannot
      // run the local kernel; use server directly.
      setMode("server");
      return "server";
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const response = await fetch("/api/health", {
          signal: controller.signal,
        });
        setMode(response.ok ? "server" : "local");
      } finally {
        clearTimeout(timer);
      }
    } catch {
      setMode("local");
    }
    return mode;
  })();
  return probe;
}

/**
 * Explicit switch (settings page entry); clearing it restores automatic
 * detection.
 */
export function setDriverOverride(next: "server" | "local" | null): void {
  if (next === null) {
    try {
      localStorage.removeItem(DRIVER_KEY);
    } catch {
      // Ignore when localStorage is unavailable; the next detection still runs.
    }
    return;
  }
  try {
    localStorage.setItem(DRIVER_KEY, next);
  } catch {
    // Same as above.
  }
}

export function readDriverOverride(): "server" | "local" | null {
  return readOverride();
}

function readOverride(): "server" | "local" | null {
  try {
    const value = localStorage.getItem(DRIVER_KEY);
    if (value === "server" || value === "local") return value;
  } catch {
    // localStorage may be unavailable (e.g. private browsing); fall back to
    // detection.
  }
  return null;
}

/**
 * The resolved mode every dispatch needs: returns the cached value once
 * detection has finished, and waits while detection is in flight (requests are
 * asynchronous anyway, so waiting is the right semantics). With no browser host
 * (SSR, or tests that never triggered detection) it falls back to server,
 * matching the existing relative-path fetch behavior.
 */
export async function requireResolvedMode(): Promise<"server" | "local"> {
  const resolved = await resolveDriverMode();
  return resolved === "pending" ? "server" : resolved;
}
