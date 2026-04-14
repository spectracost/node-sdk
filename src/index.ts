/**
 * Public entry point for the spectracost npm package.
 *
 * Usage:
 *   import { instrument, attribution } from "spectracost";
 */

export { instrument } from "./instrument.js";
export { attribution, getCurrentAttribution } from "./attribution.js";
export type {
  InstrumentOptions,
  AttributionTags,
  UsageEvent,
} from "./types.js";
