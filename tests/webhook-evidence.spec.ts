import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { buildWebhookEvidence } from "../src/evidence/webhook-delivery.js";
import { signWebhook } from "../src/intake/signature.js";
import { AuditStore } from "../src/ledger/audit-store.js";
import { exportLedger } from "../src/ledger/exporter.js";
import { verifyLedger } from "../src/ledger/verify.js";

const stores: AuditStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("sanitized webhook evidence", () => {
  it("contains chain hashes but no raw payload, contact data, secret, or entity IDs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "intentproof-webhook-evidence-"));
    const store = new AuditStore(join(directory, "audit.db"));
    stores.push(store);
    const secret = "synthetic_webhook_secret";
    const eventId = "evt_SYNTHETIC001";
    const paymentId = "pay_SYNTHETIC001";
    const email = "buyer@example.test";
    const phone = "+919999999999";
    const app = createApp({ auditStore: store, webhookSecrets: [secret] });
    const send = (event: string, currentEventId: string) => {
      const body = JSON.stringify({
        event,
        payload: { payment: { entity: { id: paymentId, email, contact: phone } } }
      });
      return request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-event-id", currentEventId)
      .set("x-razorpay-signature", signWebhook(Buffer.from(body), secret))
      .send(body);
    };

    expect((await send("payment.authorized", eventId)).body.status).toBe("applied");
    expect((await send("payment.authorized", eventId)).body.status).toBe("duplicate_delivery");
    expect((await send("payment.captured", "evt_SYNTHETIC002")).body.status).toBe("applied");
    expect((await send("order.paid", "evt_SYNTHETIC003")).body.status).toBe("duplicate_effect");

    const auditRows = store.list();
    const ledgerPath = join(directory, "ledger.jsonl");
    const exportedRecords = exportLedger(auditRows, ledgerPath);
    const ledgerVerification = verifyLedger(ledgerPath);
    const report = buildWebhookEvidence({
      auditRows,
      exportedRecords,
      ledgerVerification,
      source: "synthetic_test"
    });
    const serializedAudit = JSON.stringify(auditRows);
    const serializedReport = JSON.stringify(report);

    expect(report).toMatchObject({
      source: "synthetic_test",
      lifecycle: { complete: true },
      raw_payload_stored: false,
      response_body_stored: false,
      upstream_mutation_by_intentproof: false,
      ledger_verification: { valid: true, records: 4 }
    });
    for (const sensitive of [secret, eventId, paymentId, email, phone]) {
      expect(serializedAudit).not.toContain(sensitive);
      expect(serializedReport).not.toContain(sensitive);
    }
    expect(report.lifecycle.events).toHaveLength(3);
    expect(report.lifecycle.events.find((event) => event.event_type === "payment.authorized")?.duplicate).toBe(true);
    expect(report.audit_records).toHaveLength(4);
    expect(report.audit_records.every((record) => /^sha256:[a-f0-9]{64}$/u.test(record.hash))).toBe(true);
  });
});
