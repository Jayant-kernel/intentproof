import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { McpMutationDispatcher } from "../src/executor/mcp-dispatcher.js";
import { BudgetedExecutor } from "../src/executor/budgeted-executor.js";
import { AuditStore } from "../src/ledger/audit-store.js";
import { McpReconciliationReadClient } from "../src/reconciliation/mcp-read-client.js";
import type { ReconciliationReadTool } from "../src/reconciliation/types.js";
import type { UpstreamClient } from "../src/upstream/types.js";

class ResultUpstream implements UpstreamClient {
  calls = 0;
  constructor(private readonly result: CallToolResult) {}
  async listTools(): Promise<Tool[]> {
    return [];
  }
  async callTool(): Promise<CallToolResult> {
    this.calls += 1;
    return structuredClone(this.result);
  }
  async close(): Promise<void> {}
}

describe("production MCP mutation classification", () => {
  it.each([400, 401, 403, 404, 409, 422])(
    "does not release budget from MCP prose containing %i",
    async (code) => {
      const dispatcher = new McpMutationDispatcher(
        new ResultUpstream({
          content: [{ type: "text", text: `receipt=item-${code}; upstream said HTTP ${code}` }],
          isError: true
        })
      );

      const store = new AuditStore(":memory:");
      store.initializeRuntimeControls(1);
      const executor = new BudgetedExecutor({
        store,
        dispatcher,
        mandateId: "mnd_test",
        mandateVersion: 1,
        agentId: "agent_test",
        maxTotalPaise: 100_000,
        maxCalls: 10,
        clock: () => new Date("2026-09-03T05:00:00.000Z")
      });
      try {
        const execution = await executor.execute({
          tool: "create_order",
          arguments: { amount: 10_000, currency: "INR", receipt: `code-${code}` },
          amountPaise: 10_000,
          idempotencyKey: `status-code-${code}`
        });
        expect(execution.status).toBe("IN_DOUBT");
        expect(store.countByType("BUDGET_RELEASED")).toBe(0);
      } finally {
        store.close();
      }
    }
  );

  it("requires a tool-specific structured success response", async () => {
    const malformed = new McpMutationDispatcher(
      new ResultUpstream({ content: [{ type: "text", text: "order created: order_TEST001" }] })
    );
    const confirmed = new McpMutationDispatcher(
      new ResultUpstream({
        content: [],
        structuredContent: { id: "order_TEST001", entity: "order" }
      })
    );
    const missingId = new McpMutationDispatcher(
      new ResultUpstream({ content: [], structuredContent: { entity: "order" } })
    );

    await expect(malformed.dispatch("create_order", {})).resolves.toMatchObject({
      kind: "INDETERMINATE"
    });
    await expect(confirmed.dispatch("create_order", {})).resolves.toMatchObject({
      kind: "CONFIRMED_SUCCESS",
      upstreamEntityId: "order_TEST001"
    });
    await expect(missingId.dispatch("create_order", {})).resolves.toMatchObject({
      kind: "INDETERMINATE"
    });
  });

  it("gives the reconciler no path to a mutation tool", async () => {
    const upstream = new ResultUpstream({ content: [] });
    const reader = new McpReconciliationReadClient(upstream);

    expect(() => reader.callReadTool("create_order" as ReconciliationReadTool, {})).toThrow(
      "not allowlisted"
    );
    expect(upstream.calls).toBe(0);
  });
});
