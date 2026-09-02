import { createHmac, timingSafeEqual } from "node:crypto";

const HEX_SHA256 = /^[a-f0-9]{64}$/iu;

export function signWebhook(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function matchesSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!HEX_SHA256.test(signature)) {
    return false;
  }

  const expected = Buffer.from(signWebhook(rawBody, secret), "hex");
  const observed = Buffer.from(signature, "hex");
  return expected.length === observed.length && timingSafeEqual(expected, observed);
}

export function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secrets: readonly string[]
): boolean {
  if (!signature) {
    return false;
  }

  return secrets.filter((secret) => secret.length > 0).some((secret) =>
    matchesSignature(rawBody, signature, secret)
  );
}
