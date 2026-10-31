import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { useContext, useEffect, useRef, useState } from "react";

import type { ServerEvent } from "@lapis/contracts";

import { addKernelEventListener } from "../kernel/kernel-client";
import {
  currentDriverMode,
  readDriverOverride,
  requireResolvedMode,
} from "../kernel/transport";

/* ==========================================================================
   EventSource wrapper for /api/events (moved from the old run-center /
   studio-view).
   ========================================================================== */

function parseServerEvent(text: string): ServerEvent | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    return value as ServerEvent;
  } catch {
    return null;
  }
}

/** The most common text.delta shape in a model.event payload. */
interface TextDeltaPayload {
  type: string;
  text?: string;
}

function isTextDelta(event: unknown): event is {
  type: "text.delta";
  text: string;
} {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as TextDeltaPayload).type === "text.delta" &&
    typeof (event as TextDeltaPayload).text === "string"
  );
}

interface ServerEventHandlers {
  onModelEvent?: (runId: string, event: unknown) => void;
  onRunStatus?: (runId: string, status: string) => void;
  onRunEvent?: (
    runId: string,
    stepId: string | null,
    sequence: number,
    eventType: string,
    payload: Record<string, unknown>,
  ) => void;
  /**
   * Every state transition of the "Fill in the story bible from the manuscript"
   * coordinator.
   */
  onBibleBackfillStatus?: (event: BibleBackfillStatusEvent) => void;
  /**
   * The stream went down or came back. The module already refetches the
   * affected queries once per change; this is for extra local reactions.
   */
  onConnectionChange?: (live: boolean) => void;
}

interface BibleBackfillStatusEvent {
  projectId: string;
  jobId: string;
  status: string;
  action: string;
}

/* One event connection per tab, shared by every subscriber. Each hook used
   to open its own EventSource; browsers allow only six HTTP/1.1 connections
   per origin, so a few open panels could stall every other request. The
   connection opens with the first subscriber and closes with the last.
   Server driver: EventSource on /api/events. Local driver: the kernel event
   bridge, whose frames have the same JSON data lines. */
const subscribers = new Set<ServerEventHandlers>();
let source: EventSource | null = null;
let unsubscribeKernel: (() => void) | null = null;
let live = false;

/** How long a query that the event stream keeps fresh waits between polls. */
const EVENT_FALLBACK_MS = 15_000;

/**
 * refetchInterval for data that server events also refresh: the given fast
 * interval only while the stream is down, a slow safety net otherwise.
 */
export function eventAwareInterval(fastMs: number): number {
  return live ? Math.max(fastMs, EVENT_FALLBACK_MS) : fastMs;
}

function dispatch(text: string): void {
  const parsed = parseServerEvent(text);
  if (!parsed) return;
  for (const handlers of subscribers) {
    if (parsed.type === "model.event")
      handlers.onModelEvent?.(parsed.runId, parsed.event);
    if (parsed.type === "run.status")
      handlers.onRunStatus?.(parsed.runId, parsed.status);
    if (parsed.type === "run.event")
      handlers.onRunEvent?.(
        parsed.runId,
        parsed.stepId,
        parsed.sequence,
        parsed.eventType,
        parsed.payload,
      );
    if (parsed.type === "bible_backfill.status")
      handlers.onBibleBackfillStatus?.({
        projectId: parsed.projectId,
        jobId: parsed.jobId,
        status: parsed.status,
        action: parsed.action,
      });
  }
}

function bindKernel(): void {
  if (unsubscribeKernel) return;
  source?.close();
  source = null;
  setLive(true);
  // The kernel bridge forwards whole SSE frames (event: …\ndata: …).
  unsubscribeKernel = addKernelEventListener((frame) => {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine) dispatch(dataLine.slice("data: ".length));
  });
}

/** The app's query client, registered by useServerEvents. */
let queryClient: QueryClient | null = null;
function registerQueryClient(client: QueryClient): void {
  queryClient = client;
}

/** Whether this connection has been live before (its first open is not a reconnect). */
let wasLive = false;

