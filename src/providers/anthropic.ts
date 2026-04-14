/**
 * Anthropic client wrapper — intercepts messages.create.
 */

import { randomUUID } from "node:crypto";

import { getCurrentAttribution } from "../attribution.js";
import type { Transport } from "../transport.js";
import type { InstrumentOptions, UsageEvent } from "../types.js";

type Defaults = Required<
  Pick<
    InstrumentOptions,
    "team" | "service" | "feature" | "environment" | "customerId"
  >
> & {
  tags: Record<string, string>;
  provider: string;
};

type WrapContext = {
  transport: Transport;
  defaults: Defaults;
};

export function wrapAnthropicClient<T extends object>(
  client: T,
  ctx: WrapContext,
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "messages") return wrapMessages(value, ctx);
      return value;
    },
  });
}

function wrapMessages(messages: unknown, ctx: WrapContext): unknown {
  if (!messages || typeof messages !== "object") return messages;
  return new Proxy(messages, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "create" && typeof value === "function") {
        return async function wrappedMessagesCreate(
          this: unknown,
          params: Record<string, unknown>,
        ) {
          return interceptMessagesCreate(
            (value as Function).bind(target),
            params,
            ctx,
          );
        };
      }
      return value;
    },
  });
}

async function interceptMessagesCreate(
  create: (params: Record<string, unknown>) => unknown,
  params: Record<string, unknown>,
  ctx: WrapContext,
): Promise<unknown> {
  const startMs = Date.now();
  const model = typeof params.model === "string" ? params.model : "unknown";
  const stream = params.stream === true;

  let response: unknown;
  try {
    response = await create(params);
  } catch (exc) {
    emitEvent(ctx, {
      model,
      endpoint: "messages",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startMs,
      status: "error",
      errorCode: exc instanceof Error ? exc.constructor.name : "Error",
    });
    throw exc;
  }

  if (stream) {
    return wrapAnthropicStream(response, model, startMs, ctx);
  }

  const usage = readAnthropicUsage(response);
  emitEvent(ctx, {
    model,
    endpoint: "messages",
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedTokens: usage.cached,
    latencyMs: Date.now() - startMs,
    status: "success",
  });

  return response;
}

function wrapAnthropicStream(
  stream: unknown,
  model: string,
  startMs: number,
  ctx: WrapContext,
): AsyncIterable<unknown> {
  const source = stream as AsyncIterable<unknown>;
  return {
    async *[Symbol.asyncIterator]() {
      let inputTokens = 0;
      let outputTokens = 0;
      let firstTokenMs = 0;
      let gotFirst = false;
      try {
        for await (const event of source) {
          if (!gotFirst) {
            firstTokenMs = Date.now() - startMs;
            gotFirst = true;
          }
          const type = (event as { type?: string }).type;
          if (type === "message_start") {
            const usage = (event as { message?: { usage?: { input_tokens?: number } } })
              .message?.usage;
            if (usage?.input_tokens !== undefined) inputTokens = usage.input_tokens;
          } else if (type === "message_delta") {
            const usage = (event as { usage?: { output_tokens?: number } }).usage;
            if (usage?.output_tokens !== undefined) outputTokens = usage.output_tokens;
          }
          yield event;
        }
      } catch (exc) {
        emitEvent(ctx, {
          model,
          endpoint: "messages",
          inputTokens,
          outputTokens,
          latencyMs: Date.now() - startMs,
          timeToFirstTokenMs: firstTokenMs,
          status: "error",
          errorCode: exc instanceof Error ? exc.constructor.name : "Error",
        });
        throw exc;
      }
      emitEvent(ctx, {
        model,
        endpoint: "messages",
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startMs,
        timeToFirstTokenMs: firstTokenMs,
        status: "success",
      });
    },
  };
}

function readAnthropicUsage(response: unknown): {
  input: number;
  output: number;
  cached: number;
} {
  const usage = (response as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return { input: 0, output: 0, cached: 0 };
  return {
    input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    cached:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
  };
}

type PartialEvent = {
  model: string;
  endpoint: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  status: "success" | "error";
  errorCode?: string;
};

function emitEvent(ctx: WrapContext, partial: PartialEvent): void {
  try {
    const attribution = getCurrentAttribution();
    const event: UsageEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      provider: ctx.defaults.provider,
      model: partial.model,
      endpoint: partial.endpoint,
      input_tokens: partial.inputTokens,
      output_tokens: partial.outputTokens,
      total_tokens: partial.inputTokens + partial.outputTokens,
      cached_tokens: partial.cachedTokens ?? 0,
      latency_ms: partial.latencyMs,
      time_to_first_token_ms: partial.timeToFirstTokenMs ?? 0,
      status: partial.status,
      error_code: partial.errorCode ?? "",
      team: attribution.team ?? ctx.defaults.team,
      service: attribution.service ?? ctx.defaults.service,
      feature: attribution.feature ?? ctx.defaults.feature,
      environment: attribution.environment ?? ctx.defaults.environment,
      customer_id: attribution.customer_id ?? ctx.defaults.customerId,
      tags: ctx.defaults.tags,
    };
    ctx.transport.enqueue(event);
  } catch {
    // Never raise from instrumentation.
  }
}
