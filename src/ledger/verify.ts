import { readFileSync } from "node:fs";

import { chainedHash, GENESIS_HASH } from "./canonical.js";
import type { ExportedAuditRecord } from "./types.js";

export interface VerificationResult {
  valid: boolean;
  records: number;
  brokenSeq: number | null;
  reason: string;
}

function failure(records: number, brokenSeq: number, reason: string): VerificationResult {
  return { valid: false, records, brokenSeq, reason };
}

export function verifyLedger(path: string): VerificationResult {
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);

  let previousHash = GENESIS_HASH;

  for (const [index, line] of lines.entries()) {
    const expectedSeq = index + 1;
    let record: ExportedAuditRecord;
    try {
      record = JSON.parse(line) as ExportedAuditRecord;
    } catch {
      return failure(index, expectedSeq, `invalid JSON at sequence ${expectedSeq}`);
    }

    if (record.seq !== expectedSeq) {
      return failure(index, expectedSeq, `expected sequence ${expectedSeq}, found ${record.seq}`);
    }

    if (record.prev_hash !== previousHash) {
      return failure(index, record.seq, `previous hash mismatch at sequence ${record.seq}`);
    }

    const unsigned = {
      seq: record.seq,
      ts: record.ts,
      type: record.type,
      payload: record.payload,
      prev_hash: record.prev_hash
    };
    const expectedHash = chainedHash(previousHash, unsigned);
    if (record.hash !== expectedHash) {
      return failure(index, record.seq, `record hash mismatch at sequence ${record.seq}`);
    }

    previousHash = record.hash;
  }

  return {
    valid: true,
    records: lines.length,
    brokenSeq: null,
    reason: "ledger integrity verified"
  };
}
