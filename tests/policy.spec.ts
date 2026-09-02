import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadMandate } from "../src/mandate/load.js";
import type { Mandate } from "../src/mandate/schema.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import type { PolicyContext } from "../src/policy/types.js";

describe("deterministic policy engine", () => {
  let mandate: Mandate;
  const baseContext: PolicyContext = {
    now: new Date("2026-09-02T10:00:00.000Z"),
    killSwitch: false,
    expectedMandateVersion: 1,
    rollingCalls: 0,
    rollingValuePaise: 0
  };

  beforeAll(() => {
    mandate = loadMandate(resolve("mandates/default.yaml"));
  });

  it("allows an order at the exact ceiling", () => {
    const result = evaluatePolicy(mandate, { tool: "create_order", amount_paise: 300_000 }, baseContext);
    expect(result.verdict).toBe("ALLOW");
  });

  it("blocks one paisa above the ceiling and quotes the merchant", () => {
    const result = evaluatePolicy(mandate, { tool: "create_order", amount_paise: 300_001 }, baseContext);
    expect(result.verdict).toBe("BLOCK");
    expect(result.rule_id).toBe("C2");
    expect(result.quote).toBe("Create orders up to 3,000 rupees.");
  });

  it("abstains when delivery evidence is unavailable", () => {
    const result = evaluatePolicy(
      mandate,
      { tool: "capture_payment", amount_paise: 100_000 },
      baseContext
    );
    expect(result.verdict).toBe("ABSTAIN");
    expect(result.rule_id).toBe("C3");
  });

  it("holds a large capture for approval after delivery is confirmed", () => {
    const result = evaluatePolicy(
      mandate,
      { tool: "capture_payment", amount_paise: 250_000 },
      { ...baseContext, deliveryConfirmed: true }
    );
    expect(result.verdict).toBe("HOLD_FOR_APPROVAL");
    expect(result.rule_id).toBe("C4");
  });

  it("allows the same capture after approval", () => {
    const result = evaluatePolicy(
      mandate,
      { tool: "capture_payment", amount_paise: 250_000 },
      { ...baseContext, deliveryConfirmed: true, approvalGranted: true }
    );
    expect(result.verdict).toBe("ALLOW");
  });

  it("blocks rolling value overspend with the budget source sentence", () => {
    const result = evaluatePolicy(
      mandate,
      { tool: "create_order", amount_paise: 200_000 },
      { ...baseContext, rollingValuePaise: 2_400_001 }
    );
    expect(result.verdict).toBe("BLOCK");
    expect(result.rule_id).toBe("BUDGET_VALUE");
    expect(result.quote).toContain("25,000 rupees per day");
  });

  it("treats the end of the allowed time window as exclusive", () => {
    const beforeClose = evaluatePolicy(
      mandate,
      { tool: "create_order", amount_paise: 19_900 },
      { ...baseContext, now: new Date("2026-09-02T16:29:59.999Z") }
    );
    const atClose = evaluatePolicy(
      mandate,
      { tool: "create_order", amount_paise: 19_900 },
      { ...baseContext, now: new Date("2026-09-02T16:30:00.000Z") }
    );
    expect(beforeClose.verdict).toBe("ALLOW");
    expect(atClose.verdict).toBe("BLOCK");
    expect(atClose.rule_id).toBe("C5");
  });

  it("blocks immediately when the kill switch is engaged", () => {
    const result = evaluatePolicy(
      mandate,
      { tool: "create_order", amount_paise: 19_900 },
      { ...baseContext, killSwitch: true }
    );
    expect(result).toMatchObject({ verdict: "BLOCK", rule_id: "SYSTEM_KILL_SWITCH" });
  });
});
