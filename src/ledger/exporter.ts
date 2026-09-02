import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import { dirname, resolve } from "node:path";

import { chainedHash, GENESIS_HASH } from "./canonical.js";
import type { AuditRow, ExportedAuditRecord } from "./types.js";

export function buildExport(rows: AuditRow[]): ExportedAuditRecord[] {
  let previousHash = GENESIS_HASH;

  return rows.map((row) => {
    const unsigned = {
      seq: row.seq,
      ts: row.ts,
      type: row.type,
      payload: row.payload,
      prev_hash: previousHash
    };
    const hash = chainedHash(previousHash, unsigned);
    const record: ExportedAuditRecord = { ...unsigned, hash };
    previousHash = hash;
    return record;
  });
}

export function exportLedger(rows: AuditRow[], outputPath: string): ExportedAuditRecord[] {
  const records = buildExport(rows);
  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });

  const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  const bytes = body.length > 0 ? `${body}\n` : "";

  let handle: number | undefined;
  try {
    handle = openSync(temporaryPath, "w", 0o600);
    writeSync(handle, bytes, undefined, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    renameSync(temporaryPath, absolutePath);
  } finally {
    if (handle !== undefined) {
      closeSync(handle);
    }
    if (existsSync(temporaryPath)) {
      rmSync(temporaryPath);
    }
  }

  return records;
}
