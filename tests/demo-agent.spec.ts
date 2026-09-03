import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DemoAgent, runDeterministicDemo } from "../src/agent/demo-agent.js";
import { loadMandate } from "../src/mandate/load.js";

const mandate = loadMandate(resolve("mandates/default.yaml"));

describe("safe demo agent", () => {
  it("runs deterministically through the IntentProof gateway", async () => {
    const first = await runDeterministicDemo(mandate);
    const second = await runDeterministicDemo(mandate);

    expect(second).toEqual(first);
    expect(first.map((entry) => entry.verdict)).toEqual([
      "ALLOW",
      "BLOCK",
      "BLOCK",
      "ABSTAIN",
      "HOLD_FOR_APPROVAL",
      "BLOCK",
      "BLOCK"
    ]);
  });

  it("makes zero upstream calls for blocked, held, and abstained actions", async () => {
    const transcript = await runDeterministicDemo(mandate);

    for (const entry of transcript.filter((candidate) => candidate.verdict !== "ALLOW")) {
      expect(entry.upstream_call_count).toBe(0);
    }
    expect(transcript.filter((entry) => entry.verdict === "ALLOW")).toEqual([
      expect.objectContaining({ scenario: "allowed_purchase", upstream_call_count: 1 })
    ]);
  });

  it("has no direct upstream method and delegates every attempt to its gateway", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const agent = new DemoAgent({ callTool });

    await agent.attempt("create_order", { amount: 100, currency: "INR" });

    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith("create_order", { amount: 100, currency: "INR" });
    expect("callTool" in agent).toBe(false);
  });
});
