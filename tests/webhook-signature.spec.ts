import { describe, expect, it } from "vitest";

import { signWebhook, verifyWebhookSignature } from "../src/intake/signature.js";

describe("Razorpay webhook byte semantics", () => {
  const secret = "test_webhook_secret";
  const original = Buffer.from('{"event":"payment.captured","count":1}', "utf8");
  const reserialized = Buffer.from('{"count":1,"event":"payment.captured"}', "utf8");
  const pretty = Buffer.from('{\n  "event": "payment.captured",\n  "count": 1\n}', "utf8");

  it("accepts the original bytes with their signature", () => {
    const signature = signWebhook(original, secret);
    expect(verifyWebhookSignature(original, signature, [secret])).toBe(true);
  });

  it("rejects changed bytes carrying the original signature", () => {
    const signature = signWebhook(original, secret);
    expect(verifyWebhookSignature(reserialized, signature, [secret])).toBe(false);
  });

  it("accepts reserialized bytes when those exact bytes were signed", () => {
    const signature = signWebhook(reserialized, secret);
    expect(verifyWebhookSignature(reserialized, signature, [secret])).toBe(true);
  });

  it("accepts pretty-printed bytes when those exact bytes were signed", () => {
    const signature = signWebhook(pretty, secret);
    expect(verifyWebhookSignature(pretty, signature, [secret])).toBe(true);
  });

  it("accepts a previous secret during rotation", () => {
    const signature = signWebhook(original, "previous_secret");
    expect(verifyWebhookSignature(original, signature, [secret, "previous_secret"])).toBe(true);
  });

  it("rejects malformed signatures without throwing", () => {
    expect(verifyWebhookSignature(original, "not-hex", [secret])).toBe(false);
    expect(verifyWebhookSignature(original, undefined, [secret])).toBe(false);
  });
});
