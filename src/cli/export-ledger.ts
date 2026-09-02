import "dotenv/config";

import { resolve } from "node:path";

import { AuditStore } from "../ledger/audit-store.js";
import { exportLedger } from "../ledger/exporter.js";

const databasePath = process.env.DB_PATH ?? "./intentproof.db";
const ledgerPath = process.argv[2] ?? process.env.LEDGER_PATH ?? "./ledger.jsonl";
const store = new AuditStore(databasePath);

try {
  const records = exportLedger(store.list(), ledgerPath);
  process.stdout.write(`Exported ${records.length} audit records to ${resolve(ledgerPath)}\n`);
} finally {
  store.close();
}
