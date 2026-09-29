/**
 * Capability flags the connection probe writes (see POST /api/providers/test).
 * They describe one upstream model, so re-pointing a model at a different
 * model id, base URL, endpoint or wire API returns them to unknown.
 */
const PROBED_CAPABILITY_KEYS = [
  "streaming",
  "tools",
  "structuredOutput",
  "structuredOutputNative",
  "structuredOutputJsonMode",
  "samplingParameters",
  "maxCompletionTokens",
] as const;

/** Drops the probe-written flags and keeps every other capability. */
export function withoutProbedCapabilities(
  capabilities: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  const remaining = { ...capabilities };
  for (const key of PROBED_CAPABILITY_KEYS) delete remaining[key];
  return remaining;
}
