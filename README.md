# spectracost

AI cost observability SDK for Node.js, Deno, and Bun. Wrap your OpenAI or
Anthropic client once; every call is tracked automatically.

```bash
npm install spectracost openai
```

```ts
import OpenAI from "openai";
import { instrument } from "spectracost";

const client = instrument(new OpenAI(), {
  apiKey: "sprc_...",
  team: "search",
  service: "query-rewriter",
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Per-call attribution

```ts
import { attribution } from "spectracost";

await attribution({ feature: "semantic-search", customerId: "cust_abc" }, async () => {
  const resp = await client.chat.completions.create({ /* ... */ });
});
```

## Works with any OpenAI-compatible provider

Point your OpenAI client at Groq, DeepSeek, Together, Mistral, xAI, OpenRouter,
Fireworks, or Spectracost's own proxy. The SDK auto-detects the provider from
`baseURL`.

```ts
const client = instrument(
  new OpenAI({ baseURL: "https://api.groq.com/openai/v1" }),
  { apiKey: "sprc_..." },
);
// Events attributed as provider="groq".
```

## Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import { instrument } from "spectracost";

const client = instrument(new Anthropic(), {
  apiKey: "sprc_...",
});

const msg = await client.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 100,
  messages: [{ role: "user", content: "Hello!" }],
});
```

## License

MIT
