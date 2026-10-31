/* Remove run-level budget gating: usage is only recorded as telemetry, with no
   limits or pre-scheduling reservations. Protection now comes from the existing
   timeouts/retries/repair counts/context safety margins. */
export const migration038 = {
  version: 38,
  name: "drop-run-budget-limits",
  sql: `
    DROP TABLE IF EXISTS physical_call_reservations;
    ALTER TABLE runs DROP COLUMN budget_limit_json;
    ALTER TABLE autopilot_sessions DROP COLUMN child_budget_json;
  `,
} as const;
