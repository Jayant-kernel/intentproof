import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditStore } from "../src/ledger/audit-store.js";
import { exportLedger } from "../src/ledger/exporter.js";
import { verifyLedger } from "../src/ledger/verify.js";

const stores: AuditStore[] = [];

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

describe("audit ledger export", () => {
  it("exports committed rows and verifies the complete chain", () => {
    const directory = mkdtempSync(join(tmpdir(), "intentproof-ledger-"));
    const store = new AuditStore(join(directory, "audit.db"));
    stores.push(store);

    store.append("TOOL_BLOCKED", { tool: "capture_payment", rule_id: "C3" });
    store.append("TOOL_ALLOWED", { tool: "create_order", amount_paise: 19_900 });

    const ledgerPath = join(directory, "ledger.jsonl");
    const records = exportLedger(store.list(), ledgerPath);
    expect(records).toHaveLength(2);
    expect(verifyLedger(ledgerPath)).toEqual({
      valid: true,
      records: 2,
      brokenSeq: null,
      reason: "ledger integrity verified"
    });
  });

  it("localizes a hand-edited record", () => {
    const directory = mkdtempSync(join(tmpdir(), "intentproof-ledger-"));
    const store = new AuditStore(join(directory, "audit.db"));
    stores.push(store);

    store.append("TOOL_BLOCKED", { amount_paise: 300_001 });
    store.append("TOOL_ALLOWED", { amount_paise: 19_900 });

    const ledgerPath = join(directory, "ledger.jsonl");
    exportLedger(store.list(), ledgerPath);

    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    const second = JSON.parse(lines[1]!) as {
      payload: { amount_paise: number };
    };
    second.payload.amount_paise = 1;
    lines[1] = JSON.stringify(second);
    writeFileSync(ledgerPath, `${lines.join("\n")}\n`, "utf8");

    const result = verifyLedger(ledgerPath);
    expect(result.valid).toBe(false);
    expect(result.brokenSeq).toBe(2);
    expect(result.reason).toContain("record hash mismatch");
  });

  it("re-exports from SQLite without duplicating rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "intentproof-ledger-"));
    const store = new AuditStore(join(directory, "audit.db"));
    stores.push(store);

    store.append("WEBHOOK_APPLIED", { event_id: "evt_1" });
    const ledgerPath = join(directory, "ledger.jsonl");
    exportLedger(store.list(), ledgerPath);
    exportLedger(store.list(), ledgerPath);

    expect(readFileSync(ledgerPath, "utf8").trim().split("\n")).toHaveLength(1);
    expect(verifyLedger(ledgerPath).valid).toBe(true);
  });
});
