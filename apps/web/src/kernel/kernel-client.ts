/**
 * M3 kernel main-thread client: lazily loads kernel-worker, sends HTTP-shaped
 * requests (method + path + query + body) into the kernel via postMessage and
 * waits for the response with the same id. Event frames (type:"sse") are
 * dispatched to a set of callbacks, reused by the local branch of sse.ts.
 *
 * The protocol is described in the header comment of kernel-worker.ts.
 * Singleton: only one Worker and one OPFS sahpool connection are allowed per
 * origin.
 */

import { getLocale, translate } from "../i18n";

type KernelEventListener = (frame: string) => void;

interface KernelResponseFrame {
  type: "response";
  id: string;
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

type KernelFrame =
  | KernelResponseFrame
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "sse"; frame: string };

interface KernelHttpError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

let worker: Worker | null = null;
let bootPromise: Promise<void> | null = null;
let kernelLockPromise: Promise<void> | null = null;
let releaseKernelLock: (() => void) | null = null;
let sequence = 0;
const pending = new Map<
  string,
  { resolve: (frame: KernelResponseFrame) => void; reject: (error: unknown) => void }
>();
const listeners = new Set<KernelEventListener>();

function failWorker(instance: Worker, error: Error): void {
  if (worker !== instance) return;
  instance.terminate();
  worker = null;
  bootPromise = null;
  releaseKernelLock?.();
  releaseKernelLock = null;
  kernelLockPromise = null;
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function acquireKernelLock(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return Promise.resolve();
  }
  if (kernelLockPromise) return kernelLockPromise;

  kernelLockPromise = new Promise<void>((resolve, reject) => {
    // Lock name from before the rename. Tabs of an older build still take it,
    // and it guards the same OPFS pool, so it stays with OPFS_POOL_NAME.
    void navigator.locks
      .request("narralume-kernel", { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error(translate(getLocale(), "components.kernel.lockBusy")));
          return;
        }
        resolve();
        return new Promise<void>((release) => {
          releaseKernelLock = release;
        });
      })
      .catch((error: unknown) => {
        kernelLockPromise = null;
        reject(error);
      });
  });
  return kernelLockPromise;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("./kernel-worker.ts", import.meta.url), {
    type: "module",
  });
  instance.addEventListener("message", (event: MessageEvent<KernelFrame>) => {
    const frame = event.data;
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "sse") {
      for (const listener of listeners) {
        try {
          listener(frame.frame);
        } catch {
          // An exception in one subscriber must not stop the others.
        }
      }
      return;
    }
    if (frame.type === "response") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      entry.resolve(frame);
      return;
    }
    // ready / fatal are handled in bootPromise.
  });
  instance.addEventListener("messageerror", () =>
    failWorker(
      instance,
      new Error(translate(getLocale(), "components.kernel.deserializeFailed")),
    ),
  );
  instance.addEventListener("error", (event: ErrorEvent) =>
    failWorker(
      instance,
      new Error(
        event.message ||
          translate(getLocale(), "components.kernel.workerTerminated"),
      ),
    ),
  );
  worker = instance;
  return instance;
}

/**
 * Start the kernel and wait for ready; rejects on failure (e.g. sahpool held by
 * another tab).
 */
function bootKernel(): Promise<void> {
  bootPromise ??= (async () => {
    await acquireKernelLock();
    await new Promise<void>((resolve, reject) => {
      const instance = ensureWorker();
      // A module-level exception kills the Worker silently (not even an error
      // event fires), so a timeout is the fallback.
      const timer = setTimeout(() => {
        failWorker(
          instance,
          new Error(translate(getLocale(), "components.kernel.bootTimeout")),
        );
        finish();
        reject(
          new Error(translate(getLocale(), "components.kernel.bootTimeout")),
        );
      }, 30_000);
      const finish = () => {
        clearTimeout(timer);
        instance.removeEventListener("message", onMessage);
        instance.removeEventListener("error", onError);
      };
      const onMessage = (event: MessageEvent<KernelFrame>) => {
        if (event.data?.type === "ready") {
          finish();
          resolve();
        }
        if (event.data?.type === "fatal") {
          if (String(event.data.message).startsWith("boot:")) {
            // Temporary boot-phase probe (remove once diagnosis is done).
            console.warn("[kernel]", event.data.message);
            return;
          }
          finish();
          failWorker(instance, new Error(event.data.message));
          reject(new Error(event.data.message));
        }
      };
      const onError = (event: ErrorEvent) => {
        const message =
          event.message ||
          translate(getLocale(), "components.kernel.workerBootFailed");
        failWorker(instance, new Error(message));
        finish();
        reject(new Error(message));
      };
      instance.addEventListener("message", onMessage);
      instance.addEventListener("error", onError);
    });
  })().catch((error: unknown) => {
    bootPromise = null;
    releaseKernelLock?.();
    releaseKernelLock = null;
    kernelLockPromise = null;
    throw error;
  });
  return bootPromise;
}

function shutdownKernel(): void {
  if (worker) {
    failWorker(
      worker,
      new Error(translate(getLocale(), "components.kernel.pageClosed")),
    );
    return;
  }
  releaseKernelLock?.();
  releaseKernelLock = null;
  kernelLockPromise = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", shutdownKernel);
}

/**
 * Subscribe to kernel event frames (JSON strings, same shape as the SSE data of
 * /api/events).
 */
export function addKernelEventListener(
  listener: KernelEventListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface KernelRequestInit {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string> | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
}

/**
 * A kernel-shaped HTTP error (already mapped to the ApiError shape by
 * mapRouteError).
 */
class KernelApiError extends Error {
  constructor(readonly payload: KernelHttpError) {
    super(payload.message);
    this.name = "KernelApiError";
  }
}

/**
 * Send one HTTP-shaped request to the kernel. path may carry a ?query (as with
 * fetch). Returns {status, headers, body}; non-2xx responses throw
 * KernelApiError.
 */
export async function kernelRequest(init: KernelRequestInit): Promise<{
  status: number;
  headers: Record<string, string>;
  body: unknown;
}> {
  await bootKernel();
  const instance = ensureWorker();
  const [pathname, search] = init.path.split("?");
  const query: Record<string, unknown> = {};
  if (search) {
    for (const [key, value] of new URLSearchParams(search)) {
      query[key] = value;
    }
  }
  for (const [key, value] of Object.entries(init.query ?? {})) {
    query[key] = value;
  }
  const id = `k${(sequence += 1)}`;
  const body =
    typeof init.body === "string" ? safeParseJson(init.body) : init.body;
  const frame = await new Promise<KernelResponseFrame>(
    (resolve, reject) => {
      pending.set(id, { resolve, reject });
      instance.postMessage({
        type: "request",
        id,
        method: init.method,
        path: pathname,
        query,
        body,
        headers: init.headers ?? {},
      });
    },
  );
  if (!frame.ok) {
    const error = frame.error ?? {
      code: "internal",
      message: translate(getLocale(), "components.kernel.requestFailed"),
    };
    throw new KernelApiError({
      status: frame.status ?? 500,
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  return {
    status: frame.status ?? 200,
    headers: frame.headers ?? {},
    body: frame.body,
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
