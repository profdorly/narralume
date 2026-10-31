import { randomUuid } from "@lapis/domain";

/**
 * Event broadcast hub: subscribers are "write one frame" callbacks. The Fastify
 * adapter passes a bound ServerResponse.write; the browser kernel passes the
 * postMessage bridge. A callback that throws is treated as a dead subscriber
 * and removed automatically.
 */
export type EventSink = (frame: string) => void;

interface Client {
  id: string;
  sink: EventSink;
  release: () => void;
}

export class ServerEventHub {
  readonly #clients = new Map<string, Client>();

  add(sink: EventSink, release?: () => void): () => void {
    const client = { id: randomUuid(), sink, release: release ?? (() => {}) };
    this.#clients.set(client.id, client);
    return () => {
      if (!this.#clients.has(client.id)) return;
      this.#clients.delete(client.id);
      client.release();
    };
  }

  broadcast(event: unknown, eventName = "message"): void {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#clients.values()) {
      try {
        client.sink(payload);
      } catch {
        this.#clients.delete(client.id);
        try {
          client.release();
        } catch {
          // A failure of release itself is not propagated.
        }
      }
    }
  }

  close(): void {
    for (const client of this.#clients.values()) client.release();
    this.#clients.clear();
  }

  get size(): number {
    return this.#clients.size;
  }
}
