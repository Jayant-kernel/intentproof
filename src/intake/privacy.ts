import { createHash } from "node:crypto";

export function hashWebhookIdentifier(value: string | undefined): string | null {
  if (!value) return null;
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
