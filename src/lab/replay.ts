import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalJson } from "../ledger/canonical.js";
import { VirtualClock } from "./clock.js";
import { evaluateLabInvariants, type InvariantResult, type LabTraceEntry } from "./invariants.js";
import { SeededRandom } from "./random.js";
import { reduceLabState } from "./reducer.js";
import { parseLabScenario, type LabEvent, type LabScenario } from "./schema.js";
import { DeterministicScheduler } from "./scheduler.js";
import { initialLabState, normalizeLabState, type LabState } from "./state.js";

export interface LabRunReport {
  schema_version: 1;
  scenario_id: string;
  seed: number;
  event_count: number;
  passed: boolean;
  expected_pass: boolean;
  expectation_matched: boolean;
  state_hash: string;
  normalized_events: LabEvent[];
  final_state: LabState;
  invariants: InvariantResult[];
}

export interface LabRun {
  report: LabRunReport;
  trace: LabTraceEntry[];
}

export function runLabScenario(scenario: LabScenario, seed = scenario.seed): LabRun {
  const clock = new VirtualClock(scenario.initial_time_ms);
  const scheduler = new DeterministicScheduler<LabEvent>(clock, new SeededRandom(seed));
  for (const event of scenario.events) scheduler.schedule(event);
  const normalizedEvents = scheduler.drain();

  let state = initialLabState(scenario.initial_time_ms);
  const trace: LabTraceEntry[] = [];
  for (const event of normalizedEvents) {
    state = normalizeLabState(reduceLabState(state, event));
    trace.push({ sequence: state.sequence, event, state: structuredClone(state) });
  }
  const finalState = normalizeLabState(state);
  const invariants = evaluateLabInvariants(trace, finalState);
  const passed = invariants.every((invariant) => invariant.passed);
  const stateHash = `sha256:${createHash("sha256")
    .update(canonicalJson(finalState))
    .digest("hex")}`;
  return {
    trace,
    report: {
      schema_version: 1,
      scenario_id: scenario.scenario_id,
      seed,
      event_count: normalizedEvents.length,
      passed,
      expected_pass: scenario.expected.invariants_pass,
      expectation_matched: passed === scenario.expected.invariants_pass,
      state_hash: stateHash,
      normalized_events: normalizedEvents,
      final_state: finalState,
      invariants
    }
  };
}

export function loadLabScenario(path: string): LabScenario {
  return parseLabScenario(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function runLabScenarioFile(path: string, seed?: number): LabRun {
  const scenario = loadLabScenario(path);
  return runLabScenario(scenario, seed ?? scenario.seed);
}

export function serializeLabReport(report: LabRunReport): string {
  return `${canonicalJson(report)}\n`;
}
