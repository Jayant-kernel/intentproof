import "dotenv/config";

import { resolve } from "node:path";

import { buildWebhookEvidence, saveWebhookEvidence } from "../evidence/webhook-delivery.js";
import { AuditStore } from "../ledger/audit-store.js";
import { exportLedger } from "../ledger/exporter.js";
import { verifyLedger } from "../ledger/verify.js";

const databasePath = process.env.DB_PATH ?? "./intentproof.db";
const ledgerPath = process.env.LEDGER_PATH ?? "./ledger.jsonl";
const evidencePath = process.argv[2] ?? "./evidence/razorpay-test-webhook.json";
const store = new AuditStore(databasePath);

try {
  const auditRows = store.list();
  const exportedRecords = exportLedger(auditRows, ledgerPath);
  const ledgerVerification = verifyLedger(ledgerPath);
  const report = buildWebhookEvidence({
    auditRows,
    exportedRecords,
    ledgerVerification,
    source: "razorpay_test_mode"
  });
  const saved = saveWebhookEvidence(evidencePath, report);
  process.stdout.write(`Sanitized Razorpay Test Mode webhook evidence written to ${resolve(saved)}\n`);
} finally {
  store.close();
}
