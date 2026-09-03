import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { BudgetedExecutor, prepareMutation } from "../src/executor/budgeted-executor.js";
import type { MutationDispatcher } from "../src/executor/types.js";
import { AuditStore } from "../src/ledger/audit-store.js";
import { DispatchReconciler } from "../src/reconciliation/reconciler.js";
import type {
  ReconciliationCapabilities,
  ReconciliationReadClient,
  ReconciliationReadTool
} from "../src/reconciliation/types.js";
import { inspectReconciliationCapabilities } from "../src/reconciliation/types.js";

const stores: AuditStore[] = [];
const baseTime = new Date("2026-09-03T05:00:00.000Z");
const capabilities: ReconciliationCapabilities = {
  orderReceiptFilter: true,
  paymentLinkReferenceFilter: true,
  fetchPayment: true
};

function result(value: unknown): CallToolResult {
  return { content: [], structuredContent: value as Record<string, unknown> };
}

class FakeReadClient implements ReconciliationReadClient {
  readonly calls: Array<{ name: ReconciliationReadTool; arguments: Record<string, unknown> }> = [];

  constructor(private readonly results: Array<CallToolResult | Error>) {}

  async callReadTool(name: ReconciliationReadTool, arguments_: Record<string, unknown>) {
    this.calls.push({ name, arguments: structuredClone(arguments_) });
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    return next ?? result({ count: 0, items: [] });
  }
}

function setupStore(): AuditStore {
  const store = new AuditStore(":memory:");
  stores.push(store);
  store.initializeRuntimeControls(1);
  return store;
}

function reserve(store: AuditStore, input: {
  key: string;
  tool?: "create_order" | "create_payment_link" | "capture_payment";
  arguments?: Record<string, unknown>;
  amount?: number;
  now?: Date;
}) {
  const tool = input.tool ?? "create_order";
  const amount = input.amount ?? 20_000;
  const arguments_ = input.arguments ?? { amount, currency: "INR" };
  const now = input.now ?? baseTime;
  const prepared = prepareMutation(tool, arguments_, amount, input.key);
  const reserved = store.reserveDispatch({
    idempotencyKey: input.key,
    tool,
    amountPaise: amount,
    mandateId: "mnd_test",
    mandateVersion: 1,
    agentId: "agent_test",
    now: now.toISOString(),
    windowStart: new Date(now.getTime() - 86_400_000).toISOString(),
    maxTotalPaise: 1_000_000,
    maxCalls: 100,
    requestFingerprint: prepared.requestFingerprint,
    correlationType: prepared.correlationType,
    correlationValue: prepared.correlationValue
  });
  if (reserved.status !== "reserved") throw new Error(`reserve failed: ${reserved.status}`);
  return { dispatch: reserved.dispatch, prepared };
}

function makeInDoubt(store: AuditStore, input: Parameters<typeof reserve>[1]) {
  const reserved = reserve(store, input);
  store.claimDispatch(input.key, 1, (input.now ?? baseTime).toISOString());
  store.settleDispatch(input.key, "IN_DOUBT", "test_uncertainty", (input.now ?? baseTime).toISOString());
  return store.getDispatch(input.key)!;
}

