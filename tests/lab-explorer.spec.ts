import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { exploreSchedules } from "../src/lab/explorer.js";
import {
  parseExplorationSpec,
  type ExplorationSpec
} from "../src/lab/exploration-schema.js";
import { runLabEvents } from "../src/lab/model-runner.js";
import {
  loadRegressionFixture,
  reproduceRegression,
  saveRegressionFixture
} from "../src/lab/regression.js";

const campaignPath = resolve("campaigns/lab/unsafe-retry.json");
const fixturePath = resolve(
  "regressions/lab/unsafe-retry-discovery-one_intent_one_effect.json"
);

function campaign(overrides: Partial<ExplorationSpec> = {}): ExplorationSpec {
  const source = JSON.parse(readFileSync(campaignPath, "utf8")) as ExplorationSpec;
  return parseExplorationSpec({ ...source, ...overrides });
}

describe("bounded Counterfactual Lab exploration", () => {
  it("is deterministic for the same campaign and seed", () => {
    const first = exploreSchedules(campaign({ seed: 809 }));
    const second = exploreSchedules(campaign({ seed: 809 }));

    expect(second.deterministic_digest).toBe(first.deterministic_digest);
    expect(second.schedule_hashes).toEqual(first.schedule_hashes);
    expect(second.counterexamples).toEqual(first.counterexamples);
  });

  it("uses the seed to choose between equal-time schedules", () => {
    const first = exploreSchedules(campaign({ seed: 1 }));
    const second = exploreSchedules(campaign({ seed: 2 }));

    expect(second.schedule_hashes).not.toEqual(first.schedule_hashes);
    expect(second.counterexamples[0]?.action_schedule).not.toEqual(
      first.counterexamples[0]?.action_schedule
    );
  });

  it("prunes schedule prefixes with equivalent normalized state", () => {
    const report = exploreSchedules(campaign());

    expect(report.unique_states).toBeGreaterThan(1);
    expect(report.pruned_states).toBeGreaterThan(0);
  });

  it("enforces event, depth, schedule, and runtime bounds", () => {
    const source = campaign();
    const eventBound = exploreSchedules(
      campaign({ bounds: { ...source.bounds, max_events: 5 } })
    );
    const depthBound = exploreSchedules(
      campaign({ bounds: { ...source.bounds, max_depth: 3 } })
    );
    const scheduleBound = exploreSchedules(
      campaign({
        workflow: { ...source.workflow, faults: ["revocation_race"] },
        bounds: { ...source.bounds, max_schedules: 1 }
      })
    );
    let clock = 0;
    const runtimeBound = exploreSchedules(
      campaign({ bounds: { ...source.bounds, max_runtime_ms: 1 } }),
      { now: () => (clock += 2) }
    );

    expect(eventBound.limit_hits.max_events).toBeGreaterThan(0);
    expect(depthBound.limit_hits.max_depth).toBeGreaterThan(0);
    expect(scheduleBound.explored_schedules).toBe(1);
    expect(scheduleBound.limit_hits.max_schedules).toBe(true);
    expect(runtimeBound.limit_hits.max_runtime).toBe(true);
  });

  it("discovers and minimizes an unsafe retry failure from a compact campaign", () => {
    const specification = campaign();
    expect("events" in specification).toBe(false);

    const report = exploreSchedules(specification);
    const failure = report.counterexamples.find(
      (candidate) => candidate.invariant_id === "ONE_INTENT_ONE_EFFECT"
    );

    expect(report.failures_found).toBeGreaterThan(0);
    expect(failure).toBeDefined();
    expect(failure!.original_trace_length).toBeGreaterThan(failure!.minimized_trace_length);
    expect(failure!.comparison_reproduced).toBe(true);
  });

  it("preserves the target failure identity during minimization", () => {
    const failure = exploreSchedules(campaign()).counterexamples[0]!;
    const minimized = runLabEvents(failure.minimized_events, "unsafe_reference");

    expect(
      minimized.invariants.find((invariant) => invariant.id === failure.invariant_id)
    ).toMatchObject({ passed: false });
  });

  it("writes and reloads a versioned regression fixture", () => {
    const failure = exploreSchedules(campaign()).counterexamples[0]!;
    const directory = mkdtempSync(join(tmpdir(), "intentproof-lab-"));
    try {
      const savedPath = saveRegressionFixture(failure.fixture, directory);
      const loaded = loadRegressionFixture(savedPath);

      expect(loaded).toEqual(failure.fixture);
      expect(reproduceRegression(loaded).reproduced).toBe(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps the unsafe fixture failing while IntentProof passes", () => {
    const result = reproduceRegression(loadRegressionFixture(fixturePath));

    expect(result.reproduced).toBe(true);
    expect(result.unsafe.passed).toBe(false);
    expect(result.intentproof.passed).toBe(true);
  });
});
