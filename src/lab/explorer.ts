import { createHash } from "node:crypto";

import { canonicalJson } from "../ledger/canonical.js";
import { generateExplorationActions, materializeAction, type ExplorationAction } from "./generator.js";
import { evaluateLabInvariants, type LabInvariantId } from "./invariants.js";
import { minimizeFailingTrace } from "./minimizer.js";
import { runLabEvents, type LabModelRun } from "./model-runner.js";
import { createRegressionFixture, reproduceRegression } from "./regression.js";
import type { ExplorationSpec, RegressionFixture } from "./exploration-schema.js";
import type { LabEvent } from "./schema.js";
import { normalizeLabState } from "./state.js";

export interface ExplorerCounterexample {
  failure_id: string;
  invariant_id: LabInvariantId;
  action_schedule: string[];
  original_trace_length: number;
  minimized_trace_length: number;
  original_events: LabEvent[];
  minimized_events: LabEvent[];
  unsafe_passed: boolean;
  intentproof_passed: boolean;
  comparison_reproduced: boolean;
  fixture: RegressionFixture;
  reproduction_command: string;
  fixture_path: string | null;
}

export interface ExplorerReport {
  schema_version: 1;
  exploration_id: string;
  model: ExplorationSpec["model"];
  seed: number;
  bounds: ExplorationSpec["bounds"];
  generated_actions: number;
  explored_schedules: number;
  unique_states: number;
  pruned_states: number;
  failures_found: number;
  schedule_hashes: string[];
  counterexamples: ExplorerCounterexample[];
  limit_hits: {
    max_events: number;
    max_depth: number;
    max_schedules: boolean;
    max_runtime: boolean;
  };
  runtime_ms: number;
  deterministic_digest: string;
}

export interface ExploreOptions {
  now?: () => number;
}

