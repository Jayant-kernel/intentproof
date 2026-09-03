import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { LabInvariantId } from "./invariants.js";
import {
  parseRegressionFixture,
  type RegressionFixture
} from "./exploration-schema.js";
import { runLabEvents, type LabModelRun } from "./model-runner.js";
import type { LabEvent } from "./schema.js";

export interface RegressionResult {
  fixture: RegressionFixture;
  unsafe: LabModelRun;
  intentproof: LabModelRun;
  reproduced: boolean;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function createRegressionFixture(input: {
  explorationId: string;
  seed: number;
  initialTimeMs: number;
  invariantId: LabInvariantId;
  events: readonly LabEvent[];
}): RegressionFixture {
  return parseRegressionFixture({
    schema_version: 1,
    fixture_id: `${safeName(input.explorationId)}-${input.invariantId.toLowerCase()}`,
    source_exploration_id: input.explorationId,
    seed: input.seed,
    initial_time_ms: input.initialTimeMs,
    invariant_id: input.invariantId,
    events: input.events,
    expected: {
      unsafe_reference_pass: false,
      intentproof_pass: true
    }
  });
}

export function saveRegressionFixture(fixture: RegressionFixture, outputDirectory: string): string {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${safeName(fixture.fixture_id)}.json`);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  renameSync(temporaryPath, path);
  return path;
}

export function loadRegressionFixture(path: string): RegressionFixture {
  return parseRegressionFixture(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function reproduceRegression(fixture: RegressionFixture): RegressionResult {
  const unsafe = runLabEvents(
    fixture.events,
    "unsafe_reference",
    fixture.initial_time_ms
  );
  const intentproof = runLabEvents(
    fixture.events,
    "intentproof",
    fixture.initial_time_ms
  );
  const unsafeViolation = unsafe.invariants.some(
    (invariant) => invariant.id === fixture.invariant_id && !invariant.passed
  );
  const safeViolation = intentproof.invariants.some(
    (invariant) => invariant.id === fixture.invariant_id && !invariant.passed
  );
  return {
    fixture,
    unsafe,
    intentproof,
    reproduced: unsafeViolation && !safeViolation && !unsafe.passed && intentproof.passed
  };
}
