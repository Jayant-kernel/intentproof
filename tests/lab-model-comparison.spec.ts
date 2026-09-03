import { describe, expect, it } from "vitest";

import { runLabEvents } from "../src/lab/model-runner.js";
import type { LabEvent } from "../src/lab/schema.js";

const prefix: LabEvent[] = [
  {
    schema_version: 1,
    event_id: "request",
    at_ms: 0,
    type: "AGENT_TOOL_REQUESTED",
    intent_id: "intent",
    idempotency_key: "key",
    tool: "create_order",
    amount_paise: 100,
    currency: "INR"
  },
  {
    schema_version: 1,
    event_id: "policy",
    at_ms: 1,
    type: "POLICY_DECIDED",
    intent_id: "intent",
    verdict: "ALLOW",
    rule_id: "ALLOW"
  },
  {
    schema_version: 1,
    event_id: "reserve",
    at_ms: 2,
    type: "BUDGET_RESERVED",
    intent_id: "intent"
  }
];

const claim: LabEvent = {
  schema_version: 1,
  event_id: "claim",
  at_ms: 3,
  type: "DISPATCH_CLAIMED",
  intent_id: "intent",
  mandate_version: 1
};

const sent: LabEvent = {
  schema_version: 1,
  event_id: "sent",
  at_ms: 4,
  type: "PROVIDER_MUTATION_SENT",
  intent_id: "intent",
  attempt_id: "attempt"
};

function result(events: LabEvent[], model: "intentproof" | "unsafe_reference", id: string) {
  return runLabEvents(events, model).invariants.find((entry) => entry.id === id)!;
}

describe("unsafe reference model compared with IntentProof", () => {
  it("exposes dispatch after a same-version revocation", () => {
    const revoke: LabEvent = {
      schema_version: 1,
      event_id: "revoke",
      at_ms: 3,
      type: "AUTHORITY_REVOKED",
      mandate_version: 1,
      reason: "operator revoked"
    };
    const events = [...prefix, revoke, claim, sent];

    expect(result(events, "unsafe_reference", "REVOCATION_STOPS_DISPATCH").passed).toBe(false);
    expect(result(events, "intentproof", "REVOCATION_STOPS_DISPATCH").passed).toBe(true);
    expect(runLabEvents(events, "intentproof").finalState.provider.mutationAttemptIds).toHaveLength(0);
  });

  it("exposes release of budget after an uncertain timeout", () => {
    const events: LabEvent[] = [
      ...prefix,
      claim,
      sent,
      {
        schema_version: 1,
        event_id: "accepted",
        at_ms: 4,
        type: "PROVIDER_ACCEPTED",
        intent_id: "intent",
        attempt_id: "attempt",
        effect_id: "effect",
        provider_state: "created"
      },
      {
        schema_version: 1,
        event_id: "timeout",
        at_ms: 5,
        type: "TIMEOUT_OBSERVED",
        intent_id: "intent",
        phase: "AFTER_ACCEPTANCE"
      }
    ];

    expect(result(events, "unsafe_reference", "UNCERTAINTY_STAYS_CHARGED").passed).toBe(false);
    expect(result(events, "intentproof", "UNCERTAINTY_STAYS_CHARGED").passed).toBe(true);
    expect(runLabEvents(events, "intentproof").finalState.intents.intent).toMatchObject({
      dispatchState: "IN_DOUBT",
      budgetCharged: true
    });
  });

  it("exposes duplicate webhook and reconciler settlement", () => {
    const events: LabEvent[] = [
      ...prefix,
      claim,
      sent,
      {
        schema_version: 1,
        event_id: "webhook",
        at_ms: 5,
        type: "WEBHOOK_DELIVERED",
        intent_id: "intent",
        delivery_id: "delivery",
        effect_id: "effect",
        provider_state: "captured"
      },
      {
        schema_version: 1,
        event_id: "reconcile",
        at_ms: 5,
        type: "RECONCILIATION_READ",
        intent_id: "intent",
        outcome: "MATCHED_COMMITTED",
        effect_id: "effect"
      }
    ];

    expect(result(events, "unsafe_reference", "RACING_SETTLEMENT_ONCE").passed).toBe(false);
    expect(result(events, "intentproof", "RACING_SETTLEMENT_ONCE").passed).toBe(true);
  });
});
