import { resolve } from "node:path";

import {
  Client,
  InMemoryTransport,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { IntentProofGateway } from "../src/gateway/gateway.js";
import { createGatewayMcpServer } from "../src/gateway/mcp-server.js";
import { BudgetedExecutor } from "../src/executor/budgeted-executor.js";
import { McpMutationDispatcher } from "../src/executor/mcp-dispatcher.js";
import type { ToolExecutor } from "../src/executor/types.js";
import { AuditStore } from "../src/ledger/audit-store.js";
import { loadMandate } from "../src/mandate/load.js";
import type { PolicyContext } from "../src/policy/types.js";
import {
  assertTestModeKeyId,
  dockerArguments
} from "../src/upstream/razorpay-mcp.js";
import type { UpstreamClient } from "../src/upstream/types.js";

interface RecordedCall {
  name: string;
  arguments: Record<string, unknown>;
}

class FakeUpstream implements UpstreamClient {
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly result: CallToolResult = {
      content: [{ type: "text", text: "upstream-ok" }],
      structuredContent: { id: "order_TEST001" }
    }
  ) {}

  async listTools(): Promise<Tool[]> {
    return [];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ name, arguments: structuredClone(arguments_) });
    return structuredClone(this.result);
  }

  async close(): Promise<void> {}
}

const mandate = loadMandate(resolve("mandates/default.yaml"));
const baseContext: PolicyContext = {
  now: new Date("2026-09-02T10:00:00.000Z"),
  killSwitch: false,
  expectedMandateVersion: mandate.version,
  rollingCalls: 0,
  rollingValuePaise: 0
};

async function connectGateway(
  upstream: FakeUpstream,
  sensitiveValues: readonly string[] = [],
  executor?: ToolExecutor
) {
  const gateway = new IntentProofGateway({
    mandate,
    upstream,
    sensitiveValues,
    ...(executor ? { executor } : {}),
    policyContext: (call) => ({
      ...baseContext,
      ...(call.tool === "capture_payment" && call.arguments.amount === 250_000
        ? { deliveryConfirmed: true }
        : {})
    })
  });
  const server = createGatewayMcpServer(gateway);
  const client = new Client({ name: "intentproof-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

describe("narrow IntentProof MCP gateway", () => {
  it("exposes exactly three tools and passes an allowed order through unchanged", async () => {
    const upstream = new FakeUpstream();
    const connection = await connectGateway(upstream);
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "capture_payment",
        "create_order",
        "create_payment_link"
      ]);

      const result = await connection.client.callTool({
        name: "create_order",
        arguments: { amount: 19_900, currency: "INR", receipt: "receipt-001" }
      });
      expect(result.isError).not.toBe(true);
      expect(upstream.calls).toEqual([
        {
          name: "create_order",
          arguments: { amount: 19_900, currency: "INR", receipt: "receipt-001" }
        }
      ]);
    } finally {
      await connection.close();
    }
  });

  it("never dispatches BLOCK, HOLD_FOR_APPROVAL, or ABSTAIN decisions", async () => {
    const upstream = new FakeUpstream();
    const connection = await connectGateway(upstream);
    try {
      const blocked = await connection.client.callTool({
        name: "create_order",
        arguments: { amount: 300_001, currency: "INR" }
      });
      const held = await connection.client.callTool({
        name: "capture_payment",
        arguments: { payment_id: "pay_TEST123", amount: 250_000, currency: "INR" }
      });
      const abstained = await connection.client.callTool({
        name: "capture_payment",
        arguments: { payment_id: "pay_TEST123", amount: 100_000, currency: "INR" }
      });

      expect(blocked.structuredContent).toMatchObject({ verdict: "BLOCK", rule_id: "C2" });
      expect(held.structuredContent).toMatchObject({
        verdict: "HOLD_FOR_APPROVAL",
        rule_id: "C4"
      });
      expect(abstained.structuredContent).toMatchObject({ verdict: "ABSTAIN", rule_id: "C3" });
      expect(upstream.calls).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("rejects unsupported and schema-invalid calls before upstream dispatch", async () => {
    const upstream = new FakeUpstream();
    const connection = await connectGateway(upstream);
    try {
      await expect(
        connection.client.callTool({ name: "create_refund", arguments: { amount: 100 } })
      ).rejects.toThrow();
      const invalid = await connection.client.callTool({
        name: "create_order",
        arguments: { amount: 19_900, currency: "USD" }
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining("Input validation") })
        ])
      );
      expect(upstream.calls).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("preserves upstream tool errors while recursively redacting credentials", async () => {
    const upstream = new FakeUpstream({
      content: [
        {
          type: "text",
          text: "HTTP 401 key_secret=super-secret authorization: Bearer bearer-secret rzp_test_leak"
        }
      ],
      structuredContent: {
        message: "request failed for rzp_test_leak",
        nested: { token: "bearer-secret" }
      },
      isError: true
    });
    const connection = await connectGateway(upstream, ["super-secret", "bearer-secret"]);
    try {
      const result = await connection.client.callTool({
        name: "create_order",
        arguments: { amount: 19_900, currency: "INR" }
      });
      const serialized = JSON.stringify(result);
      expect(result.isError).toBe(true);
      expect(serialized).toContain("HTTP 401");
      expect(serialized).not.toContain("super-secret");
      expect(serialized).not.toContain("bearer-secret");
      expect(serialized).not.toContain("rzp_test_leak");
      expect(serialized).toContain("[REDACTED]");
    } finally {
      await connection.close();
    }
  });

  it("passes Docker credentials only through the environment and rejects live key IDs", () => {
    const arguments_ = dockerArguments("razorpay/mcp:test");
    expect(arguments_).toEqual([
      "run",
      "--rm",
      "-i",
      "-e",
      "RAZORPAY_KEY_ID",
      "-e",
      "RAZORPAY_KEY_SECRET",
      "razorpay/mcp:test"
    ]);
    expect(() => assertTestModeKeyId("rzp_live_example")).toThrow("Test Mode");
    expect(() => assertTestModeKeyId("rzp_test_example")).not.toThrow();
  });

  it("routes gateway retries through the transactional executor only once", async () => {
    const upstream = new FakeUpstream();
    const store = new AuditStore(":memory:");
    store.initializeRuntimeControls(mandate.version);
    const executor = new BudgetedExecutor({
      store,
      dispatcher: new McpMutationDispatcher(upstream),
      mandateId: mandate.mandate_id,
      mandateVersion: mandate.version,
      agentId: "gateway-test-agent",
      maxTotalPaise: 1_000_000,
      maxCalls: 10,
      clock: () => baseContext.now
    });
    const connection = await connectGateway(upstream, [], executor);
    try {
      const request = {
        name: "create_order",
        arguments: {
          amount: 19_900,
          currency: "INR",
          idempotency_key: "gateway-retry-001"
        }
      };
      const first = await connection.client.callTool(request);
      const retry = await connection.client.callTool(request);

      expect(first.isError).not.toBe(true);
      expect(retry.structuredContent).toMatchObject({
        status: "COMMITTED",
        replayed: true,
        idempotency_key: "gateway-retry-001"
      });
      expect(upstream.calls).toEqual([
        {
          name: "create_order",
          arguments: {
            amount: 19_900,
            currency: "INR",
            receipt: expect.stringMatching(/^ip_[a-f0-9]{32}$/u)
          }
        }
      ]);
    } finally {
      await connection.close();
      store.close();
    }
  });
});
