import { createHash } from "node:crypto";

export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const item = record[key];
        if (item === undefined) {
          throw new TypeError(`Canonical JSON does not support undefined at ${key}`);
        }
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      });
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`Canonical JSON does not support ${typeof value}`);
}

export function chainedHash(previousHash: string, record: unknown): string {
  const digest = createHash("sha256")
    .update(previousHash)
    .update("\n")
    .update(canonicalJson(record))
    .digest("hex");
  return `sha256:${digest}`;
}
