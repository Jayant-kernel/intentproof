import { z } from "zod";

export const LAB_SCHEMA_VERSION = 1 as const;

export const labToolSchema = z.enum([
  "create_order",
  "create_payment_link",
  "capture_payment"
]);
export const labVerdictSchema = z.enum([
  "ALLOW",
  "BLOCK",
  "HOLD_FOR_APPROVAL",
  "ABSTAIN"
]);
export const providerStateSchema = z.enum([
  "created",
  "authorized",
  "captured",
  "refunded",
  "failed"
]);

const baseEvent = z.object({
  schema_version: z.literal(LAB_SCHEMA_VERSION),
  event_id: z.string().min(1).max(128),
  at_ms: z.number().int().safe().nonnegative()
});
const intentId = z.string().min(1).max(128);

export const labEventSchema = z.discriminatedUnion("type", [
  baseEvent
    .extend({
      type: z.literal("AGENT_TOOL_REQUESTED"),
      intent_id: intentId,
      idempotency_key: z.string().min(1).max(128),
      tool: labToolSchema,
      amount_paise: z.number().int().safe().nonnegative(),
      currency: z.literal("INR")
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("POLICY_DECIDED"),
      intent_id: intentId,
      verdict: labVerdictSchema,
      rule_id: z.string().min(1).max(128)
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("BUDGET_RESERVED"),
      intent_id: intentId
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("DISPATCH_CLAIMED"),
      intent_id: intentId,
      mandate_version: z.number().int().safe().positive()
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("PROVIDER_MUTATION_SENT"),
      intent_id: intentId,
      attempt_id: z.string().min(1).max(128)
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("PROVIDER_ACCEPTED"),
      intent_id: intentId,
      effect_id: z.string().min(1).max(128),
      provider_state: providerStateSchema
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("PROVIDER_REJECTED"),
      intent_id: intentId,
      reason: z.string().min(1).max(256)
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("TIMEOUT_OBSERVED"),
      intent_id: intentId,
      phase: z.enum(["BEFORE_ACCEPTANCE", "AFTER_ACCEPTANCE", "RECONCILIATION_READ"])
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("PROCESS_CRASHED"),
      process_id: z.string().min(1).max(128),
      reason: z.string().min(1).max(256)
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("PROCESS_RESTARTED"),
      process_id: z.string().min(1).max(128)
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("WEBHOOK_DELIVERED"),
      intent_id: intentId,
      delivery_id: z.string().min(1).max(128),
      effect_id: z.string().min(1).max(128),
      provider_state: providerStateSchema
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("RECONCILIATION_READ"),
      intent_id: intentId,
      outcome: z.enum([
        "MATCHED_COMMITTED",
        "MATCHED_FAILED",
        "EMPTY",
        "MALFORMED",
        "AUTHORIZED",
        "CONFLICTING"
      ]),
      effect_id: z.string().min(1).max(128).optional()
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("AUTHORITY_REVOKED"),
      mandate_version: z.number().int().safe().positive(),
      reason: z.string().min(1).max(256)
    })
    .strict(),
  baseEvent
    .extend({
      type: z.literal("OPERATOR_DECIDED"),
      intent_id: intentId,
      decision: z.enum(["COMMIT", "RELEASE", "KEEP_IN_DOUBT"]),
      reason: z.string().min(1).max(256)
    })
    .strict()
]);

export const labScenarioSchema = z
  .object({
    schema_version: z.literal(LAB_SCHEMA_VERSION),
    scenario_id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    description: z.string().min(1).max(2_048),
    seed: z.number().int().safe().min(0).max(0xffff_ffff),
    initial_time_ms: z.number().int().safe().nonnegative(),
    events: z.array(labEventSchema).min(1),
    expected: z
      .object({
        invariants_pass: z.boolean()
      })
      .strict()
  })
  .strict()
  .superRefine((scenario, context) => {
    const eventIds = new Set<string>();
    for (const [index, event] of scenario.events.entries()) {
      if (event.at_ms < scenario.initial_time_ms) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "at_ms"],
          message: "event cannot precede the scenario clock"
        });
      }
      if (eventIds.has(event.event_id)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "event_id"],
          message: "event_id must be unique within a scenario"
        });
      }
      eventIds.add(event.event_id);
    }
  });

export type LabTool = z.infer<typeof labToolSchema>;
export type LabVerdict = z.infer<typeof labVerdictSchema>;
export type ProviderState = z.infer<typeof providerStateSchema>;
export type LabEvent = z.infer<typeof labEventSchema>;
export type LabScenario = z.infer<typeof labScenarioSchema>;

export function parseLabScenario(input: unknown): LabScenario {
  return labScenarioSchema.parse(input);
}
