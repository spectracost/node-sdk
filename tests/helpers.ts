import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach } from "vitest";

import { shutdownAllActiveTransports } from "../src/transport.js";

afterEach(() => {
  shutdownAllActiveTransports();
});

export type TelemetryCapture = {
  url: string;
  events: Array<Record<string, unknown>>;
  close: () => Promise<void>;
};

/** Start a throwaway HTTP server that collects posted telemetry events. */
export async function startTelemetryServer(): Promise<TelemetryCapture> {
  const events: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) {
          for (const ev of parsed) events.push(ev as Record<string, unknown>);
        }
      } catch {
        // ignore malformed payloads in tests
      }
      res.writeHead(202);
      res.end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test telemetry server");
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    events,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Wait until `predicate` returns true or timeout. */
export async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  const interval = opts.intervalMs ?? 25;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, interval));
  }
}
