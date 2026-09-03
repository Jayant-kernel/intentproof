import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateLabInvariants } from "../src/lab/invariants.js";
import {
  loadLabScenario,
  runLabScenario,
  runLabScenarioFile,
  serializeLabReport
} from "../src/lab/replay.js";

const scenarioDirectory = resolve("scenarios/lab");
const scenarioPaths = readdirSync(scenarioDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => resolve(scenarioDirectory, name));

describe("Counterfactual Lab replay", () => {
  it("replays all eight Month 1 scenarios with passing invariants", () => {
    expect(scenarioPaths).toHaveLength(8);
    for (const path of scenarioPaths) {
      const { report } = runLabScenarioFile(path);
      expect(report.passed, report.scenario_id).toBe(true);
      expect(report.expectation_matched, report.scenario_id).toBe(true);
      expect(report.invariants).toHaveLength(7);
      expect(report.invariants.every((invariant) => invariant.passed)).toBe(true);
    }
  });

  it("produces byte-identical reports for the same scenario and seed", () => {
    const scenario = loadLabScenario(resolve(scenarioDirectory, "webhook-reconciler-race.json"));
    const first = runLabScenario(scenario, 808);
    const second = runLabScenario(scenario, 808);

    expect(serializeLabReport(first.report)).toBe(serializeLabReport(second.report));
    expect(first.trace).toEqual(second.trace);
  });

  it("preserves the expected state for each required failure story", () => {
    const run = (name: string) => runLabScenarioFile(resolve(scenarioDirectory, name)).report;

    expect(run("timeout-after-acceptance.json").final_state.intents["intent-timeout"]).toMatchObject({
      dispatchState: "IN_DOUBT",
      budgetCharged: true
    });
    expect(run("duplicate-webhook.json").final_state.intents["intent-duplicate"]).toMatchObject({
      dispatchState: "COMMITTED",
      terminalTransitions: 1
    });
    expect(run("out-of-order-webhook.json").final_state.intents["intent-ordering"]).toMatchObject({
      moneyState: "captured",
      moneyRank: 3
    });
    expect(run("retry.json").final_state.intents["intent-retry"]).toMatchObject({
      requestCount: 2,
      mutationAttemptIds: ["attempt-retry"]
    });
    expect(run("crash-restart.json").final_state.intents["intent-crash"]).toMatchObject({
      dispatchState: "IN_DOUBT",
      budgetCharged: true
    });
    expect(run("revocation-race.json").final_state).toMatchObject({
      authority: { revoked: true }
    });
    expect(run("malformed-read.json").final_state.intents["intent-malformed"]).toMatchObject({
      dispatchState: "IN_DOUBT",
      budgetCharged: true
    });
    expect(run("webhook-reconciler-race.json").final_state.intents["intent-race"]).toMatchObject({
      dispatchState: "COMMITTED",
      terminalTransitions: 1
    });
  });

  it("reports a denied mutation and duplicate financial effects", () => {
    const scenario = loadLabScenario(resolve(scenarioDirectory, "timeout-after-acceptance.json"));
    scenario.expected.invariants_pass = false;
    scenario.events[1] = {
      schema_version: 1,
      event_id: "e2",
      at_ms: 10,
      type: "POLICY_DECIDED",
      intent_id: "intent-timeout",
      verdict: "BLOCK",
      rule_id: "DENIED"
    };
    scenario.events.push({
      schema_version: 1,
      event_id: "e8",
      at_ms: 70,
      type: "PROVIDER_ACCEPTED",
      intent_id: "intent-timeout",
      effect_id: "second-effect",
      provider_state: "created"
    });
    const { report } = runLabScenario(scenario);

    expect(report.passed).toBe(false);
    expect(report.invariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "DENIED_ZERO_MUTATIONS", passed: false }),
        expect.objectContaining({ id: "ONE_INTENT_ONE_EFFECT", passed: false })
      ])
    );
  });

  it("detects independently corrupted budget and terminal evidence state", () => {
    const run = runLabScenarioFile(resolve(scenarioDirectory, "duplicate-webhook.json"));
    const corrupted = structuredClone(run.report.final_state);
    const intent = corrupted.intents["intent-duplicate"]!;
    intent.dispatchState = "IN_DOUBT";
    intent.budgetCharged = false;
    intent.terminalEvidenceEventId = null;
    const results = evaluateLabInvariants(run.trace, corrupted);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "UNCERTAINTY_STAYS_CHARGED", passed: false })
      ])
    );

    intent.dispatchState = "COMMITTED";
    const evidenceResults = evaluateLabInvariants(run.trace, corrupted);
    expect(evidenceResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "TERMINAL_EVIDENCE_RECONSTRUCTABLE", passed: false })
      ])
    );
  });

  it("rejects dispatch after authority has been revoked", () => {
    const scenario = loadLabScenario(resolve(scenarioDirectory, "revocation-race.json"));
    scenario.expected.invariants_pass = false;
    scenario.events.push({
      schema_version: 1,
      event_id: "e10",
      at_ms: 90,
      type: "DISPATCH_CLAIMED",
      intent_id: "intent-revoked",
      mandate_version: 1
    });

    const { report } = runLabScenario(scenario);
    expect(report.invariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "REVOCATION_STOPS_DISPATCH", passed: false })
      ])
    );
  });

  it("independently detects money regression, repeat settlement, and irrelevant evidence", () => {
    const run = runLabScenarioFile(resolve(scenarioDirectory, "duplicate-webhook.json"));
    const trace = structuredClone(run.trace);
    const nonterminal = structuredClone(trace.at(-1)!);
    nonterminal.sequence += 1;
    nonterminal.state.intents["intent-duplicate"]!.dispatchState = "IN_DOUBT";
    nonterminal.state.intents["intent-duplicate"]!.moneyRank = 0;
    trace.push(nonterminal);
    const terminalAgain = structuredClone(nonterminal);
    terminalAgain.sequence += 1;
    terminalAgain.state.intents["intent-duplicate"]!.dispatchState = "RELEASED";
    trace.push(terminalAgain);

    const finalState = structuredClone(terminalAgain.state);
    const intent = finalState.intents["intent-duplicate"]!;
    intent.terminalEvidenceEventId = "e1";
    const results = evaluateLabInvariants(trace, finalState);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "COMMITTED_MONEY_MONOTONIC", passed: false }),
        expect.objectContaining({ id: "RACING_SETTLEMENT_ONCE", passed: false }),
        expect.objectContaining({ id: "TERMINAL_EVIDENCE_RECONSTRUCTABLE", passed: false })
      ])
    );
  });
});
