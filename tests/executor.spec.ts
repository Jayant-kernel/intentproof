import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { BudgetedExecutor } from "../src/executor/budgeted-executor.js";
import type {
  MutationDispatcher,
  MutationDispatchOutcome
} from "../src/executor/types.js";
import { AuditStore } from "../src/ledger/audit-store.js";

const stores: AuditStore[] = [];
const now = new Date("2026-09-03T04:30:00.000Z");
const okResult: CallToolResult = { content: [{ type: "text", text: "ok" }] };
const rejectedResult: CallToolResult = {
  content: [{ type: "text", text: "HTTP 400 rejected" }],
  isError: true
};

class FakeDispatcher implements MutationDispatcher {
  calls = 0;

  constructor(
    private readonly behavior: () =>
      | MutationDispatchOutcome
      | Promise<MutationDispatchOutcome> = () => ({
      kind: "CONFIRMED_SUCCESS",
      result: okResult
    })
  ) {}

  async dispatch(): Promise<MutationDispatchOutcome> {
    this.calls += 1;
    return this.behavior();
  }
}

function setup(options: {
  dispatcher?: MutationDispatcher;
  maxTotalPaise?: number;
  maxCalls?: number;
  beforeDispatch?: () => void | Promise<void>;
} = {}) {
  const store = new AuditStore(":memory:");
  stores.push(store);
  store.initializeRuntimeControls(1);
  const dispatcher = options.dispatcher ?? new FakeDispatcher();
  const executor = new BudgetedExecutor({
    store,
    dispatcher,
    mandateId: "mnd_test",
    mandateVersion: 1,
    agentId: "agent_test",
    maxTotalPaise: options.maxTotalPaise ?? 1_000_000,
    maxCalls: options.maxCalls ?? 100,
    clock: () => now,
    ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {})
  });
  return { store, dispatcher, executor };
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("transactional budget executor", () => {
  it("reserves before dispatch and commits only a confirmed success", async () => {
    const dispatcher = new FakeDispatcher();
    const { store, executor } = setup({ dispatcher });
    const result = await executor.execute({
      tool: "create_order",
      arguments: { amount: 19_900, currency: "INR" },
      amountPaise: 19_900,
      idempotencyKey: "commit-001"
    });

    expect(result.status).toBe("COMMITTED");
    expect(dispatcher.calls).toBe(1);
    expect(store.getDispatch("commit-001")?.state).toBe("COMMITTED");
    expect(store.countByType("BUDGET_RESERVED")).toBe(1);
    expect(store.countByType("BUDGET_COMMITTED")).toBe(1);
  });

  it("releases a definitive rejection so it no longer consumes capacity", async () => {
    const dispatcher = new FakeDispatcher(() => ({
      kind: "DEFINITIVE_FAILURE",
      result: rejectedResult
    }));
    const { store, executor } = setup({ dispatcher, maxTotalPaise: 20_000 });
    const rejected = await executor.execute({
      tool: "create_order",
      arguments: { amount: 20_000, currency: "INR" },
      amountPaise: 20_000,
      idempotencyKey: "release-001"
    });

    expect(rejected.status).toBe("RELEASED");
    expect(store.budgetUsage("2026-09-02T04:30:00.000Z")).toEqual({ calls: 0, valuePaise: 0 });
    expect(store.countByType("BUDGET_RELEASED")).toBe(1);
  });

  it("keeps a timeout in doubt and blocks capacity from being reused", async () => {
    const timeout = new FakeDispatcher(() => {
      throw new Error("socket timeout");
    });
    const { store, executor } = setup({ dispatcher: timeout, maxTotalPaise: 20_000 });
    const uncertain = await executor.execute({
      tool: "create_order",
      arguments: { amount: 20_000, currency: "INR" },
      amountPaise: 20_000,
      idempotencyKey: "timeout-001"
    });
    const retry = await executor.execute({
      tool: "create_order",
      arguments: { amount: 20_000, currency: "INR" },
      amountPaise: 20_000,
      idempotencyKey: "timeout-001"
    });
    const next = await executor.execute({
      tool: "create_order",
      arguments: { amount: 100, currency: "INR" },
      amountPaise: 100,
      idempotencyKey: "timeout-002"
    });

    expect(uncertain.status).toBe("IN_DOUBT");
    expect(retry).toMatchObject({ status: "IN_DOUBT", replayed: true });
    expect(next).toMatchObject({ status: "BLOCKED", ruleId: "BUDGET_VALUE" });
    expect(timeout.calls).toBe(1);
    expect(store.getDispatch("timeout-001")?.state).toBe("IN_DOUBT");
    expect(store.countByType("BUDGET_IN_DOUBT")).toBe(1);
  });

  it("returns the stored result state on retry without dispatching twice", async () => {
    const dispatcher = new FakeDispatcher();
    const { executor } = setup({ dispatcher });
    const request = {
      tool: "create_order",
      arguments: { amount: 19_900, currency: "INR" },
      amountPaise: 19_900,
      idempotencyKey: "retry-001"
    };
    const first = await executor.execute(request);
    const retry = await executor.execute(request);

    expect(first).toMatchObject({ status: "COMMITTED", replayed: false });
    expect(retry).toMatchObject({ status: "COMMITTED", replayed: true });
    expect(dispatcher.calls).toBe(1);
  });

  it("does not overspend when ten individually valid calls arrive together", async () => {
    const dispatcher = new FakeDispatcher(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      return { kind: "CONFIRMED_SUCCESS", result: okResult };
    });
    const { store, executor } = setup({ dispatcher, maxTotalPaise: 250_000 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        executor.execute({
          tool: "create_order",
          arguments: { amount: 40_000, currency: "INR", receipt: `concurrent-${index}` },
          amountPaise: 40_000,
          idempotencyKey: `concurrent-${index}`
        })
      )
    );

    expect(results.filter((result) => result.status === "COMMITTED")).toHaveLength(6);
    expect(results.filter((result) => result.status === "BLOCKED")).toHaveLength(4);
    expect(dispatcher.calls).toBe(6);
    expect(store.budgetUsage("2026-09-02T04:30:00.000Z")).toEqual({
      calls: 6,
      valuePaise: 240_000
    });
  });

  it("enforces the rolling call count independently of value", async () => {
    const dispatcher = new FakeDispatcher();
    const { executor } = setup({ dispatcher, maxCalls: 2 });
    const results = await Promise.all(
      ["calls-001", "calls-002", "calls-003"].map((idempotencyKey) =>
        executor.execute({
          tool: "create_order",
          arguments: { amount: 100, currency: "INR", receipt: idempotencyKey },
          amountPaise: 100,
          idempotencyKey
        })
      )
    );

    expect(results.filter((result) => result.status === "COMMITTED")).toHaveLength(2);
    expect(results).toContainEqual(
      expect.objectContaining({ status: "BLOCKED", ruleId: "BUDGET_CALLS" })
    );
    expect(dispatcher.calls).toBe(2);
  });

  it("rechecks the kill switch after reservation and before dispatch", async () => {
    let store!: AuditStore;
    const dispatcher = new FakeDispatcher();
    const setupResult = setup({
      dispatcher,
      beforeDispatch: () => store.setKillSwitch(true)
    });
    store = setupResult.store;
    const result = await setupResult.executor.execute({
      tool: "create_order",
      arguments: { amount: 100, currency: "INR" },
      amountPaise: 100,
      idempotencyKey: "kill-001"
    });

    expect(result).toMatchObject({ status: "BLOCKED", ruleId: "SYSTEM_KILL_SWITCH" });
    expect(dispatcher.calls).toBe(0);
    expect(store.getDispatch("kill-001")?.state).toBe("RELEASED");
  });

  it("rechecks the mandate version after reservation and before dispatch", async () => {
    let store!: AuditStore;
    const dispatcher = new FakeDispatcher();
    const setupResult = setup({
      dispatcher,
      beforeDispatch: () => store.setMandateVersion(2)
    });
    store = setupResult.store;
    const result = await setupResult.executor.execute({
      tool: "create_order",
      arguments: { amount: 100, currency: "INR" },
      amountPaise: 100,
      idempotencyKey: "version-001"
    });

    expect(result).toMatchObject({ status: "BLOCKED", ruleId: "SYSTEM_MANDATE_VERSION" });
    expect(dispatcher.calls).toBe(0);
    expect(store.getDispatch("version-001")?.state).toBe("RELEASED");
  });
});
