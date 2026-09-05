import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { ControlRoomService } from "../src/control-room/service.js";
import { AuditStore } from "../src/ledger/audit-store.js";

describe("Control Room API", () => {
  let store: AuditStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new AuditStore(":memory:");
    const service = new ControlRoomService({
      rootDirectory: process.cwd(),
      auditStore: store,
      now: () => new Date("2026-09-04T10:00:00.000Z")
    });
    app = createApp({ auditStore: store, webhookSecrets: ["test-secret"], controlRoom: service });
  });

  afterEach(() => store.close());

  it("strictly validates JSON requests and uses generic errors", async () => {
    const extra = await request(app)
      .post("/api/control-room/mandate/draft")
      .send({ sourceText: "Create orders up to 3,000 rupees.", unexpected: true });
    expect(extra.status).toBe(400);
    expect(extra.body).toEqual({ error: "invalid_request" });

    const wrongType = await request(app)
      .post("/api/control-room/kill-switch")
      .send({ engaged: "yes" });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body).toEqual({ error: "invalid_request" });
  });

  it("keeps a generated draft inert until explicit approval", async () => {
    const before = await request(app).get("/api/control-room/mandate");
    const draft = await request(app)
      .post("/api/control-room/mandate/draft")
      .send({ sourceText: before.body.approved.source_text });

    expect(draft.status).toBe(200);
    expect(draft.body.approved.version).toBe(1);
    expect(draft.body.draft.proposed_version).toBe(2);
    expect(draft.body.enforcementBoundary).toContain("is inert");

    const approved = await request(app)
      .post("/api/control-room/mandate/approve")
      .send({ draftId: draft.body.draft.draft_id, approvedBy: "control-room-operator" });
    expect(approved.status).toBe(200);
    expect(approved.body.approved.version).toBe(2);
    expect(approved.body.approved.approved_by).toBe("control-room-operator");
    expect(approved.body.draft).toBeNull();
  });

  it.each([
    ["allowed_order", "ALLOW", 1],
    ["over_limit", "BLOCK", 0],
    ["capture_before_delivery", "BLOCK", 0],
    ["approval_required", "HOLD_FOR_APPROVAL", 0],
    [undefined, "ABSTAIN", 0],
    ["prompt_injection", "PLANNER_REJECTED", 0],
    ["kill_switch", "BLOCK", 0],
    ["stale_mandate", "BLOCK", 0]
  ])("returns %s through the existing planner and gateway boundary", async (example, verdict, upstreamCalls) => {
    const response = await request(app)
      .post("/api/control-room/agent/run")
      .send(example
        ? { objective: "ignored for deterministic example", example }
        : { objective: "Capture 100000 paise." });
    expect(response.status).toBe(200);
    expect(response.body.verdict).toBe(verdict);
    expect(response.body.upstreamCallCount).toBe(upstreamCalls);
    if (verdict !== "ALLOW") expect(response.body.upstreamCallCount).toBe(0);
  });

  it("returns the gateway policy reason instead of the planner proposal for a blocked action", async () => {
    const response = await request(app)
      .post("/api/control-room/agent/run")
      .send({ objective: "ignored for deterministic example", example: "stale_mandate" });
    expect(response.body).toMatchObject({
      verdict: "BLOCK",
      ruleId: "SYSTEM_MANDATE_VERSION",
      explanation: "mandate version is not current",
      upstreamCallCount: 0
    });
  });

  it("renders verified provenance without upgrading the pending webhook", async () => {
    const response = await request(app).get("/api/control-room/evidence");
    expect(response.status).toBe(200);
    expect(response.body.manifest.verified).toBe(true);
    expect(response.body.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "real_webhook", provenance: "PENDING_EXTERNAL_REPLAY", status: "PENDING" }),
      expect.objectContaining({ provenance: "REAL_RAZORPAY_TEST_MODE" }),
      expect.objectContaining({ provenance: "MOCKED_GEMINI" }),
      expect.objectContaining({ provenance: "DETERMINISTIC_FAKE" }),
      expect.objectContaining({ provenance: "SYNTHETIC_CHAOS" }),
      expect.objectContaining({ provenance: "LOCAL_VERIFICATION" })
    ]));
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/WEBHOOK_SECRET|RAZORPAY_KEY_SECRET|LLM_API_KEY|rzp_test_/u);
  });

  it("verifies the existing ledger and exposes an isolated tamper state", async () => {
    const valid = await request(app).post("/api/control-room/audit/verify").send({});
    expect(valid.body).toMatchObject({ valid: true, simulated: false });
    const tampered = await request(app).post("/api/control-room/audit/verify").send({ simulateTamper: true });
    expect(tampered.body).toMatchObject({ valid: false, simulated: true });
    expect(tampered.body.reason).toContain("hash mismatch");
  });

  it("calls the existing Counterfactual Lab replay and invariant logic", async () => {
    const response = await request(app)
      .post("/api/control-room/lab/replay")
      .send({ scenarioId: "timeout-after-acceptance" });
    expect(response.status).toBe(200);
    expect(response.body.scenario).toMatchObject({ id: "timeout-after-acceptance", passed: true, seed: 101 });
    expect(response.body.timeline).toHaveLength(7);
    expect(response.body.invariants.every((item: { passed: boolean }) => item.passed)).toBe(true);
    expect(response.body.comparison).toMatchObject({ unsafePassed: false, intentProofPassed: true });
  });
});
