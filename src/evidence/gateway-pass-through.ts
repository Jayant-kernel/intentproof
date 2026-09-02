import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { IntentProofGateway } from "../gateway/gateway.js";
import { createGatewayMcpServer } from "../gateway/mcp-server.js";
import { AuditStore } from "../ledger/audit-store.js";
import type { Mandate } from "../mandate/schema.js";
import type { UpstreamClient } from "../upstream/types.js";

type ExpectedDeniedVerdict = "BLOCK" | "HOLD_FOR_APPROVAL" | "ABSTAIN";

export interface DeniedProbeEvidence {
  expected_verdict: ExpectedDeniedVerdict;
  observed_verdict: string | null;
  upstream_tool_calls: number;
}

export interface GatewayPassThroughEvidence {
  observed_at: string;
  status: "complete" | "failed";
  mode: "Razorpay Test Mode";
  upstream_image: string;
  policy_clock: {
    kind: "injected";
    instant: string;
    timezone: "Asia/Kolkata";
  };
  allowed_order: {
    tool: "create_order";
    amount_paise: 100;
    currency: "INR";
    policy_verdict: "ALLOW" | "UNKNOWN";
    upstream_tool_calls: number;
    succeeded: boolean;
    response_saved: false;
  };
  denied_calls: DeniedProbeEvidence[];
  total_upstream_tool_calls: number;
  credentials_saved: false;
  payment_data_saved: false;
}

class CountingUpstream implements UpstreamClient {
  toolCalls = 0;

  constructor(private readonly upstream: UpstreamClient) {}

  listTools(): ReturnType<UpstreamClient["listTools"]> {
    return this.upstream.listTools();
  }

  callTool(
    name: string,
    arguments_: Record<string, unknown>
  ): ReturnType<UpstreamClient["callTool"]> {
    this.toolCalls += 1;
    return this.upstream.callTool(name, arguments_);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function verdictOf(result: { structuredContent?: unknown }): string | null {
  const content = result.structuredContent;
  if (content !== null && typeof content === "object" && "verdict" in content) {
    const verdict = (content as { verdict?: unknown }).verdict;
    return typeof verdict === "string" ? verdict : null;
  }
  return null;
}

export async function runGatewayPassThroughProbe(options: {
  upstream: UpstreamClient;
  mandate: Mandate;
  policyNow: Date;
  upstreamImage: string;
  sensitiveValues?: readonly string[];
}): Promise<GatewayPassThroughEvidence> {
  const counted = new CountingUpstream(options.upstream);
  const auditStore = new AuditStore(":memory:");
  const gateway = new IntentProofGateway({
    mandate: options.mandate,
    upstream: counted,
    auditStore,
    sensitiveValues: options.sensitiveValues,
    policyContext: (call) => ({
      now: options.policyNow,
      killSwitch: false,
      expectedMandateVersion: options.mandate.version,
      rollingCalls: 0,
      rollingValuePaise: 0,
      ...(call.tool === "capture_payment" && call.arguments.amount === 250_000
        ? { deliveryConfirmed: true }
        : {})
    })
  });
  const server = createGatewayMcpServer(gateway);
  const client = new Client({ name: "intentproof-gateway-probe", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const beforeAllowed = counted.toolCalls;
    const allowedResult = await client.callTool({
      name: "create_order",
      arguments: { amount: 100, currency: "INR" }
    });
    const allowedCalls = counted.toolCalls - beforeAllowed;

    const deniedCases: Array<{
      expected: ExpectedDeniedVerdict;
      name: "create_order" | "capture_payment";
      arguments: Record<string, unknown>;
    }> = [
      {
        expected: "BLOCK",
        name: "create_order",
        arguments: { amount: 300_001, currency: "INR" }
      },
      {
        expected: "HOLD_FOR_APPROVAL",
        name: "capture_payment",
        arguments: { payment_id: "pay_INTENTPROOFTEST", amount: 250_000, currency: "INR" }
      },
      {
        expected: "ABSTAIN",
        name: "capture_payment",
        arguments: { payment_id: "pay_INTENTPROOFTEST", amount: 100_000, currency: "INR" }
      }
    ];

    const deniedCalls: DeniedProbeEvidence[] = [];
    for (const deniedCase of deniedCases) {
      const before = counted.toolCalls;
      const result = await client.callTool({
        name: deniedCase.name,
        arguments: deniedCase.arguments
      });
      deniedCalls.push({
        expected_verdict: deniedCase.expected,
        observed_verdict: verdictOf(result),
        upstream_tool_calls: counted.toolCalls - before
      });
    }

    const allowedByPolicy = auditStore.countByType("TOOL_ALLOWED") === 1;
    const allowedSucceeded = allowedResult.isError !== true;
    const deniedSucceeded = deniedCalls.every(
      (item) =>
        item.observed_verdict === item.expected_verdict && item.upstream_tool_calls === 0
    );
    const complete =
      allowedByPolicy &&
      allowedSucceeded &&
      allowedCalls === 1 &&
      deniedSucceeded &&
      counted.toolCalls === 1;

    return {
      observed_at: new Date().toISOString(),
      status: complete ? "complete" : "failed",
      mode: "Razorpay Test Mode",
      upstream_image: options.upstreamImage,
      policy_clock: {
        kind: "injected",
        instant: options.policyNow.toISOString(),
        timezone: "Asia/Kolkata"
      },
      allowed_order: {
        tool: "create_order",
        amount_paise: 100,
        currency: "INR",
        policy_verdict: allowedByPolicy ? "ALLOW" : "UNKNOWN",
        upstream_tool_calls: allowedCalls,
        succeeded: allowedSucceeded,
        response_saved: false
      },
      denied_calls: deniedCalls,
      total_upstream_tool_calls: counted.toolCalls,
      credentials_saved: false,
      payment_data_saved: false
    };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    auditStore.close();
  }
}
