import { afterEach, describe, expect, it } from "vitest";

import type { DispatchState } from "../src/budget/types.js";
import { prepareMutation } from "../src/executor/budgeted-executor.js";
import { AuditStore } from "../src/ledger/audit-store.js";

const stores: AuditStore[] = [];
const now = new Date("2026-09-03T12:00:00.000Z");
const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
const old = new Date(windowStart.getTime() - 24 * 60 * 60 * 1_000);
const recent = new Date(now.getTime() - 60 * 60 * 1_000);

function setup(): AuditStore {
  const store = new AuditStore(":memory:");
  stores.push(store);
  store.initializeRuntimeControls(1);
  return store;
}

function addDispatch(
  store: AuditStore,
  input: { key: string; amount: number; createdAt: Date; state: DispatchState }
): void {
  const arguments_ = {
    amount: input.amount,
    currency: "INR",
    receipt: `receipt-${input.key}`
  };
  const prepared = prepareMutation("create_order", arguments_, input.amount, input.key);
  const reservation = store.reserveDispatch({
    idempotencyKey: input.key,
    tool: "create_order",
    amountPaise: input.amount,
    mandateId: "mnd_budget_test",
    mandateVersion: 1,
    agentId: "agent_budget_test",
    now: input.createdAt.toISOString(),
    windowStart: new Date(input.createdAt.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
    maxTotalPaise: 10_000_000,
    maxCalls: 1_000,
    requestFingerprint: prepared.requestFingerprint,
    correlationType: prepared.correlationType,
    correlationValue: prepared.correlationValue
  });
  if (reservation.status !== "reserved") {
    throw new Error(`Could not arrange budget test row: ${reservation.status}`);
  }
  if (input.state === "RESERVED") return;

  store.claimDispatch(input.key, 1, input.createdAt.toISOString());
  store.settleDispatch(
    input.key,
    input.state,
    `test_${input.state.toLowerCase()}`,
    input.createdAt.toISOString()
  );
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("budget usage across the rolling window", () => {
  it("keeps an old unresolved IN_DOUBT row charged", () => {
    const store = setup();
    addDispatch(store, { key: "old-indoubt", amount: 11_000, createdAt: old, state: "IN_DOUBT" });

    expect(store.budgetUsage(windowStart.toISOString())).toEqual({
      calls: 1,
      valuePaise: 11_000
    });
  });

  it("does not charge an old COMMITTED row outside the rolling window", () => {
    const store = setup();
    addDispatch(store, { key: "old-committed", amount: 12_000, createdAt: old, state: "COMMITTED" });

    expect(store.budgetUsage(windowStart.toISOString())).toEqual({ calls: 0, valuePaise: 0 });
  });

  it("charges recent RESERVED, COMMITTED, and IN_DOUBT rows", () => {
    const store = setup();
    addDispatch(store, { key: "recent-reserved", amount: 13_000, createdAt: recent, state: "RESERVED" });
    addDispatch(store, { key: "recent-committed", amount: 14_000, createdAt: recent, state: "COMMITTED" });
    addDispatch(store, { key: "recent-indoubt", amount: 15_000, createdAt: recent, state: "IN_DOUBT" });

    expect(store.budgetUsage(windowStart.toISOString())).toEqual({
      calls: 3,
      valuePaise: 42_000
    });
  });

  it("never charges RELEASED rows", () => {
    const store = setup();
    addDispatch(store, { key: "recent-released", amount: 16_000, createdAt: recent, state: "RELEASED" });
    addDispatch(store, { key: "old-released", amount: 17_000, createdAt: old, state: "RELEASED" });

    expect(store.budgetUsage(windowStart.toISOString())).toEqual({ calls: 0, valuePaise: 0 });
  });

  it("counts mixed rows once under the correct age rule", () => {
    const store = setup();
    addDispatch(store, { key: "mix-old-indoubt", amount: 10_000, createdAt: old, state: "IN_DOUBT" });
    addDispatch(store, { key: "mix-old-committed", amount: 20_000, createdAt: old, state: "COMMITTED" });
    addDispatch(store, { key: "mix-recent-reserved", amount: 30_000, createdAt: recent, state: "RESERVED" });
    addDispatch(store, { key: "mix-recent-committed", amount: 40_000, createdAt: recent, state: "COMMITTED" });
    addDispatch(store, { key: "mix-recent-indoubt", amount: 50_000, createdAt: recent, state: "IN_DOUBT" });
    addDispatch(store, { key: "mix-recent-released", amount: 60_000, createdAt: recent, state: "RELEASED" });

    expect(store.budgetUsage(windowStart.toISOString())).toEqual({
      calls: 4,
      valuePaise: 130_000
    });
  });
});
