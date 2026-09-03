import { resolve } from "node:path";

import { runDeterministicDemo } from "../agent/demo-agent.js";
import { canonicalJson } from "../ledger/canonical.js";
import { loadMandate } from "../mandate/load.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length === 2 && args[0] !== "--mandate")) {
    throw new Error("Usage: npm run agent -- [--mandate <approved-mandate>]");
  }
  const mandatePath = args[0] === "--mandate" && args[1] ? args[1] : "mandates/default.yaml";
  const transcript = await runDeterministicDemo(loadMandate(resolve(mandatePath)));
  process.stdout.write(`${canonicalJson({ schema_version: 1, fake_upstream: true, transcript })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
