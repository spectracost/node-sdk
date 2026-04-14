/**
 * Provider auto-detection — mirrors the Python SDK's logic so events are
 * attributed consistently across languages.
 *
 * See sdk/SPEC.md § "Provider auto-detection" for the rules.
 */

const PROVIDER_BY_HOST: Record<string, string> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "google",
  "api.cohere.com": "cohere",
  "api.deepseek.com": "deepseek",
  "api.groq.com": "groq",
  "api.together.xyz": "together",
  "api.mistral.ai": "mistral",
  "api.x.ai": "xai",
  "openrouter.ai": "openrouter",
  "api.fireworks.ai": "fireworks",
};

type ClientLike = {
  baseURL?: string | URL;
};

export function detectProvider(
  client: ClientLike,
  explicit: string | undefined,
  classHint: "openai" | "anthropic",
): string {
  if (explicit) return explicit;

  const baseUrl = client.baseURL;
  if (baseUrl) {
    const urlStr = typeof baseUrl === "string" ? baseUrl : baseUrl.toString();
    const pathProvider = providerFromSpectracostPath(urlStr);
    if (pathProvider) return pathProvider;
    const hostProvider = providerFromHost(urlStr);
    if (hostProvider) return hostProvider;
  }

  return classHint;
}

function providerFromSpectracostPath(url: string): string | null {
  const marker = "/proxy/v1/";
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  const tail = url.slice(idx + marker.length);
  const segments = tail.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const candidate = segments[0];
  if (!candidate || candidate.startsWith("sprc_")) return null;
  return candidate;
}

function providerFromHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase().split(":")[0] ?? "";
  } catch {
    return null;
  }
  if (!host) return null;
  for (const [known, name] of Object.entries(PROVIDER_BY_HOST)) {
    if (host === known || host.endsWith("." + known)) return name;
  }
  return null;
}
