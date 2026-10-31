import { useEffect, useRef, useState } from "react";

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

export function parseServerEvent(text: string): ServerEvent | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    return value as ServerEvent;
  } catch {
    return null;
  }
}

/** The most common text.delta shape in a model.event payload. */
export interface TextDeltaPayload {
  type: string;
  text?: string;
}

export function isTextDelta(event: unknown): event is {
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

export interface ServerEventHandlers {
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
}

export interface BibleBackfillStatusEvent {
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
export const EVENT_FALLBACK_MS = 15_000;

/** True while the event stream is connected, so pushed events keep data fresh. */
export function serverEventsLive(): boolean {
  return live;
}

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
  live = true;
  // The kernel bridge forwards whole SSE frames (event: …\ndata: …).
  unsubscribeKernel = addKernelEventListener((frame) => {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine) dispatch(dataLine.slice("data: ".length));
  });
}

function bindServer(): void {
  if (unsubscribeKernel || source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    live = true;
  };
  source.onerror = () => {
    // EventSource reconnects by itself; polling covers the gap.
    live = false;
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
  live = false;
}

/** Subscribes to server events; returns the unsubscribe function. */
export function subscribeServerEvents(handlers: ServerEventHandlers): () => void {
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
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    return subscribeServerEvents({
      onModelEvent: (runId, event) => ref.current.onModelEvent?.(runId, event),
      onRunStatus: (runId, status) =>
        ref.current.onRunStatus?.(runId, status),
      onRunEvent: (runId, stepId, sequence, eventType, payload) =>
        ref.current.onRunEvent?.(runId, stepId, sequence, eventType, payload),
      onBibleBackfillStatus: (event) =>
        ref.current.onBibleBackfillStatus?.(event),
    });
  }, [enabled]);
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
