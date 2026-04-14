import { describe, expect, it } from "vitest";

import { instrument, attribution } from "../src/index.js";
import { startTelemetryServer, waitFor } from "./helpers.js";

/**
 * Minimal fake of the OpenAI client surface: only what our wrapper
 * intercepts. Uses the same module path so detect.ts's fallback
 * recognizes it.
 */
function makeFakeOpenAI({
  baseURL,
  response,
  error,
}: {
  baseURL?: string;
  response?: Record<string, unknown>;
  error?: Error;
} = {}) {
  const client = {
    baseURL,
    chat: {
      completions: {
        async create(_params: Record<string, unknown>) {
          if (error) throw error;
          return (
            response ?? {
              id: "chatcmpl_test",
              usage: { prompt_tokens: 120, completion_tokens: 45 },
            }
          );
        },
      },
    },
    embeddings: {
      async create(_params: Record<string, unknown>) {
        return { usage: { prompt_tokens: 17 } };
      },
    },
  };
  return client;
}

function makeFakeAnthropic({
  response,
  error,
}: {
  response?: Record<string, unknown>;
  error?: Error;
} = {}) {
  return {
    messages: {
      async create(_params: Record<string, unknown>) {
        if (error) throw error;
        return (
          response ?? {
            id: "msg_test",
            usage: { input_tokens: 200, output_tokens: 80 },
          }
        );
      },
    },
  };
}

describe("instrument() - OpenAI", () => {
  it("returns the same response the underlying client returned", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(makeFakeOpenAI(), {
        apiKey: "sprc_test",
        endpoint: server.url,
      });
      const resp = await wrapped.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [],
      });
      expect((resp as { id: string }).id).toBe("chatcmpl_test");
    } finally {
      await server.close();
    }
  });

  it("emits a telemetry event with model, tokens, and attribution", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(makeFakeOpenAI(), {
        apiKey: "sprc_test",
        endpoint: server.url,
        team: "search",
        service: "query-rewriter",
      });
      await wrapped.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [],
      });
      await waitFor(() => server.events.length >= 1);
      const [event] = server.events;
      expect(event).toBeTruthy();
      expect(event!.provider).toBe("openai");
      expect(event!.model).toBe("gpt-4o-mini");
      expect(event!.endpoint).toBe("chat.completions");
      expect(event!.input_tokens).toBe(120);
      expect(event!.output_tokens).toBe(45);
      expect(event!.team).toBe("search");
      expect(event!.service).toBe("query-rewriter");
    } finally {
      await server.close();
    }
  });

  it("propagates exceptions unchanged and still emits an error event", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(
        makeFakeOpenAI({ error: new Error("boom") }),
        { apiKey: "sprc_test", endpoint: server.url },
      );
      await expect(
        wrapped.chat.completions.create({ model: "gpt-4o-mini", messages: [] }),
      ).rejects.toThrow("boom");
      await waitFor(() => server.events.length >= 1);
      expect(server.events[0]!.status).toBe("error");
    } finally {
      await server.close();
    }
  });

  it("detects provider from baseURL when pointed at Groq", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(
        makeFakeOpenAI({ baseURL: "https://api.groq.com/openai/v1" }),
        { apiKey: "sprc_test", endpoint: server.url },
      );
      await wrapped.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [],
      });
      await waitFor(() => server.events.length >= 1);
      expect(server.events[0]!.provider).toBe("groq");
    } finally {
      await server.close();
    }
  });

  it("respects explicit provider override", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(
        makeFakeOpenAI({ baseURL: "https://api.groq.com/openai/v1" }),
        {
          apiKey: "sprc_test",
          endpoint: server.url,
          provider: "custom-groq",
        },
      );
      await wrapped.chat.completions.create({ model: "x", messages: [] });
      await waitFor(() => server.events.length >= 1);
      expect(server.events[0]!.provider).toBe("custom-groq");
    } finally {
      await server.close();
    }
  });
});

