import { describe, expect, it } from "vitest";

import { labEventSchema, parseLabScenario } from "../src/lab/schema.js";

const base = { schema_version: 1, event_id: "event", at_ms: 10 } as const;

describe("Counterfactual Lab event schema", () => {
  it("accepts every canonical event category", () => {
    const events = [
      { ...base, type: "AGENT_TOOL_REQUESTED", intent_id: "i", idempotency_key: "k", tool: "create_order", amount_paise: 100, currency: "INR" },
      { ...base, type: "POLICY_DECIDED", intent_id: "i", verdict: "ALLOW", rule_id: "C1" },
      { ...base, type: "BUDGET_RESERVED", intent_id: "i" },
      { ...base, type: "DISPATCH_CLAIMED", intent_id: "i", mandate_version: 1 },
      { ...base, type: "PROVIDER_MUTATION_SENT", intent_id: "i", attempt_id: "a" },
      { ...base, type: "PROVIDER_ACCEPTED", intent_id: "i", effect_id: "x", provider_state: "created" },
      { ...base, type: "PROVIDER_REJECTED", intent_id: "i", reason: "rejected" },
      { ...base, type: "TIMEOUT_OBSERVED", intent_id: "i", phase: "AFTER_ACCEPTANCE" },
      { ...base, type: "PROCESS_CRASHED", process_id: "p", reason: "crash" },
      { ...base, type: "PROCESS_RESTARTED", process_id: "p" },
      { ...base, type: "WEBHOOK_DELIVERED", intent_id: "i", delivery_id: "d", effect_id: "x", provider_state: "captured" },
      { ...base, type: "RECONCILIATION_READ", intent_id: "i", outcome: "EMPTY" },
      { ...base, type: "AUTHORITY_REVOKED", mandate_version: 1, reason: "revoked" },
      { ...base, type: "OPERATOR_DECIDED", intent_id: "i", decision: "KEEP_IN_DOUBT", reason: "review" }
    ];

    for (const event of events) expect(labEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects unknown schema versions, unsupported tools, and duplicate event IDs", () => {
    expect(
      labEventSchema.safeParse({
        ...base,
        schema_version: 2,
        type: "BUDGET_RESERVED",
        intent_id: "i"
      }).success
    ).toBe(false);
    expect(
      labEventSchema.safeParse({
        ...base,
        type: "AGENT_TOOL_REQUESTED",
        intent_id: "i",
        idempotency_key: "k",
        tool: "create_refund",
        amount_paise: 100,
        currency: "INR"
      }).success
    ).toBe(false);
    expect(() =>
      parseLabScenario({
        schema_version: 1,
        scenario_id: "duplicate",
        name: "Duplicate event IDs",
        description: "Invalid fixture",
        seed: 1,
        initial_time_ms: 0,
        events: [
          { ...base, type: "BUDGET_RESERVED", intent_id: "i" },
          { ...base, type: "BUDGET_RESERVED", intent_id: "i" }
        ],
        expected: { invariants_pass: false }
      })
    ).toThrow();
  });
});
