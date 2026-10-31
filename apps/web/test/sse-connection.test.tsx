// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChunkBoundary } from "../src/components/chunk-boundary";
import { eventAwareInterval, useServerEvents } from "../src/lib/sse";

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor() {
    EventSourceStub.instances.push(this);
  }

  addEventListener() {}

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  drop() {
    this.readyState = 0;
    this.onerror?.();
  }
}

let polled = 0;
let plain = 0;

function Screen() {
  // Four subscribers share one connection, as on a Studio page.
  useServerEvents({});
  useServerEvents({});
  useServerEvents({});
  useServerEvents({});
  useQuery({
    queryKey: ["polled"],
    queryFn: () => ++polled,
    refetchInterval: () => eventAwareInterval(60_000),
  });
  useQuery({ queryKey: ["plain"], queryFn: () => ++plain });
  return <p>screen</p>;
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <Screen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  polled = 0;
  plain = 0;
  EventSourceStub.instances = [];
  vi.stubGlobal("EventSource", EventSourceStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared event stream", () => {
  it("opens one connection and does not refetch on the first open", async () => {
    renderScreen();
    await waitFor(() => expect(polled).toBe(1));
    expect(EventSourceStub.instances).toHaveLength(1);
    act(() => EventSourceStub.instances[0]!.open());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([polled, plain]).toEqual([1, 1]);
  });

  it("on a drop refetches only stream-dependent queries; on reconnect everything, once", async () => {
    renderScreen();
    await waitFor(() => expect(plain).toBe(1));
    const source = EventSourceStub.instances[0]!;
    act(() => source.open());

    act(() => source.drop());
    await waitFor(() => expect(polled).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The plain query keeps its data: a Server that is down does not turn it
    // into an error.
    expect(plain).toBe(1);

    act(() => source.open());
    await waitFor(() => expect(plain).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Once per change, not once per subscriber.
    expect([polled, plain]).toEqual([3, 2]);
  });

  it("reopens a stream the server closed for good", () => {
    vi.useFakeTimers();
    renderScreen();
    const source = EventSourceStub.instances[0]!;
    act(() => source.open());
    source.readyState = 2;
    act(() => source.onerror?.());
    expect(EventSourceStub.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(5_000));
    expect(EventSourceStub.instances).toHaveLength(2);
  });
});

describe("ChunkBoundary", () => {
  it("shows the fallback when a lazy chunk cannot be fetched", async () => {
    const Broken = lazy(() =>
      Promise.reject(
        new TypeError(
          "Failed to fetch dynamically imported module: /assets/x.js",
        ),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ChunkBoundary fallback={<p>fallback</p>}>
        <Suspense fallback={null}>
          <Broken />
        </Suspense>
      </ChunkBoundary>,
    );
    expect(await screen.findByText("fallback")).toBeInTheDocument();
  });

  it("lets other errors through", () => {
    function Buggy(): never {
      throw new Error("a real bug");
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <ChunkBoundary fallback={<p>fallback</p>}>
          <Buggy />
        </ChunkBoundary>,
      ),
    ).toThrow("a real bug");
  });
});
