import type { CallToolResult, Tool } from "@modelcontextprotocol/client";

import { IntentProofGateway, type AuditSink } from "../gateway/gateway.js";
import type { GatewayToolName } from "../gateway/schemas.js";
import type { AuditPayload } from "../ledger/types.js";
import type { Mandate } from "../mandate/schema.js";
import type { PolicyContext } from "../policy/types.js";
import type { UpstreamClient } from "../upstream/types.js";

export interface DemoGateway {
  callTool(toolName: string, rawArguments: unknown): Promise<CallToolResult>;
}

export class DemoAgent {
  constructor(private readonly gateway: DemoGateway) {}

  async attempt(tool: GatewayToolName, arguments_: Record<string, unknown>): Promise<CallToolResult> {
    return this.gateway.callTool(tool, arguments_);
  }
}

class DemoAudit implements AuditSink {
  readonly records: Array<{ type: string; payload: AuditPayload }> = [];

  append(type: string, payload: AuditPayload): void {
    this.records.push({ type, payload: structuredClone(payload) });
  }
}

class DemoFakeUpstream implements UpstreamClient {
  readonly calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];

  async listTools(): Promise<Tool[]> {
    return [];
  }

  async callTool(tool: string, arguments_: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ tool, arguments: structuredClone(arguments_) });
    return {
      content: [{ type: "text", text: "synthetic upstream accepted" }],
      structuredContent: { id: `demo_effect_${this.calls.length}` }
    };
  }

  async close(): Promise<void> {}
}

export interface DemoTranscriptEntry {
  scenario: string;
  agent_request: {
    tool: GatewayToolName;
    amount_paise: number;
  };
  mandate: {
    mandate_id: string;
    version: number;
    quote: string | null;
  };
  verdict: "ALLOW" | "BLOCK" | "HOLD_FOR_APPROVAL" | "ABSTAIN";
  upstream_call_count: number;
  audit_evidence: {
    trace_id: string;
    type: string;
    rule_id: string | null;
  };
}

interface DemoCase {
  name: string;
  tool: GatewayToolName;
  arguments: Record<string, unknown>;
  context: Partial<PolicyContext>;
}

const baseContext: PolicyContext = {
  now: new Date("2026-09-02T10:00:00.000Z"),
  killSwitch: false,
  expectedMandateVersion: 1,
  rollingCalls: 0,
  rollingValuePaise: 0
};

const demoCases: DemoCase[] = [
  {
    name: "allowed_purchase",
    tool: "create_order",
    arguments: { amount: 19_900, currency: "INR", idempotency_key: "demo-allowed-001" },
    context: {}
  },
  {
    name: "over_limit_purchase",
    tool: "create_order",
    arguments: { amount: 300_001, currency: "INR", idempotency_key: "demo-over-limit-001" },
    context: {}
  },
  {
    name: "capture_before_delivery",
    tool: "capture_payment",
    arguments: {
      payment_id: "pay_demoauthorized",
      amount: 100_000,
      currency: "INR",
      idempotency_key: "demo-before-delivery-001"
    },
    context: { deliveryConfirmed: false }
  },
  {
    name: "missing_delivery_evidence",
    tool: "capture_payment",
    arguments: {
      payment_id: "pay_demounknown",
      amount: 100_000,
      currency: "INR",
      idempotency_key: "demo-missing-evidence-001"
    },
    context: {}
  },
  {
    name: "approval_required",
    tool: "capture_payment",
    arguments: {
      payment_id: "pay_demolarge",
      amount: 250_000,
      currency: "INR",
      idempotency_key: "demo-approval-001"
    },
    context: { deliveryConfirmed: true }
  },
  {
    name: "kill_switch_rejection",
    tool: "create_order",
    arguments: { amount: 19_900, currency: "INR", idempotency_key: "demo-kill-001" },
    context: { killSwitch: true }
  },
  {
    name: "stale_mandate_version",
    tool: "create_order",
    arguments: { amount: 19_900, currency: "INR", idempotency_key: "demo-stale-001" },
    context: { expectedMandateVersion: 2 }
  }
];

export async function runDeterministicDemo(mandate: Mandate): Promise<DemoTranscriptEntry[]> {
  const upstream = new DemoFakeUpstream();
  const audit = new DemoAudit();
  let traceSequence = 0;
  let activeContext: PolicyContext = baseContext;
  const gateway = new IntentProofGateway({
    mandate,
    upstream,
    auditStore: audit,
    policyContext: () => activeContext,
    traceIdFactory: () => `trc_demo_${String(++traceSequence).padStart(2, "0")}`
  });
  const agent = new DemoAgent(gateway);
  const transcript: DemoTranscriptEntry[] = [];

  for (const demonstration of demoCases) {
    activeContext = { ...baseContext, expectedMandateVersion: mandate.version, ...demonstration.context };
    const callsBefore = upstream.calls.length;
    const auditBefore = audit.records.length;
    await agent.attempt(demonstration.tool, demonstration.arguments);
    const decisionRecord = audit.records
      .slice(auditBefore)
      .find((record) =>
        ["TOOL_ALLOWED", "TOOL_BLOCKED", "TOOL_HELD", "TOOL_ABSTAINED"].includes(record.type)
      );
    if (!decisionRecord) throw new Error(`Demo case ${demonstration.name} produced no decision audit`);
    const verdict = decisionRecord.payload.verdict;
    if (verdict !== "ALLOW" && verdict !== "BLOCK" && verdict !== "HOLD_FOR_APPROVAL" && verdict !== "ABSTAIN") {
      throw new Error(`Demo case ${demonstration.name} produced an invalid verdict`);
    }
    transcript.push({
      scenario: demonstration.name,
      agent_request: {
        tool: demonstration.tool,
        amount_paise: Number(demonstration.arguments.amount)
      },
      mandate: {
        mandate_id: mandate.mandate_id,
        version: mandate.version,
        quote: typeof decisionRecord.payload.quote === "string" ? decisionRecord.payload.quote : null
      },
      verdict,
      upstream_call_count: upstream.calls.length - callsBefore,
      audit_evidence: {
        trace_id: String(decisionRecord.payload.trace_id),
        type: decisionRecord.type,
        rule_id:
          typeof decisionRecord.payload.rule_id === "string" ? decisionRecord.payload.rule_id : null
      }
    });
  }
  return transcript;
}
