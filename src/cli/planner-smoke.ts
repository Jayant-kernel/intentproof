import { canonicalJson } from "../ledger/canonical.js";
import { GeminiPlanner } from "../planner/gemini-planner.js";
import { planObjective } from "../planner/planner.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const objective = option("--objective");
  const model = option("--model");
  if (!objective || process.argv.slice(2).some((value, index, all) => index % 2 === 0 && !["--objective", "--model"].includes(value))) {
    throw new Error(
      "Usage: npm run planner:smoke -- --objective <synthetic-objective> [--model <gemini-model>]"
    );
  }
  const provider = new GeminiPlanner({ ...(model ? { model } : {}) });
  const proposal = await planObjective({ objective, provider });
  process.stdout.write(`${canonicalJson({
    planning_only: true,
    provider: provider.providerName,
    model: provider.modelName,
    tool: proposal.tool,
    intent_id: proposal.intent_id,
    explanation: proposal.explanation,
    arguments_schema_valid: true,
    gateway_available: false
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