describe("instrument() - Anthropic", () => {
  it("emits a messages event with correct token counts", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(makeFakeAnthropic(), {
        apiKey: "sprc_test",
        endpoint: server.url,
        team: "support",
      });
      await wrapped.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [],
      });
      await waitFor(() => server.events.length >= 1);
      const [event] = server.events;
      expect(event!.provider).toBe("anthropic");
      expect(event!.endpoint).toBe("messages");
      expect(event!.input_tokens).toBe(200);
      expect(event!.output_tokens).toBe(80);
      expect(event!.team).toBe("support");
    } finally {
      await server.close();
    }
  });
});

describe("attribution()", () => {
  it("overrides client-level tags within the scope", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(makeFakeOpenAI(), {
        apiKey: "sprc_test",
        endpoint: server.url,
        team: "default-team",
        service: "default-service",
      });
      await attribution(
        { team: "override-team", feature: "semantic-search" },
        async () => {
          await wrapped.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [],
          });
        },
      );
      await waitFor(() => server.events.length >= 1);
      const [event] = server.events;
      expect(event!.team).toBe("override-team");
      expect(event!.service).toBe("default-service");
      expect(event!.feature).toBe("semantic-search");
    } finally {
      await server.close();
    }
  });
});

describe("provider detection - all known hosts", () => {
  const cases: Array<[string, string]> = [
    ["https://api.openai.com/v1", "openai"],
    ["https://api.deepseek.com/v1", "deepseek"],
    ["https://api.groq.com/openai/v1", "groq"],
    ["https://api.together.xyz/v1", "together"],
    ["https://api.mistral.ai/v1", "mistral"],
    ["https://api.x.ai/v1", "xai"],
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://api.fireworks.ai/inference/v1", "fireworks"],
    ["https://generativelanguage.googleapis.com", "google"],
    ["https://api.cohere.com", "cohere"],
  ];

  for (const [url, expected] of cases) {
    it(`maps ${url} -> ${expected}`, async () => {
      const server = await startTelemetryServer();
      try {
        const wrapped = instrument(makeFakeOpenAI({ baseURL: url }), {
          apiKey: "sprc_test",
          endpoint: server.url,
        });
        await wrapped.chat.completions.create({ model: "x", messages: [] });
        await waitFor(() => server.events.length >= 1);
        expect(server.events[0]!.provider).toBe(expected);
      } finally {
        await server.close();
      }
    });
  }
});

describe("provider detection - Spectracost proxy path", () => {
  it("parses provider out of /proxy/v1/<name>/", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(
        makeFakeOpenAI({
          baseURL: "https://spectracost.com/proxy/v1/deepseek/v1",
        }),
        { apiKey: "sprc_test", endpoint: server.url },
      );
      await wrapped.chat.completions.create({ model: "x", messages: [] });
      await waitFor(() => server.events.length >= 1);
      expect(server.events[0]!.provider).toBe("deepseek");
    } finally {
      await server.close();
    }
  });

  it("skips sprc_ path segments", async () => {
    const server = await startTelemetryServer();
    try {
      const wrapped = instrument(
        makeFakeOpenAI({
          baseURL: "https://spectracost.com/proxy/v1/together/sprc_abc/v1",
        }),
        { apiKey: "sprc_test", endpoint: server.url },
      );
      await wrapped.chat.completions.create({ model: "x", messages: [] });
      await waitFor(() => server.events.length >= 1);
      expect(server.events[0]!.provider).toBe("together");
    } finally {
      await server.close();
    }
  });
});

describe("failure isolation", () => {
  it("does not affect LLM calls when telemetry endpoint is dead", async () => {
    const wrapped = instrument(makeFakeOpenAI(), {
      apiKey: "sprc_test",
      endpoint: "http://127.0.0.1:1", // unreachable
    });
    const resp = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [],
    });
    expect((resp as { id: string }).id).toBe("chatcmpl_test");
  });
});
