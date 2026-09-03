import { resolve } from "node:path";

import { runLabScenarioFile, serializeLabReport } from "../lab/replay.js";

function usage(): never {
  throw new Error("Usage: npm run lab -- <run|replay> <scenario.json> [--seed <uint32>]");
}

function parseSeed(args: readonly string[]): number | undefined {
  const index = args.indexOf("--seed");
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (raw === undefined) usage();
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("--seed must be an unsigned 32-bit integer");
  }
  return seed;
}

function main(): void {
  const [, , command, scenarioPath, ...rest] = process.argv;
  if ((command !== "run" && command !== "replay") || !scenarioPath) usage();
  const seed = parseSeed(rest);
  const { report } = runLabScenarioFile(resolve(scenarioPath), seed);
  process.stdout.write(serializeLabReport(report));
  if (!report.expectation_matched) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
