import { relative, resolve } from "node:path";

import {
  buildProofBundle,
  loadVerifiedScoreboard,
  verifyProofBundle
} from "../evidence/proof-bundle.js";
import { canonicalJson } from "../ledger/canonical.js";

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run evidence -- build --output <directory> [--created-at <ISO-8601>]",
    "  npm run evidence -- verify <manifest.json>",
    "  npm run evidence -- score <manifest.json>"
  ].join("\n"));
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1] ?? usage();
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build") {
    const output = option(args, "--output") ?? usage();
    const createdAt = option(args, "--created-at");
    const allowed = new Set(["--output", "--created-at"]);
    for (let index = 0; index < args.length; index += 2) {
      if (!allowed.has(args[index] ?? "") || args[index + 1] === undefined) usage();
    }
    const manifest = buildProofBundle({
      rootDirectory: process.cwd(),
      outputDirectory: resolve(output),
      ...(createdAt ? { createdAt } : {})
    });
    process.stdout.write(`Evidence bundle built: ${relative(process.cwd(), manifest).replaceAll("\\", "/")}\n`);
    return;
  }
  if (command === "verify" && args.length === 1) {
    const result = verifyProofBundle(resolve(args[0]!));
    process.stdout.write(`${canonicalJson(result)}\n`);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  if (command === "score" && args.length === 1) {
    const score = loadVerifiedScoreboard(resolve(args[0]!));
    process.stdout.write([
      `Tests: ${score.tests_passed} passed across ${score.test_files_passed} files`,
      `Invariants: ${score.invariants_checked}`,
      `Chaos schedules: ${score.chaos_schedules_explored}; failures found: ${score.failures_independently_discovered}`,
      `Trace reduction: ${score.trace_original_events} -> ${score.trace_minimized_events} (${score.trace_events_removed} removed)`,
      `Unsafe model: ${score.unsafe_model_passed ? "PASS" : "FAIL"}; IntentProof: ${score.intentproof_passed ? "PASS" : "FAIL"}`,
      `Non-ALLOW upstream calls: ${score.non_allow_upstream_calls}`,
      `Duplicate effects prevented: ${score.duplicate_effects_prevented}`,
      `Ledger: ${score.ledger_verified ? "VERIFIED" : "FAILED"}`,
      `Real webhook: ${score.real_webhook_status}`,
      `Provenance: ${canonicalJson(score.provenance_counts)}`
    ].join("\n") + "\n");
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
