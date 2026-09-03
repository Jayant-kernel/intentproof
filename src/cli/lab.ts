import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { canonicalJson } from "../ledger/canonical.js";
import { exploreSchedules } from "../lab/explorer.js";
import { parseExplorationSpec } from "../lab/exploration-schema.js";
import {
  loadRegressionFixture,
  reproduceRegression,
  saveRegressionFixture
} from "../lab/regression.js";
import { runLabScenarioFile, serializeLabReport } from "../lab/replay.js";

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run lab -- run <scenario.json>",
      "  npm run lab -- replay <scenario.json> --seed <uint32>",
      "  npm run lab -- explore <campaign.json> [--seed <uint32>] [--output-dir <path>]",
      "  npm run lab -- reproduce <regression.json>"
    ].join("\n")
  );
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1] ?? usage();
}

function assertOnlyOptions(args: readonly string[], allowed: readonly string[]): void {
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name || !allowed.includes(name) || args[index + 1] === undefined) usage();
  }
}

function parseSeed(raw: string | undefined, required: boolean): number | undefined {
  if (raw === undefined) {
    if (required) throw new Error("replay requires --seed <uint32>");
    return undefined;
  }
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("--seed must be an unsigned 32-bit integer");
  }
  return seed;
}

function print(value: unknown): void {
  process.stdout.write(`${canonicalJson(value)}\n`);
}

function main(): void {
  const [command, inputPath, ...args] = process.argv.slice(2);
  if (!command || !inputPath) usage();

  if (command === "run") {
    if (args.length !== 0) throw new Error("run uses the seed embedded in the scenario");
    const { report } = runLabScenarioFile(resolve(inputPath));
    process.stdout.write(serializeLabReport(report));
    if (!report.expectation_matched) process.exitCode = 1;
    return;
  }

  if (command === "replay") {
    assertOnlyOptions(args, ["--seed"]);
    const seed = parseSeed(option(args, "--seed"), true);
    const { report } = runLabScenarioFile(resolve(inputPath), seed);
    process.stdout.write(serializeLabReport(report));
    if (!report.expectation_matched) process.exitCode = 1;
    return;
  }

  if (command === "explore") {
    assertOnlyOptions(args, ["--seed", "--output-dir"]);
    const parsed = parseExplorationSpec(
      JSON.parse(readFileSync(resolve(inputPath), "utf8")) as unknown
    );
    const seed = parseSeed(option(args, "--seed"), false);
    const specification = seed === undefined ? parsed : { ...parsed, seed };
    const report = exploreSchedules(specification);
    const outputDirectory = option(args, "--output-dir") ?? "regressions/lab";
    for (const counterexample of report.counterexamples) {
      const savedPath = saveRegressionFixture(counterexample.fixture, outputDirectory);
      const displayPath = relative(process.cwd(), savedPath).replaceAll("\\", "/");
      counterexample.fixture_path = displayPath;
      counterexample.reproduction_command = `npm run lab -- reproduce ${displayPath}`;
    }
    print(report);
    if (!report.counterexamples.some((failure) => failure.comparison_reproduced)) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "reproduce") {
    if (args.length !== 0) usage();
    const result = reproduceRegression(loadRegressionFixture(resolve(inputPath)));
    print({
      schema_version: 1,
      fixture_id: result.fixture.fixture_id,
      invariant_id: result.fixture.invariant_id,
      reproduced: result.reproduced,
      unsafe_reference: {
        passed: result.unsafe.passed,
        state_hash: result.unsafe.stateHash,
        invariants: result.unsafe.invariants
      },
      intentproof: {
        passed: result.intentproof.passed,
        state_hash: result.intentproof.stateHash,
        invariants: result.intentproof.invariants
      }
    });
    if (!result.reproduced) process.exitCode = 1;
    return;
  }

  usage();
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
