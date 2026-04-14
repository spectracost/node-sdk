/**
 * Core entry point. instrument(client, options) wraps an OpenAI- or
 * Anthropic-compatible client with telemetry capture and returns the
 * wrapped client.
 */

import { detectProvider } from "./providers/detect.js";
import { wrapAnthropicClient } from "./providers/anthropic.js";
import { wrapOpenAIClient } from "./providers/openai.js";
import { Transport } from "./transport.js";
import type { InstrumentOptions } from "./types.js";

const DEFAULT_ENDPOINT = "https://spectracost.com/ingest";

type ClientShape = {
  baseURL?: string | URL;
  chat?: unknown;
  messages?: unknown;
};

export function instrument<T extends object>(
  client: T,
  options: InstrumentOptions,
): T {
  if (!options.apiKey) {
    throw new Error("spectracost: instrument() requires apiKey");
  }

  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const transport = new Transport({ endpoint, apiKey: options.apiKey });

  const shape = client as ClientShape;
  const looksOpenAI = Boolean(
    shape.chat && typeof shape.chat === "object" && "completions" in shape.chat,
  );
  const looksAnthropic = Boolean(shape.messages) && !shape.chat;

  if (!looksOpenAI && !looksAnthropic) {
    throw new Error(
      "spectracost: unsupported client. instrument() accepts OpenAI or Anthropic clients.",
    );
  }

  const classHint: "openai" | "anthropic" = looksOpenAI ? "openai" : "anthropic";
  const provider = detectProvider(shape, options.provider, classHint);

  const defaults = {
    provider,
    team: options.team ?? "",
    service: options.service ?? "",
    feature: options.feature ?? "",
    environment: options.environment ?? "production",
    customerId: options.customerId ?? "",
    tags: options.tags ?? {},
  };

  const ctx = { transport, defaults };

  if (looksOpenAI) {
    return wrapOpenAIClient(client, ctx);
  }
  return wrapAnthropicClient(client, ctx);
}
