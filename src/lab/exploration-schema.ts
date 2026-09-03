import { z } from "zod";

import { LAB_INVARIANT_IDS } from "./invariants.js";
import { labEventSchema, labToolSchema, LAB_SCHEMA_VERSION } from "./schema.js";

export const labModelSchema = z.enum(["intentproof", "unsafe_reference"]);

export const explorationFaultSchema = z.enum([
  "timeout_after_acceptance",
  "retry",
  "revocation_race",
  "duplicate_webhook",
  "webhook_reconciler_race",
  "contradictory_provider_state",
  "crash_restart",
  "malformed_read"
]);

const boundsSchema = z
  .object({
    max_events: z.number().int().positive().max(128),
    max_schedules: z.number().int().positive().max(100_000),
    max_depth: z.number().int().positive().max(128),
    max_runtime_ms: z.number().int().positive().max(300_000)
  })
  .strict();

export const explorationSpecSchema = z
  .object({
    schema_version: z.literal(LAB_SCHEMA_VERSION),
    exploration_id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    seed: z.number().int().min(0).max(0xffff_ffff),
    initial_time_ms: z.number().int().nonnegative(),
    model: labModelSchema,
    workflow: z
      .object({
        intent_id: z.string().min(1).max(128),
        idempotency_key: z.string().min(1).max(128),
        tool: labToolSchema,
        amount_paise: z.number().int().nonnegative(),
        mandate_version: z.number().int().positive(),
        faults: z.array(explorationFaultSchema).min(1).max(8)
      })
      .strict(),
    bounds: boundsSchema
  })
  .strict()
  .superRefine((specification, context) => {
    const seen = new Set<string>();
    for (const [index, fault] of specification.workflow.faults.entries()) {
      if (seen.has(fault)) {
        context.addIssue({
          code: "custom",
          path: ["workflow", "faults", index],
          message: "faults must be unique"
        });
      }
      seen.add(fault);
    }
  });

export const regressionFixtureSchema = z
  .object({
    schema_version: z.literal(LAB_SCHEMA_VERSION),
    fixture_id: z.string().min(1).max(128),
    source_exploration_id: z.string().min(1).max(128),
    seed: z.number().int().min(0).max(0xffff_ffff),
    initial_time_ms: z.number().int().nonnegative(),
    invariant_id: z.enum(LAB_INVARIANT_IDS),
    events: z.array(labEventSchema).min(1).max(128),
    expected: z
      .object({
        unsafe_reference_pass: z.literal(false),
        intentproof_pass: z.literal(true)
      })
      .strict()
  })
  .strict();

export type LabModel = z.infer<typeof labModelSchema>;
export type ExplorationFault = z.infer<typeof explorationFaultSchema>;
export type ExplorationSpec = z.infer<typeof explorationSpecSchema>;
export type RegressionFixture = z.infer<typeof regressionFixtureSchema>;

export function parseExplorationSpec(input: unknown): ExplorationSpec {
  return explorationSpecSchema.parse(input);
}

export function parseRegressionFixture(input: unknown): RegressionFixture {
  return regressionFixtureSchema.parse(input);
}
