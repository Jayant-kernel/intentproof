import "dotenv/config";

import { resolve } from "node:path";

import { verifyLedger } from "../ledger/verify.js";

const ledgerPath = process.argv[2] ?? process.env.LEDGER_PATH ?? "./ledger.jsonl";

try {
  const result = verifyLedger(ledgerPath);
  if (!result.valid) {
    process.stderr.write(`Ledger verification failed: ${result.reason}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Ledger integrity verified: ${result.records} records in ${resolve(ledgerPath)}\n`
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Ledger verification failed: ${message}\n`);
  process.exitCode = 1;
}