function reconciler(
  store: AuditStore,
  readClient: FakeReadClient,
  options: {
    clock?: () => Date;
    owner?: string;
    capabilities?: ReconciliationCapabilities;
    delays?: readonly number[];
    sleep?: (milliseconds: number) => Promise<void>;
  } = {}
) {
  return new DispatchReconciler({
    store,
    readClient,
    capabilities: options.capabilities ?? capabilities,
    clock: options.clock ?? (() => baseTime),
    owner: options.owner,
    immediateReadDelaysMs: options.delays ?? [0],
    sleep: options.sleep ?? (() => Promise.resolve()),
    retryDelayMs: 60_000
  });
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("crash-safe reconciliation", () => {
  it("recovers unclaimed work as never sent and claimed work as in doubt, idempotently", async () => {
    const store = setupStore();
    reserve(store, { key: "crash-unclaimed" });
    reserve(store, { key: "crash-claimed" });
    store.claimDispatch("crash-claimed", 1, baseTime.toISOString());

    expect(store.recoverDispatches(baseTime.toISOString(), baseTime.toISOString())).toEqual({
      releasedNeverSent: 1,
      markedInDoubt: 1
    });
    expect(store.recoverDispatches(baseTime.toISOString(), baseTime.toISOString())).toEqual({
      releasedNeverSent: 0,
      markedInDoubt: 0
    });
    expect(store.getDispatch("crash-unclaimed")?.state).toBe("RELEASED");
    expect(store.getDispatch("crash-unclaimed")?.upstreamStatus).toBe("never_sent_recovery");
    expect(store.getDispatch("crash-claimed")?.state).toBe("IN_DOUBT");

    const reads = new FakeReadClient([result({ count: 0, items: [] })]);
    await reconciler(store, reads).reconcile("crash-claimed");
    expect(store.getDispatch("crash-claimed")?.state).toBe("IN_DOUBT");
  });

  it("commits a claimed order after recovery only when one exact receipt match exists", async () => {
    const store = setupStore();
    const { dispatch } = reserve(store, { key: "order-crash" });
    store.claimDispatch("order-crash", 1, baseTime.toISOString());
    store.recoverDispatches(baseTime.toISOString(), baseTime.toISOString());
    const reads = new FakeReadClient([
      result({
        count: 1,
        items: [
          {
            id: "order_RECOVERED1",
            receipt: dispatch.correlationValue,
            amount: 20_000,
            currency: "INR"
          }
        ]
      })
    ]);

    const reconciled = await reconciler(store, reads).reconcile("order-crash");
    expect(reconciled).toMatchObject({ status: "COMMITTED", disposition: "settled", reads: 1 });
    expect(reads.calls).toEqual([
      {
        name: "fetch_all_orders",
        arguments: { receipt: dispatch.correlationValue, count: 100 }
      }
    ]);
    expect(store.countByType("BUDGET_COMMITTED")).toBe(1);
  });

  it("commits a later unique order match after an earlier timeout without another mutation", async () => {
    const store = setupStore();
    const dispatch = makeInDoubt(store, { key: "order-later" });
    let current = new Date(baseTime);
    const firstReads = new FakeReadClient([new Error("timeout")]);
    await reconciler(store, firstReads, { clock: () => current }).reconcile("order-later");
    expect(store.getDispatch("order-later")?.state).toBe("IN_DOUBT");

    current = new Date(baseTime.getTime() + 60_001);
    const laterReads = new FakeReadClient([
      result({
        count: 1,
        items: [
          {
            id: "order_LATER1",
            receipt: dispatch.correlationValue,
            amount: 20_000,
            currency: "INR"
          }
        ]
      })
    ]);
    await reconciler(store, laterReads, { clock: () => current }).reconcile("order-later");
    expect(store.getDispatch("order-later")?.state).toBe("COMMITTED");
    expect(firstReads.calls).toHaveLength(1);
    expect(laterReads.calls).toHaveLength(1);
  });

  it.each([
    ["zero", { count: 0, items: [] }],
    [
      "multiple",
      {
        count: 2,
        items: [
          { id: "order_A1", receipt: "caller-receipt", amount: 20_000, currency: "INR" },
          { id: "order_A2", receipt: "caller-receipt", amount: 20_000, currency: "INR" }
        ]
      }
    ],
    [
      "mismatched",
      {
        count: 1,
        items: [
          { id: "order_A1", receipt: "caller-receipt", amount: 20_001, currency: "INR" }
        ]
      }
    ]
  ])("keeps %s order results in doubt", async (_name, body) => {
    const store = setupStore();
    makeInDoubt(store, {
      key: `order-${_name}`,
      arguments: { amount: 20_000, currency: "INR", receipt: "caller-receipt" }
    });
    await reconciler(store, new FakeReadClient([result(body)])).reconcile(`order-${_name}`);
    expect(store.getDispatch(`order-${_name}`)?.state).toBe("IN_DOUBT");
  });

  it("keeps payment links in doubt when the filter is unavailable or results are ambiguous", async () => {
    const store = setupStore();
    makeInDoubt(store, {
      key: "link-no-filter",
      tool: "create_payment_link",
      arguments: { amount: 20_000, currency: "INR" }
    });
    const noFilterReads = new FakeReadClient([]);
    await reconciler(store, noFilterReads, {
      capabilities: { ...capabilities, paymentLinkReferenceFilter: false }
    }).reconcile("link-no-filter");
    expect(noFilterReads.calls).toHaveLength(0);
    expect(store.getDispatch("link-no-filter")?.state).toBe("IN_DOUBT");

    makeInDoubt(store, {
      key: "link-ambiguous",
      tool: "create_payment_link",
      arguments: { amount: 20_000, currency: "INR" }
    });
    await reconciler(
      store,
      new FakeReadClient([result({ payment_links: [], count: 2 })])
    ).reconcile("link-ambiguous");
    expect(store.getDispatch("link-ambiguous")?.state).toBe("IN_DOUBT");
  });

  it("commits one exact payment-link reference match", async () => {
    const store = setupStore();
    const dispatch = makeInDoubt(store, {
      key: "link-exact",
      tool: "create_payment_link",
      arguments: { amount: 20_000, currency: "INR", reference_id: "link-reference" }
    });
    const reads = new FakeReadClient([
      result({
        count: 1,
        payment_links: [
          {
            id: "plink_EXACT1",
            reference_id: dispatch.correlationValue,
            amount: 20_000,
            currency: "INR"
          }
        ]
      })
    ]);

    await reconciler(store, reads).reconcile("link-exact");
    expect(store.getDispatch("link-exact")?.state).toBe("COMMITTED");
    expect(reads.calls[0]).toEqual({
      name: "fetch_all_payment_links",
      arguments: { reference_id: "link-reference" }
    });
  });

  it.each([
    ["captured", "COMMITTED"],
    ["refunded", "COMMITTED"],
    ["failed", "RELEASED"],
    ["authorized", "IN_DOUBT"],
    ["created", "IN_DOUBT"]
  ] as const)("settles fetched capture status %s as %s", async (paymentStatus, expected) => {
    const store = setupStore();
    makeInDoubt(store, {
      key: `capture-${paymentStatus}`,
      tool: "capture_payment",
      arguments: { payment_id: `pay_${paymentStatus}TEST`, amount: 20_000, currency: "INR" }
    });
    await reconciler(
      store,
      new FakeReadClient([result({ id: `pay_${paymentStatus}TEST`, status: paymentStatus })])
    ).reconcile(`capture-${paymentStatus}`);
    expect(store.getDispatch(`capture-${paymentStatus}`)?.state).toBe(expected);
  });

  it("keeps capture 404 and malformed JSON in doubt", async () => {
    const store = setupStore();
    for (const key of ["capture-404", "capture-malformed"]) {
      makeInDoubt(store, {
        key,
        tool: "capture_payment",
        arguments: { payment_id: `pay_${key.replace("-", "")}X`, amount: 20_000, currency: "INR" }
      });
    }
    await reconciler(
      store,
      new FakeReadClient([{ content: [{ type: "text", text: "HTTP 404 not found" }], isError: true }])
    ).reconcile("capture-404");
    await reconciler(
      store,
      new FakeReadClient([{ content: [{ type: "text", text: "{not-json" }] }])
    ).reconcile("capture-malformed");
    expect(store.getDispatch("capture-404")?.state).toBe("IN_DOUBT");
    expect(store.getDispatch("capture-malformed")?.state).toBe("IN_DOUBT");
  });

  it("allows one lease owner and lets an expired lease be reclaimed for a fresh read", async () => {
    const store = setupStore();
    makeInDoubt(store, {
      key: "lease-race",
      tool: "capture_payment",
      arguments: { payment_id: "pay_LEASERACE", amount: 20_000, currency: "INR" }
    });
    let releaseSleep!: () => void;
    const blockedSleep = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const firstReads = new FakeReadClient([result({ id: "pay_LEASERACE", status: "captured" })]);
    const first = reconciler(store, firstReads, {
      owner: "worker-one",
      sleep: () => blockedSleep
    }).reconcile("lease-race");
    await Promise.resolve();
    const second = await reconciler(store, new FakeReadClient([]), {
      owner: "worker-two"
    }).reconcile("lease-race");
    expect(second).toMatchObject({ disposition: "lease_held", reads: 0 });
    releaseSleep();
    await first;
    expect(store.getDispatch("lease-race")?.state).toBe("COMMITTED");
    expect(store.countByType("RECONCILIATION_SETTLED")).toBe(1);

    makeInDoubt(store, {
      key: "lease-expired",
      tool: "capture_payment",
      arguments: { payment_id: "pay_LEASEEXPIRED", amount: 20_000, currency: "INR" }
    });
    store.acquireReconcileLease({
      idempotencyKey: "lease-expired",
      owner: "dead-worker",
      now: baseTime.toISOString(),
      leaseUntil: new Date(baseTime.getTime() + 1_000).toISOString()
    });
    const later = new Date(baseTime.getTime() + 2_000);
    const reclaimedReads = new FakeReadClient([
      result({ id: "pay_LEASEEXPIRED", status: "captured" })
    ]);
    await reconciler(store, reclaimedReads, {
      owner: "replacement-worker",
      clock: () => later
    }).reconcile("lease-expired");
    expect(reclaimedReads.calls).toHaveLength(1);
    expect(store.getDispatch("lease-expired")?.reconcileAttempts).toBe(2);
  });

  it("uses injected 250/500/1000 ms waits and escalates old uncertainty without release", async () => {
    const store = setupStore();
    const old = new Date(baseTime.getTime() - 24 * 60 * 60 * 1_000);
    makeInDoubt(store, { key: "old-uncertain", now: old });
    const waits: number[] = [];
    const reads = new FakeReadClient([
      result({ count: 0, items: [] }),
      result({ count: 0, items: [] }),
      result({ count: 0, items: [] })
    ]);
    const worker = new DispatchReconciler({
      store,
      readClient: reads,
      capabilities,
      clock: () => baseTime,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
      owner: "timing-worker",
      retryDelayMs: 60_000
    });
    await worker.reconcile("old-uncertain");

    expect(waits).toEqual([250, 500, 1_000]);
    expect(store.getDispatch("old-uncertain")).toMatchObject({
      state: "IN_DOUBT",
      escalatedAt: baseTime.toISOString()
    });
    expect(store.budgetUsage(new Date(old.getTime() - 1).toISOString())).toEqual({
      calls: 1,
      valuePaise: 20_000
    });
  });

  it("rejects changed idempotency arguments and duplicate caller correlation without dispatch", async () => {
    const store = setupStore();
    let mutationCalls = 0;
    const dispatcher: MutationDispatcher = {
      async dispatch() {
        mutationCalls += 1;
        return { kind: "INDETERMINATE" };
      }
    };
    const executor = new BudgetedExecutor({
      store,
      dispatcher,
      mandateId: "mnd_test",
      mandateVersion: 1,
      agentId: "agent_test",
      maxTotalPaise: 1_000_000,
      maxCalls: 100,
      clock: () => baseTime
    });
    await executor.execute({
      tool: "create_order",
      arguments: { amount: 20_000, currency: "INR", receipt: "same-receipt" },
      amountPaise: 20_000,
      idempotencyKey: "same-key"
    });
    const changed = await executor.execute({
      tool: "create_order",
      arguments: { amount: 20_001, currency: "INR", receipt: "same-receipt" },
      amountPaise: 20_001,
      idempotencyKey: "same-key"
    });
    const duplicateCorrelation = await executor.execute({
      tool: "create_order",
      arguments: { amount: 20_000, currency: "INR", receipt: "same-receipt" },
      amountPaise: 20_000,
      idempotencyKey: "other-key"
    });

    expect(changed).toMatchObject({ status: "BLOCKED", ruleId: "SYSTEM_IDEMPOTENCY_CONFLICT" });
    expect(duplicateCorrelation).toMatchObject({
      status: "BLOCKED",
      ruleId: "SYSTEM_CORRELATION_CONFLICT"
    });
    expect(mutationCalls).toBe(1);
  });

  it("forbids terminal regressions and any reconciliation transition back to reserved", () => {
    const store = setupStore();
    makeInDoubt(store, { key: "forbidden-indoubt" });
    expect(store.settleDispatch("forbidden-indoubt", "RELEASED", "empty_read", baseTime.toISOString()).state).toBe(
      "IN_DOUBT"
    );
    expect(() =>
      store.settleReconciledDispatch({
        idempotencyKey: "forbidden-indoubt",
        owner: "none",
        state: "RESERVED" as "COMMITTED",
        upstreamStatus: "invalid",
        now: baseTime.toISOString()
      })
    ).toThrow("Forbidden reconciliation transition");

    const committed = makeInDoubt(store, { key: "terminal-committed" });
    store.acquireReconcileLease({
      idempotencyKey: committed.idempotencyKey,
      owner: "terminal-worker",
      now: baseTime.toISOString(),
      leaseUntil: new Date(baseTime.getTime() + 10_000).toISOString()
    });
    store.settleReconciledDispatch({
      idempotencyKey: committed.idempotencyKey,
      owner: "terminal-worker",
      state: "COMMITTED",
      upstreamStatus: "confirmed",
      now: baseTime.toISOString()
    });
    expect(store.settleDispatch(committed.idempotencyKey, "RELEASED", "regression", baseTime.toISOString()).state).toBe(
      "COMMITTED"
    );

    reserve(store, { key: "terminal-released" });
    store.claimDispatch("terminal-released", 1, baseTime.toISOString());
    store.settleDispatch("terminal-released", "RELEASED", "definitive", baseTime.toISOString());
    expect(
      store.settleDispatch("terminal-released", "COMMITTED", "regression", baseTime.toISOString())
        .state
    ).toBe("RELEASED");
  });

  it("derives read-filter capabilities only from observed MCP input schemas", () => {
    const observed = inspectReconciliationCapabilities([
      {
        name: "fetch_all_orders",
        inputSchema: { type: "object", properties: { receipt: { type: "string" } } }
      },
      {
        name: "fetch_all_payment_links",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "fetch_payment",
        inputSchema: { type: "object", properties: { payment_id: { type: "string" } } }
      }
    ]);

    expect(observed).toEqual({
      orderReceiptFilter: true,
      paymentLinkReferenceFilter: false,
      fetchPayment: true
    });
  });

  it("migrates an existing dispatch table and leaves uncorrelated uncertainty fail closed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "intentproof-migration-"));
    const path = join(directory, "old.db");
    const old = new Database(path);
    old.exec(`
      CREATE TABLE dispatches (
        idempotency_key TEXT PRIMARY KEY, tool TEXT NOT NULL, state TEXT NOT NULL,
        amount_paise INTEGER NOT NULL, mandate_id TEXT NOT NULL, mandate_version INTEGER NOT NULL,
        agent_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        dispatch_started_at TEXT, upstream_status TEXT
      );
      INSERT INTO dispatches VALUES (
        'legacy-uncertain', 'create_order', 'IN_DOUBT', 20000, 'mnd', 1, 'agent',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z', 'timeout'
      );
    `);
    old.close();
    const store = new AuditStore(path);
    stores.push(store);
    const reads = new FakeReadClient([]);

    await reconciler(store, reads).reconcile("legacy-uncertain");
    expect(store.getDispatch("legacy-uncertain")).toMatchObject({
      state: "IN_DOUBT",
      correlationType: null,
      correlationValue: null,
      escalatedAt: baseTime.toISOString()
    });
    expect(reads.calls).toHaveLength(0);
  });
});