function setLive(next: boolean): void {
  if (live === next) return;
  live = next;
  if (next && wasLive) {
    // Reconnected: events sent meanwhile are not replayed, so refresh what is
    // on screen once. In-flight fetches are kept, not restarted.
    void queryClient?.invalidateQueries(
      { refetchType: "active" },
      { cancelRefetch: false },
    );
  } else if (!next) {
    // Dropped: only the queries whose polling depends on the stream (a
    // function refetchInterval, see eventAwareInterval) refetch, which
    // reschedules them at their fast interval. Others keep their data, so a
    // Server that is down does not turn every screen into an error.
    void queryClient?.refetchQueries(
      {
        type: "active",
        // refetchInterval lives on the observer options, not on the query's.
        predicate: (query) =>
          query.observers.some(
            (observer) => typeof observer.options.refetchInterval === "function",
          ),
      },
      { cancelRefetch: false },
    );
  }
  if (next) wasLive = true;
  for (const handlers of subscribers) handlers.onConnectionChange?.(next);
}

let reopenTimer: ReturnType<typeof setTimeout> | null = null;

function bindServer(): void {
  if (unsubscribeKernel || source || typeof EventSource === "undefined") return;
  const current = new EventSource("/api/events");
  source = current;
  current.onopen = () => setLive(true);
  current.onerror = () => {
    setLive(false);
    // EventSource retries by itself unless the server answered with an error
    // status; then it stays CLOSED, so open a new one after a pause.
    if (current.readyState === 2 && source === current && !reopenTimer) {
      reopenTimer = setTimeout(() => {
        reopenTimer = null;
        if (source !== current || subscribers.size === 0) return;
        source = null;
        bindServer();
      }, 5_000);
    }
  };
  const forward = (message: MessageEvent<string>) => dispatch(message.data);
  source.addEventListener("model.event", forward as EventListener);
  source.addEventListener("run.status", forward as EventListener);
  source.addEventListener("run.event", forward as EventListener);
  source.addEventListener("bible_backfill.status", forward as EventListener);
}

function connect(): void {
  const initial = readDriverOverride() ?? currentDriverMode();
  if (initial === "local") bindKernel();
  else bindServer();
  void requireResolvedMode().then((mode) => {
    if (subscribers.size > 0 && mode === "local") bindKernel();
  });
}

function disconnect(): void {
  unsubscribeKernel?.();
  unsubscribeKernel = null;
  source?.close();
  source = null;
  if (reopenTimer) clearTimeout(reopenTimer);
  reopenTimer = null;
  live = false;
  wasLive = false;
}

/** Subscribes to server events; returns the unsubscribe function. */
function subscribeServerEvents(handlers: ServerEventHandlers): () => void {
  const entry = { ...handlers };
  subscribers.add(entry);
  if (subscribers.size === 1) connect();
  return () => {
    subscribers.delete(entry);
    if (subscribers.size === 0) disconnect();
  };
}

/**
 * React-side subscription: handlers may change by reference (kept stable with a
 * ref internally); the connection is established only once, on mount.
 */
export function useServerEvents(
  handlers: ServerEventHandlers,
  enabled = true,
): void {
  const ref = useRef(handlers);
  // Optional: components rendered without a QueryClientProvider still get events.
  const client = useContext(QueryClientContext);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    if (client) registerQueryClient(client);
    return subscribeServerEvents({
      onModelEvent: (runId, event) => ref.current.onModelEvent?.(runId, event),
      onRunStatus: (runId, status) =>
        ref.current.onRunStatus?.(runId, status),
      onRunEvent: (runId, stepId, sequence, eventType, payload) =>
        ref.current.onRunEvent?.(runId, stepId, sequence, eventType, payload),
      onBibleBackfillStatus: (event) =>
        ref.current.onBibleBackfillStatus?.(event),
      onConnectionChange: (isLive) => ref.current.onConnectionChange?.(isLive),
    });
  }, [enabled, client]);
}

/**
 * Accumulate the live text.delta prose of a given run (used together with the
 * streams persisted in the run detail; the caller concatenates the persisted
 * text as a fallback).
 */
export function useRunLiveText(
  runId: string | null,
  clearSignal: string | null = null,
): string {
  const [liveByRun, setLiveByRun] = useState<Record<string, string>>({});
  const previousClearSignal = useRef<string | null>(null);
  useEffect(() => {
    if (!runId || !clearSignal || previousClearSignal.current === clearSignal)
      return;
    previousClearSignal.current = clearSignal;
    setLiveByRun((current) => {
      if (!current[runId]) return current;
      const next = { ...current };
      delete next[runId];
      return next;
    });
  }, [clearSignal, runId]);
  useServerEvents({
    onModelEvent: (sourceRunId, event) => {
      if (!runId || sourceRunId !== runId || !isTextDelta(event)) return;
      setLiveByRun((current) => ({
        ...current,
        [sourceRunId]: (current[sourceRunId] ?? "") + event.text,
      }));
    },
  });
  return runId ? (liveByRun[runId] ?? "") : "";
}
