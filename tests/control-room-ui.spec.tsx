// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../web/src/App.js";
import type { MandateData } from "../web/src/types.js";

const overview = {
  mandate: { id: "mnd_demo_001", version: 1, hash: `sha256:${"a".repeat(64)}`, approvedBy: "demo-merchant" },
  killSwitch: false,
  budget: { usedPaise: 0, limitPaise: 2500000, calls: 0, maxCalls: 200 },
  allowedTools: ["create_order", "create_payment_link", "capture_payment"],
  lastVerdict: null,
  upstreamCallsPrevented: 0,
  ledger: { valid: true, records: 1, reason: "ledger integrity verified" },
  webhookStatus: "PENDING_EXTERNAL_REPLAY",
  evidenceDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigestShort: "sha256:bbbb…bbbbbbbb",
  runtime: "DETERMINISTIC_FAKE"
};

const mandate: MandateData = {
  approved: { mandate_id: "mnd_demo_001", version: 1, source_text: "Create orders up to 3,000 rupees.", approved_by: "demo-merchant", approved_at: "2026-09-01T03:35:00.000Z", mandate_hash: `sha256:${"a".repeat(64)}`, constraints: [{ id: "C1", rule: "tool_allowlist", tools: ["create_order"], quote: "Create orders up to 3,000 rupees." }], budgets: [] },
  draft: null,
  diff: [],
  enforcementBoundary: "Only approved version 1 can enforce policy."
};

const evidence = {
  manifest: { createdAt: "2026-09-03T21:06:37.000Z", gitCommit: "a".repeat(40), digest: `sha256:${"b".repeat(64)}`, verified: true, artifactsVerified: 11 },
  scoreboard: { tests_passed: 163, invariants_checked: 9, failures_independently_discovered: 1, trace_original_events: 15, trace_minimized_events: 11, non_allow_upstream_calls: 0, duplicate_effects_prevented: 1, ledger_verified: true, real_webhook_status: "PENDING_EXTERNAL_REPLAY", provenance_counts: {} },
  evidence: [{ id: "real_webhook", provenance: "PENDING_EXTERNAL_REPLAY", status: "PENDING", metrics: { genuinely_received: false } }],
  limitations: ["A genuine Razorpay webhook replay has not yet reached the listener."],
  provenanceDigest: `sha256:${"c".repeat(64)}`
};

let mandateResponse: MandateData = mandate;
let auditRecords: Array<Record<string, unknown>> = [];

function json(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

describe("Control Room UI", () => {
  beforeEach(() => {
    history.replaceState(null, "", "#overview");
    mandateResponse = mandate;
    auditRecords = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/overview")) return json(overview);
      if (path.endsWith("/mandate")) return json(mandateResponse);
      if (path.endsWith("/evidence")) return json(evidence);
      if (path.endsWith("/lab/scenarios")) return json({ scenarios: [{ id: "timeout-after-acceptance", name: "Timeout after provider acceptance", description: "A safe replay.", seed: 101, events: 7 }] });
      if (path.endsWith("/audit")) return json({ records: auditRecords });
      if (path.endsWith("/agent/run") && init?.method === "POST") return json({ example: "Allowed ₹199 order", objective: "Create an order for 19900 paise.", verdict: "ALLOW", explanation: "Propose the requested order for deterministic policy review.", proposedTool: "create_order", arguments: { amount: 19900, currency: "INR" }, intentId: "int_demo_allowed", ruleId: null, quote: null, gatewayCallCount: 1, upstreamCallCount: 1 });
      throw new Error(`Unhandled request: ${path}`);
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("loads the operational overview and preserves the pending webhook label", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Control Room" })).toBeInTheDocument();
    expect(screen.getAllByText("PENDING_EXTERNAL_REPLAY").length).toBeGreaterThan(0);
    expect(screen.getByText("PENDING EXTERNAL REPLAY")).toBeInTheDocument();
    expect(screen.getByText("Razorpay Test Mode")).toBeInTheDocument();
  });

  it("runs the primary allowed-order workflow from the Agent tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Control Room" });
    await user.click(screen.getByRole("link", { name: "Agent" }));
    await user.click(screen.getByRole("button", { name: /Allowed ₹199 order/u }));
    expect(screen.getByRole("alertdialog", { name: /Run Allowed/u })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run Through Gateway" }));
    expect(await screen.findByRole("heading", { name: "Action May Proceed" })).toBeInTheDocument();
    expect(screen.getByText("create_order")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/1 upstream call/u)).toBeInTheDocument());
  });

  it("makes every requested screen reachable from navigation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Control Room" });
    for (const name of ["Mandate", "Agent", "Audit", "Counterfactual Lab", "Evidence"]) {
      await user.click(screen.getByRole("link", { name }));
      expect(screen.getByRole("heading", { name, level: 1 })).toBeInTheDocument();
    }
    expect(screen.getAllByText("Pending External Replay").length).toBeGreaterThan(0);
  });

  it("keeps an audited rule linked to the approved mandate when a draft exists", async () => {
    mandateResponse = {
      ...mandate,
      draft: {
        draft_id: "draft_demo_v2",
        proposed_version: 2,
        source_text: "Draft quotation must remain inert.",
        draft_hash: `sha256:${"d".repeat(64)}`,
        compiler: { provider: "deterministic_fake", model: "fixture" },
        rules: { constraints: [{ id: "C1", rule: "tool_allowlist", tools: ["create_order"], quote: "Draft quotation must remain inert." }], budgets: [] },
        review: { approvable: true, source_references: [], unsupported_instructions: [], ambiguities: [], conservative_assumptions: [], validation_errors: [] }
      },
      enforcementBoundary: "Draft draft_demo_v2 is inert. Version 1 remains authoritative."
    };
    auditRecords = [{ seq: 1, timestamp: "2026-09-05T04:00:00.000Z", actor: "agent", action: "TOOL_BLOCKED", verdict: "BLOCK", rule: "C1", upstreamEffect: "prevented", stateTransition: "tool blocked", evidenceHash: `sha256:${"e".repeat(64)}`, previousHash: "GENESIS", details: {} }];
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Control Room" });
    await user.click(screen.getByRole("link", { name: "Audit" }));
    await user.click(screen.getByRole("button", { name: "C1" }));
    expect(screen.getByRole("heading", { name: "Approved Rules" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Draft v2" })).toBeInTheDocument();
    expect(document.querySelector("#rule-C1")).toHaveClass("highlighted-rule");
    expect(document.querySelector("#draft-rule-C1")).not.toHaveClass("highlighted-rule");
  });

  it("renders nested sanitized audit details as readable JSON", async () => {
    auditRecords = [{ seq: 1, timestamp: "2026-09-05T04:00:00.000Z", actor: "agent", action: "TOOL_BLOCKED", verdict: "BLOCK", rule: "C1", upstreamEffect: "prevented", stateTransition: "tool blocked", evidenceHash: `sha256:${"e".repeat(64)}`, previousHash: "GENESIS", details: { counterfactual: { endpoint: "POST /v1/orders", amount_paise: 19900 } } }];
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Control Room" });
    await user.click(screen.getByRole("link", { name: "Audit" }));
    await user.click(screen.getByRole("button", { name: /agent · #1/u }));
    expect(screen.getByText(/POST \/v1\/orders/u)).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
  });
});
