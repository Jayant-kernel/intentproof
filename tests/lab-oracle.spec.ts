import { describe, expect, it } from "vitest";

import { runLabEvents } from "../src/lab/model-runner.js";
import type { LabEvent, LabTool, ProviderState } from "../src/lab/schema.js";

function request(intentId: string, tool: LabTool, eventId = `${intentId}-request`): LabEvent {
  return {
    schema_version: 1,
    event_id: eventId,
    at_ms: 0,
    type: "AGENT_TOOL_REQUESTED",
    intent_id: intentId,
    idempotency_key: `${intentId}-key`,
    tool,
    amount_paise: 100,
    currency: "INR"
  };
}

function providerState(
  eventId: string,
  intentId: string,
  effectId: string,
  state: ProviderState,
  atMs: number
): LabEvent {
  return {
    schema_version: 1,
    event_id: eventId,
    at_ms: atMs,
    type: "PROVIDER_ACCEPTED",
    intent_id: intentId,
    effect_id: effectId,
    provider_state: state
  };
}

function invariant(events: LabEvent[], id: string) {
  return runLabEvents(events, "unsafe_reference").invariants.find((result) => result.id === id)!;
}

describe("Counterfactual Lab correctness oracle", () => {
  it("reports a stale raw observation without treating safe monotonic handling as a failure", () => {
    const events = [
      request("capture", "capture_payment"),
      providerState("captured", "capture", "effect", "captured", 1),
      providerState("late-authorized", "capture", "effect", "authorized", 2)
    ];
    const result = invariant(events, "RAW_PROVIDER_HISTORY_VALID");

    expect(result.passed).toBe(true);
    expect(result.observations).toEqual([
      "STALE_PROVIDER_STATE:capture:effect:authorized:late-authorized"
    ]);
  });

  it("detects contradictory history hidden by the monotonic normalized state", () => {
    const events = [
      request("capture", "capture_payment"),
      providerState("captured", "capture", "effect", "captured", 1),
      providerState("failed", "capture", "effect", "failed", 2)
    ];
    const run = runLabEvents(events, "unsafe_reference");
    const result = run.invariants.find((entry) => entry.id === "RAW_PROVIDER_HISTORY_VALID")!;

    expect(run.finalState.intents.capture?.moneyState).toBe("captured");
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toContain("CONTRADICTORY_PROVIDER_STATE");
  });

  it("rejects provider states that are impossible for the requested tool", () => {
    const result = invariant(
      [
        request("order", "create_order"),
        providerState("bad-state", "order", "effect", "captured", 1)
      ],
      "RAW_PROVIDER_HISTORY_VALID"
    );

    expect(result.passed).toBe(false);
    expect(result.violations[0]).toContain("IMPOSSIBLE_TOOL_STATE");
  });

  it("detects one provider effect attributed to two intents", () => {
    const result = invariant(
      [
        request("one", "create_order"),
        request("two", "create_order", "two-request"),
        providerState("one-effect", "one", "shared-effect", "created", 1),
        providerState("two-effect", "two", "shared-effect", "created", 2)
      ],
      "ONE_EFFECT_ONE_INTENT"
    );

    expect(result).toMatchObject({ passed: false, violations: ["shared-effect"] });
  });

  it("makes same-time revocation deterministic and version-aware", () => {
    const prefix: LabEvent[] = [
      request("intent", "create_order"),
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
    const revoke: LabEvent = {
      schema_version: 1,
      event_id: "revoke",
      at_ms: 3,
      type: "AUTHORITY_REVOKED",
      mandate_version: 1,
      reason: "test"
    };
    const claim = (version: number): LabEvent => ({
      schema_version: 1,
      event_id: `claim-${version}`,
      at_ms: 3,
      type: "DISPATCH_CLAIMED",
      intent_id: "intent",
      mandate_version: version
    });

    expect(invariant([...prefix, revoke, claim(1)], "REVOCATION_STOPS_DISPATCH").passed).toBe(false);
    expect(invariant([...prefix, claim(1), revoke], "REVOCATION_STOPS_DISPATCH").passed).toBe(true);
    expect(invariant([...prefix, revoke, claim(2)], "REVOCATION_STOPS_DISPATCH").passed).toBe(true);
  });
});
