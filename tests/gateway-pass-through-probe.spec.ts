import { resolve } from "node:path";

import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { runGatewayPassThroughProbe } from "../src/evidence/gateway-pass-through.js";
import { loadMandate } from "../src/mandate/load.js";
import type { UpstreamClient } from "../src/upstream/types.js";

class RecordingUpstream implements UpstreamClient {
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  async listTools(): Promise<Tool[]> {
    return [];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<CallToolResult> {
    this.calls.push({ name, arguments: structuredClone(arguments_) });
    return {
      content: [{ type: "text", text: "fake response containing order_fake_private" }],
      structuredContent: { id: "order_fake_private" }
    };
  }

  async close(): Promise<void> {}
}

describe("one-shot gateway pass-through evidence", () => {
  it("dispatches one minimal order and records zero upstream calls for every denial", async () => {
    const upstream = new RecordingUpstream();
    const evidence = await runGatewayPassThroughProbe({
      upstream,
      mandate: loadMandate(resolve("mandates/default.yaml")),
      policyNow: new Date("2026-09-03T04:30:00.000Z"),
      upstreamImage: "fake-upstream"
    });

    expect(evidence.status).toBe("complete");
    expect(evidence.allowed_order).toMatchObject({
      amount_paise: 100,
      policy_verdict: "ALLOW",
      upstream_tool_calls: 1,
      succeeded: true,
      response_saved: false
    });
    expect(evidence.denied_calls).toEqual([
      { expected_verdict: "BLOCK", observed_verdict: "BLOCK", upstream_tool_calls: 0 },
      {
        expected_verdict: "HOLD_FOR_APPROVAL",
        observed_verdict: "HOLD_FOR_APPROVAL",
        upstream_tool_calls: 0
      },
      { expected_verdict: "ABSTAIN", observed_verdict: "ABSTAIN", upstream_tool_calls: 0 }
    ]);
    expect(evidence.total_upstream_tool_calls).toBe(1);
    expect(upstream.calls).toEqual([
      { name: "create_order", arguments: { amount: 100, currency: "INR" } }
    ]);
    expect(JSON.stringify(evidence)).not.toContain("order_fake_private");
  });
});
