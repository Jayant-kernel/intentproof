import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { prepareMutation } from "../src/executor/budgeted-executor.js";
import { signWebhook } from "../src/intake/signature.js";
import { AuditStore } from "../src/ledger/audit-store.js";

describe("webhook intake", () => {
  const secret = "route_test_secret";
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  function payload(event: string, paymentId = "pay_test_001"): string {
    return JSON.stringify({
      event,
      payload: { payment: { entity: { id: paymentId } } }
    });
  }

  async function send(eventId: string, body: string, signature = signWebhook(Buffer.from(body), secret)) {
    return request(createApp({ auditStore: store, webhookSecrets: [secret] }))
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-razorpay-event-id", eventId)
      .set("x-razorpay-signature", signature)
      .send(body);
  }

  it("rejects an invalid signature before applying an event", async () => {
    const response = await send("evt_bad", payload("payment.captured"), "0".repeat(64));
    expect(response.status).toBe(401);
    expect(store.countByType("SIGNATURE_REJECTED")).toBe(1);
    expect(store.countByType("WEBHOOK_APPLIED")).toBe(0);
  });

  it("applies a valid delivery once and drops its replay", async () => {
    const body = payload("payment.captured");
    const first = await send("evt_same", body);
    const second = await send("evt_same", body);

    expect(first.status).toBe(200);
    expect(first.body.status).toBe("applied");
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate_delivery");
    expect(store.countByType("WEBHOOK_APPLIED")).toBe(1);
    expect(store.countByType("DUPLICATE_DROPPED")).toBe(1);
  });

  it("deduplicates the same capture effect across distinct event types", async () => {
    const captured = await send("evt_captured", payload("payment.captured"));
    const orderPaid = await send("evt_order_paid", payload("order.paid"));

    expect(captured.body.status).toBe("applied");
    expect(orderPaid.body.status).toBe("duplicate_effect");
    expect(store.countByType("WEBHOOK_APPLIED")).toBe(1);
    expect(store.countByType("EFFECT_DEDUPED")).toBe(1);
  });

  it("does not regress captured state when authorized arrives later", async () => {
    await send("evt_captured", payload("payment.captured"));
    const authorized = await send("evt_authorized", payload("payment.authorized"));

    expect(authorized.body.status).toBe("out_of_order");
    expect(store.countByType("OUT_OF_ORDER_IGNORED")).toBe(1);
  });

  it("settles an uncertain capture once when webhook and reconciler race", async () => {
    const paymentId = "pay_WEBHOOKRACE1";
    const arguments_ = { payment_id: paymentId, amount: 20_000, currency: "INR" };
    const prepared = prepareMutation("capture_payment", arguments_, 20_000, "webhook-race");
    store.initializeRuntimeControls(1);
    store.reserveDispatch({
      idempotencyKey: "webhook-race",
      tool: "capture_payment",
      amountPaise: 20_000,
      mandateId: "mnd_test",
      mandateVersion: 1,
      agentId: "agent_test",
      now: "2026-09-03T05:00:00.000Z",
      windowStart: "2026-09-02T05:00:00.000Z",
      maxTotalPaise: 100_000,
      maxCalls: 10,
      requestFingerprint: prepared.requestFingerprint,
      correlationType: prepared.correlationType,
      correlationValue: prepared.correlationValue
    });
    store.claimDispatch("webhook-race", 1, "2026-09-03T05:00:00.000Z");
    store.settleDispatch(
      "webhook-race",
      "IN_DOUBT",
      "timeout",
      "2026-09-03T05:00:00.000Z"
    );
    store.acquireReconcileLease({
      idempotencyKey: "webhook-race",
      owner: "racing-worker",
      now: "2026-09-03T05:00:01.000Z",
      leaseUntil: "2026-09-03T05:00:31.000Z"
    });

    const webhook = await send("evt_webhook_race", payload("payment.captured", paymentId));
    const racedSettlement = store.settleReconciledDispatch({
      idempotencyKey: "webhook-race",
      owner: "racing-worker",
      state: "COMMITTED",
      upstreamStatus: "capture_captured_confirmed",
      now: "2026-09-03T05:00:02.000Z"
    });

    expect(webhook.body.status).toBe("applied");
    expect(racedSettlement.state).toBe("COMMITTED");
    expect(store.countByType("BUDGET_COMMITTED")).toBe(1);
    expect(store.countByType("RECONCILIATION_SETTLED")).toBe(1);
  });
});
