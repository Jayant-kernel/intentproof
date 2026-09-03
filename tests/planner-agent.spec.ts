import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ModelPlannerAgent } from "../src/agent/model-planner-agent.js";
import { runPlannerDemo } from "../src/agent/planner-demo.js";
import { loadMandate } from "../src/mandate/load.js";
import { DeterministicFakePlanner, StaticFakePlanner } from "../src/planner/fake-planner.js";

const mandate = loadMandate(resolve("mandates/default.yaml"));

function response(value: unknown): string {
  return JSON.stringify(value);
}

describe("planner agent gateway boundary", () => {
  it("sends a valid proposal through the gateway with a derived idempotency key", async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const agent = new ModelPlannerAgent(
      new StaticFakePlanner(response({
        tool: "create_order",
        arguments: { amount: 19_900, currency: "INR" },
        intent_id: "int_agent_order",
        explanation: "Propose the order for deterministic review."
      })),
      { callTool }
    );

    const result = await agent.pursue("Place an order for 19900 paise.");

    expect(result.status).toBe("GATEWAY_RESULT");
    expect(callTool).toHaveBeenCalledWith("create_order", {
      amount: 19_900,
      currency: "INR",
      idempotency_key: "planner:int_agent_order"
    });
  });

  it("never calls the gateway for invalid model output", async () => {
    const callTool = vi.fn();
    const agent = new ModelPlannerAgent(
      new StaticFakePlanner(response({
        tool: "create_refund",
        arguments: { amount: 100, currency: "INR" },
        intent_id: "int_bad_refund",
        explanation: "Try a refund."
      })),
      { callTool }
    );

    await expect(agent.pursue("Issue a refund.")).resolves.toMatchObject({
      status: "PLANNER_REJECTED",
      error_code: "SCHEMA_INVALID"
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not call the gateway for no_action", async () => {
    const callTool = vi.fn();
    const agent = new ModelPlannerAgent(new DeterministicFakePlanner(), { callTool });

    await expect(agent.pursue("Explain yesterday's weather.")).resolves.toMatchObject({
      status: "NO_ACTION",
      proposal: { tool: "no_action" }
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not expose model-supplied payment arguments in its result", async () => {
    const paymentId = "pay_syntheticprivate";
    const agent = new ModelPlannerAgent(
      new StaticFakePlanner(response({
        tool: "capture_payment",
        arguments: { payment_id: paymentId, amount: 100_000, currency: "INR" },
        intent_id: "int_private_capture",
        explanation: "Propose capture for deterministic review."
      })),
      { callTool: async () => ({ verdict: "ABSTAIN" }) }
    );

    const result = await agent.pursue("Capture the synthetic authorized payment.");

    expect(JSON.stringify(result)).not.toContain(paymentId);
  });

  it("keeps planner modules free of upstream, dispatcher, MCP, and credential dependencies", () => {
    const files = [
      "src/planner/schema.ts",
      "src/planner/planner.ts",
      "src/planner/fake-planner.ts",
      "src/planner/gemini-planner.ts",
      "src/agent/model-planner-agent.ts",
      "src/cli/planner-smoke.ts"
    ];
    const source = files.map((file) => readFileSync(resolve(file), "utf8")).join("\n");

    expect(source).not.toMatch(/(?:UpstreamClient|ToolExecutor|McpMutationDispatcher|@modelcontextprotocol)/u);
    expect(source).not.toMatch(/from ["'][^"']*(?:upstream|executor|mcp-dispatcher|credentials)[^"']*["']/u);
  });

  it("keeps the planning-only smoke import graph away from every execution boundary", () => {
    const files = [
      "src/cli/planner-smoke.ts",
      "src/planner/gemini-planner.ts",
      "src/planner/planner.ts",
      "src/planner/schema.ts",
      "src/llm/redaction.ts",
      "src/ledger/canonical.ts"
    ];
    const source = files.map((file) => readFileSync(resolve(file), "utf8")).join("\n");

    expect(source).not.toMatch(/@modelcontextprotocol/u);
    expect(source).not.toMatch(/from ["'][^"']*(?:gateway|upstream|executor|mcp|razorpay|credentials)[^"']*["']/u);
  });

  it("runs every planner demo case deterministically", async () => {
    const first = await runPlannerDemo(mandate);
    const second = await runPlannerDemo(mandate);

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/pay_[A-Za-z0-9]+/u);
    expect(first.map((entry) => [entry.scenario, entry.verdict])).toEqual([
      ["valid_allowed_order", "ALLOW"],
      ["over_budget_proposal", "BLOCK"],
      ["unsupported_tool", "PLANNER_REJECTED"],
      ["prompt_injection_direct_razorpay", "PLANNER_REJECTED"],
      ["capture_without_delivery_evidence", "ABSTAIN"],
      ["approval_required_capture", "HOLD_FOR_APPROVAL"],
      ["malformed_model_output", "PLANNER_REJECTED"],
      ["planner_timeout", "PLANNER_REJECTED"],
      ["stale_mandate_version", "BLOCK"],
      ["kill_switch", "BLOCK"]
    ]);
  });

  it("makes zero upstream calls for every non-ALLOW planner demo outcome", async () => {
    const transcript = await runPlannerDemo(mandate);

    for (const entry of transcript.filter((candidate) => candidate.verdict !== "ALLOW")) {
      expect(entry.upstream_call_count).toBe(0);
    }
    expect(transcript.find((entry) => entry.verdict === "ALLOW")).toMatchObject({
      scenario: "valid_allowed_order",
      gateway_call_count: 1,
      upstream_call_count: 1
    });
    expect(
      transcript.filter((entry) => entry.verdict === "PLANNER_REJECTED")
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateway_call_count: 0, upstream_call_count: 0 })
      ])
    );
  });
});
