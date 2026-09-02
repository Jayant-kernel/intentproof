import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
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
});
