/**
 * Background transport — batches UsageEvents and POSTs them to the ingestion
 * endpoint. Never throws into the caller; failures are logged and retried.
 */

import type { UsageEvent } from "./types.js";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;

const SDK_VERSION = "0.1.0";
const USER_AGENT = `spectracost-sdk-node/${SDK_VERSION}`;

type TransportOptions = {
  endpoint: string;
  apiKey: string;
};

const activeTransports: Set<Transport> = new Set();

export class Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private queue: UsageEvent[] = [];
  private bufferBytes = 0;
  private retryDelay = 1000;
  private timer: ReturnType<typeof setInterval> | null = null;
  private shutdown = false;

  constructor(options: TransportOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "") + "/v1/events";
    this.apiKey = options.apiKey;
    this.start();
    activeTransports.add(this);
  }

  enqueue(event: UsageEvent): void {
    if (this.shutdown) return;
    const encoded = JSON.stringify(serialize(event));
    const size = Buffer.byteLength(encoded, "utf8");

    if (this.bufferBytes + size > MAX_BUFFER_BYTES && this.queue.length > 0) {
      const dropped = this.queue.shift();
      if (dropped) {
        const droppedSize = Buffer.byteLength(
          JSON.stringify(serialize(dropped)),
          "utf8",
        );
        this.bufferBytes -= droppedSize;
      }
    }

    this.queue.push(event);
    this.bufferBytes += size;

    if (this.queue.length >= MAX_BATCH_SIZE) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, MAX_BATCH_SIZE);
    const batchSize = batch.reduce(
      (sum, ev) =>
        sum + Buffer.byteLength(JSON.stringify(serialize(ev)), "utf8"),
      0,
    );
    this.bufferBytes = Math.max(0, this.bufferBytes - batchSize);

    try {
      const resp = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(batch.map(serialize)),
      });
      if (!resp.ok) throw new Error(`ingest ${resp.status}`);
      this.retryDelay = 1000;
    } catch {
      for (const event of batch) this.queue.unshift(event);
      this.bufferBytes += batchSize;
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
    }
  }

  stop(): void {
    this.shutdown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.bufferBytes = 0;
    activeTransports.delete(this);
  }

  private start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }
}

/**
 * Shut down every active Transport. Used by tests to stop background
 * timers and prevent leaked POSTs from one test leaking into the next.
 */
export function shutdownAllActiveTransports(): void {
  for (const t of Array.from(activeTransports)) {
    t.stop();
  }
}

function serialize(event: UsageEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value === "") continue;
    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
