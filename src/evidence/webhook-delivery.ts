import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AuditRow, ExportedAuditRecord } from "../ledger/types.js";
import type { VerificationResult } from "../ledger/verify.js";

const webhookAuditTypes = new Set([
  "WEBHOOK_APPLIED",
  "DUPLICATE_DROPPED",
  "EFFECT_DEDUPED",
  "OUT_OF_ORDER_IGNORED"
]);

export interface WebhookEvidenceReport {
  schema_version: 1;
  source: "razorpay_test_mode" | "synthetic_test";
  timestamp: string;
  lifecycle: {
    payment_id_hash: string;
    complete: boolean;
    events: Array<{
      event_category: string;
      event_type: string;
      event_id_hash: string;
      http_result: number;
      signature_valid: true;
      duplicate: boolean;
      transition_result: string;
    }>;
  };
  audit_records: Array<{ sequence: number; type: string; hash: string }>;
  ledger_verification: VerificationResult;
  raw_payload_stored: false;
  response_body_stored: false;
  upstream_mutation_by_intentproof: false;
  statement: string;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`Webhook audit row is missing ${key}`);
  return value;
}

export function buildWebhookEvidence(input: {
  auditRows: readonly AuditRow[];
  exportedRecords: readonly ExportedAuditRecord[];
  ledgerVerification: VerificationResult;
  source: WebhookEvidenceReport["source"];
}): WebhookEvidenceReport {
  if (!input.ledgerVerification.valid) {
    throw new Error("Cannot produce webhook evidence from an invalid audit chain");
  }
  const latest = [...input.auditRows]
    .reverse()
    .find((row) => webhookAuditTypes.has(row.type) && row.payload.signature_valid === true);
  if (!latest) throw new Error("No accepted webhook delivery exists in the audit store");

  const paymentIdHash = requiredString(latest.payload, "payment_id_hash");
  if (!/^sha256:[a-f0-9]{64}$/u.test(paymentIdHash)) {
    throw new Error("Webhook evidence identifiers are not SHA-256 hashes");
  }
  const related = input.auditRows.filter(
    (row) => webhookAuditTypes.has(row.type) && row.payload.payment_id_hash === paymentIdHash
  );
  const eventRows = related.filter((row) => row.payload.signature_valid === true);
  const eventIds = [...new Set(eventRows.map((row) => requiredString(row.payload, "event_id_hash")))];
  const events = eventIds.map((eventIdHash) => {
    if (!/^sha256:[a-f0-9]{64}$/u.test(eventIdHash)) {
      throw new Error("Webhook evidence identifiers are not SHA-256 hashes");
    }
    const deliveries = eventRows.filter((row) => row.payload.event_id_hash === eventIdHash);
    const primary = deliveries.find((row) => row.type !== "DUPLICATE_DROPPED") ?? deliveries[0];
    if (!primary) throw new Error("Webhook delivery evidence is incomplete");
    return {
      event_category: requiredString(primary.payload, "event_category"),
      event_type: requiredString(primary.payload, "event_type"),
      event_id_hash: eventIdHash,
      http_result: Number(primary.payload.http_status),
      signature_valid: true as const,
      duplicate: deliveries.some((row) => row.type === "DUPLICATE_DROPPED"),
      transition_result: requiredString(primary.payload, "transition_result")
    };
  });
  const recordsBySequence = new Map(input.exportedRecords.map((record) => [record.seq, record]));
  const auditRecords = related.map((row) => {
    const exported = recordsBySequence.get(row.seq);
    if (!exported) throw new Error(`Exported ledger is missing webhook audit sequence ${row.seq}`);
    return { sequence: row.seq, type: row.type, hash: exported.hash };
  });
  const receivedTypes = new Set(events.map((event) => event.event_type));

  return {
    schema_version: 1,
    source: input.source,
    timestamp: latest.ts,
    lifecycle: {
      payment_id_hash: paymentIdHash,
      complete: ["payment.authorized", "payment.captured", "order.paid"].every((eventType) =>
        receivedTypes.has(eventType)
      ),
      events
    },
    audit_records: auditRecords,
    ledger_verification: input.ledgerVerification,
    raw_payload_stored: false,
    response_body_stored: false,
    upstream_mutation_by_intentproof: false,
    statement: input.source === "razorpay_test_mode"
      ? "A user completed one Razorpay Test Mode payment to trigger this lifecycle. IntentProof performed no upstream mutation."
      : "This evidence was produced from a synthetic webhook fixture. IntentProof performed no upstream mutation."
  };
}

export function saveWebhookEvidence(path: string, report: WebhookEvidenceReport): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return target;
}
