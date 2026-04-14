/**
 * Attribution context — per-call tag overrides.
 *
 * Uses AsyncLocalStorage so tags propagate through async/await boundaries
 * without the customer having to thread a context object manually.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { AttributionTags } from "./types.js";

const storage = new AsyncLocalStorage<Record<string, string>>();

/**
 * Run `fn` with the given attribution tags merged on top of any parent
 * context. Exiting the scope (via return or throw) restores the parent
 * automatically.
 *
 * @example
 *   await attribution({ feature: "semantic-search" }, async () => {
 *     await client.chat.completions.create({ ... });
 *   });
 */
export function attribution<T>(
  tags: AttributionTags,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parent = storage.getStore() ?? {};
  const merged: Record<string, string> = { ...parent };
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined && value !== null) {
      merged[key === "customerId" ? "customer_id" : key] = value;
    }
  }
  return storage.run(merged, fn);
}

/** Read the current attribution context. Returns an empty object if none. */
export function getCurrentAttribution(): Record<string, string> {
  return storage.getStore() ?? {};
}
