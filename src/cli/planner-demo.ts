import { resolve } from "node:path";

import { runPlannerDemo } from "../agent/planner-demo.js";
import { canonicalJson } from "../ledger/canonical.js";
import { loadMandate } from "../mandate/load.js";

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error("Usage: npm run planner:demo");
  }
  const transcript = await runPlannerDemo(loadMandate(resolve("mandates/default.yaml")));
  process.stdout.write(`${canonicalJson({ schema_version: 1, fake_upstream: true, transcript })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
