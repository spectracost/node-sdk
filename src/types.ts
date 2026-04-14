/**
 * Core type definitions for the Spectracost SDK.
 *
 * UsageEvent mirrors the wire format documented in sdk/SPEC.md. Empty string
 * / empty object fields are stripped on serialization to minimize payload.
 */

export type UsageEvent = {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  model_version?: string;
  endpoint: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  latency_ms: number;
  time_to_first_token_ms?: number;
  status: "success" | "error" | "rate_limited" | "timeout";
  error_code?: string;
  team?: string;
  service?: string;
  feature?: string;
  environment?: string;
  customer_id?: string;
  tags?: Record<string, string>;
  idempotency_key?: string;
  provider_request_id?: string;
  prompt_hash?: string;
  prompt_template_id?: string;
};

export type InstrumentOptions = {
  apiKey: string;
  endpoint?: string;
  provider?: string;
  team?: string;
  service?: string;
  feature?: string;
  environment?: string;
  customerId?: string;
  tags?: Record<string, string>;
};

export type AttributionTags = {
  team?: string;
  service?: string;
  feature?: string;
  environment?: string;
  customerId?: string;
  [custom: string]: string | undefined;
};
