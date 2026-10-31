import type { NarrativeRun } from "@lapis/domain";
import { policyIntInRange } from "./transport.js";

/** Structured-output repair budget; defaults to the previous hardcoded 2. */
export function structuredMaxRepairAttempts(run: NarrativeRun): number {
  return policyIntInRange(run.policy.maxRepairAttempts, 0, 3) ?? 2;
}