interface SearchNode {
  completed: string[];
  remaining: ExplorationAction[];
  events: LabEvent[];
  run: LabModelRun;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function orderedCandidates(
  actions: readonly ExplorationAction[],
  seed: number,
  completed: readonly string[]
): ExplorationAction[] {
  return [...actions].sort((left, right) => {
    const leftPriority = digest(`${seed}:${completed.join(",")}:${left.id}`);
    const rightPriority = digest(`${seed}:${completed.join(",")}:${right.id}`);
    return leftPriority.localeCompare(rightPriority) || left.id.localeCompare(right.id);
  });
}

function pruneProjection(run: LabModelRun, remaining: readonly ExplorationAction[]): unknown {
  const state = normalizeLabState(run.finalState);
  state.clockMs = 0;
  state.sequence = 0;
  state.appliedEventIds = [];
  state.authority.revokedAtSequence = null;
  for (const intent of Object.values(state.intents)) {
    intent.evidenceEventIds = [];
    intent.terminalEvidenceEventId = null;
  }
  return {
    state,
    remaining: remaining.map((action) => action.id).sort(),
    oracle: evaluateLabInvariants(run.trace, run.finalState).map((invariant) => ({
      id: invariant.id,
      violations: invariant.violations,
      observations: invariant.observations
    }))
  };
}

function failedInvariants(run: LabModelRun): LabInvariantId[] {
  return run.invariants
    .filter((invariant) => !invariant.passed)
    .map((invariant) => invariant.id);
}

export function exploreSchedules(
  specification: ExplorationSpec,
  options: ExploreOptions = {}
): ExplorerReport {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const actions = generateExplorationActions(specification);
  const initialRun = runLabEvents([], specification.model, specification.initial_time_ms);
  const seenStates = new Set<string>();
  const scheduleHashes: string[] = [];
  const counterexamples: ExplorerCounterexample[] = [];
  const capturedInvariants = new Set<LabInvariantId>();
  let exploredSchedules = 0;
  let prunedStates = 0;
  let uniqueStates = 1;
  let failuresFound = 0;
  let maxEventHits = 0;
  let maxDepthHits = 0;
  let scheduleLimitHit = false;
  let runtimeLimitHit = false;

  const runtimeExceeded = (): boolean => {
    if (now() - startedAt < specification.bounds.max_runtime_ms) return false;
    runtimeLimitHit = true;
    return true;
  };

  const visit = (node: SearchNode): void => {
    if (runtimeExceeded()) return;
    if (exploredSchedules >= specification.bounds.max_schedules) {
      scheduleLimitHit = true;
      return;
    }
    if (node.remaining.length === 0) {
      exploredSchedules += 1;
      scheduleHashes.push(digest(node.completed));
      const failures = failedInvariants(node.run);
      if (failures.length === 0) return;
      failuresFound += 1;
      const target = failures[0];
      if (!target || capturedInvariants.has(target)) return;

      const minimized = minimizeFailingTrace(
        node.events,
        specification.model,
        target,
        specification.initial_time_ms
      );
      const fixture = createRegressionFixture({
        explorationId: specification.exploration_id,
        seed: specification.seed,
        initialTimeMs: specification.initial_time_ms,
        invariantId: target,
        events: minimized.events
      });
      const comparison = reproduceRegression(fixture);
      capturedInvariants.add(target);
      counterexamples.push({
        failure_id: fixture.fixture_id,
        invariant_id: target,
        action_schedule: [...node.completed],
        original_trace_length: node.events.length,
        minimized_trace_length: minimized.minimizedLength,
        original_events: structuredClone(node.events),
        minimized_events: structuredClone(minimized.events),
        unsafe_passed: comparison.unsafe.passed,
        intentproof_passed: comparison.intentproof.passed,
        comparison_reproduced: comparison.reproduced,
        fixture,
        reproduction_command: `npm run lab -- reproduce regressions/lab/${fixture.fixture_id}.json`,
        fixture_path: null
      });
      return;
    }
    if (node.completed.length >= specification.bounds.max_depth) {
      maxDepthHits += 1;
      return;
    }

    const completed = new Set(node.completed);
    const enabled = node.remaining.filter((candidate) =>
      candidate.after.every((dependency) => completed.has(dependency))
    );
    if (enabled.length === 0) return;
    const earliest = Math.min(...enabled.map((candidate) => candidate.atMs));
    const candidates = orderedCandidates(
      enabled.filter((candidate) => candidate.atMs === earliest),
      specification.seed,
      node.completed
    );

    for (const candidate of candidates) {
      if (runtimeExceeded() || exploredSchedules >= specification.bounds.max_schedules) {
        if (exploredSchedules >= specification.bounds.max_schedules) scheduleLimitHit = true;
        return;
      }
      const newEvents = materializeAction(
        candidate,
        specification,
        node.run.finalState,
        specification.model
      );
      if (node.events.length + newEvents.length > specification.bounds.max_events) {
        maxEventHits += 1;
        continue;
      }
      const events = [...node.events, ...newEvents];
      const run = runLabEvents(events, specification.model, specification.initial_time_ms);
      const remaining = node.remaining.filter((action) => action.id !== candidate.id);
      const stateKey = digest(pruneProjection(run, remaining));
      if (seenStates.has(stateKey)) {
        prunedStates += 1;
        continue;
      }
      seenStates.add(stateKey);
      uniqueStates += 1;
      visit({
        completed: [...node.completed, candidate.id],
        remaining,
        events,
        run
      });
    }
  };

  visit({ completed: [], remaining: actions, events: [], run: initialRun });
  const runtimeMs = Math.max(0, Math.ceil(now() - startedAt));
  const deterministicPayload = {
    exploration_id: specification.exploration_id,
    model: specification.model,
    seed: specification.seed,
    generated_actions: actions.length,
    explored_schedules: exploredSchedules,
    unique_states: uniqueStates,
    pruned_states: prunedStates,
    failures_found: failuresFound,
    schedule_hashes: scheduleHashes,
    counterexamples: counterexamples.map((counterexample) => ({
      failure_id: counterexample.failure_id,
      invariant_id: counterexample.invariant_id,
      action_schedule: counterexample.action_schedule,
      original_trace_length: counterexample.original_trace_length,
      minimized_trace_length: counterexample.minimized_trace_length,
      original_events: counterexample.original_events,
      minimized_events: counterexample.minimized_events,
      comparison_reproduced: counterexample.comparison_reproduced
    })),
    limit_hits: {
      max_events: maxEventHits,
      max_depth: maxDepthHits,
      max_schedules: scheduleLimitHit,
      max_runtime: runtimeLimitHit
    }
  };

  return {
    schema_version: 1,
    exploration_id: specification.exploration_id,
    model: specification.model,
    seed: specification.seed,
    bounds: specification.bounds,
    generated_actions: actions.length,
    explored_schedules: exploredSchedules,
    unique_states: uniqueStates,
    pruned_states: prunedStates,
    failures_found: failuresFound,
    schedule_hashes: scheduleHashes,
    counterexamples,
    limit_hits: deterministicPayload.limit_hits,
    runtime_ms: runtimeMs,
    deterministic_digest: digest(deterministicPayload)
  };
}
