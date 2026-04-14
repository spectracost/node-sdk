/**
 * OpenAI client wrapper — uses a Proxy so the wrapped client behaves
 * exactly like the underlying one for every property, intercepting only
 * chat.completions.create and embeddings.create.
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

export function wrapOpenAIClient<T extends object>(
  client: T,
  ctx: WrapContext,
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "chat") return wrapChat(value, ctx);
      if (prop === "embeddings") return wrapEmbeddings(value, ctx);
      return value;
    },
  });
}

function wrapChat(chat: unknown, ctx: WrapContext): unknown {
  if (!chat || typeof chat !== "object") return chat;
  return new Proxy(chat, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "completions") return wrapCompletions(value, ctx);
      return value;
    },
  });
}

function wrapCompletions(completions: unknown, ctx: WrapContext): unknown {
  if (!completions || typeof completions !== "object") return completions;
  return new Proxy(completions, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "create" && typeof value === "function") {
        return async function wrappedCreate(this: unknown, params: Record<string, unknown>) {
          return interceptChatCompletion(
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

function wrapEmbeddings(embeddings: unknown, ctx: WrapContext): unknown {
  if (!embeddings || typeof embeddings !== "object") return embeddings;
  return new Proxy(embeddings, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "create" && typeof value === "function") {
        return async function wrappedEmbedCreate(this: unknown, params: Record<string, unknown>) {
          return interceptEmbedding(
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

async function interceptChatCompletion(
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
      endpoint: "chat.completions",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startMs,
      status: "error",
      errorCode: exc instanceof Error ? exc.constructor.name : "Error",
    });
    throw exc;
  }

  if (stream) {
    return wrapChatStream(response, model, startMs, ctx);
  }

  const usage = readOpenAIUsage(response);
  emitEvent(ctx, {
    model,
    endpoint: "chat.completions",
    inputTokens: usage.input,
    outputTokens: usage.output,
    cachedTokens: usage.cached,
    latencyMs: Date.now() - startMs,
    status: "success",
  });

  return response;
}

async function interceptEmbedding(
  create: (params: Record<string, unknown>) => unknown,
  params: Record<string, unknown>,
  ctx: WrapContext,
): Promise<unknown> {
  const startMs = Date.now();
  const model = typeof params.model === "string" ? params.model : "unknown";
  try {
    const response = await create(params);
    const usage = readOpenAIUsage(response);
    emitEvent(ctx, {
      model,
      endpoint: "embeddings",
      inputTokens: usage.input,
      outputTokens: 0,
      latencyMs: Date.now() - startMs,
      status: "success",
    });
    return response;
  } catch (exc) {
    emitEvent(ctx, {
      model,
      endpoint: "embeddings",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startMs,
      status: "error",
      errorCode: exc instanceof Error ? exc.constructor.name : "Error",
    });
    throw exc;
  }
}

function wrapChatStream(
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
        for await (const chunk of source) {
          if (!gotFirst) {
            firstTokenMs = Date.now() - startMs;
            gotFirst = true;
          }
          const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
          if (usage) {
            inputTokens = usage.prompt_tokens ?? inputTokens;
            outputTokens = usage.completion_tokens ?? outputTokens;
          }
          yield chunk;
        }
      } catch (exc) {
        emitEvent(ctx, {
          model,
          endpoint: "chat.completions",
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
        endpoint: "chat.completions",
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startMs,
        timeToFirstTokenMs: firstTokenMs,
        status: "success",
      });
    },
  };
}

function readOpenAIUsage(response: unknown): {
  input: number;
  output: number;
  cached: number;
} {
  const usage = (response as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return { input: 0, output: 0, cached: 0 };
  const promptDetails = usage.prompt_tokens_details as
    | { cached_tokens?: number }
    | undefined;
  return {
    input: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    output:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : 0,
    cached: promptDetails?.cached_tokens ?? 0,
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
