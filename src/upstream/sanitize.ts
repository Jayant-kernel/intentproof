import type { CallToolResult } from "@modelcontextprotocol/client";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function sanitizeText(text: string, sensitiveValues: readonly string[] = []): string {
  let sanitized = text;

  for (const value of sensitiveValues) {
    if (value.length > 0) {
      sanitized = sanitized.replace(new RegExp(escapeRegExp(value), "gu"), "[REDACTED]");
    }
  }

  return sanitized
    .replace(/rzp_(?:test|live)_[A-Za-z0-9_-]+/giu, "[REDACTED_RAZORPAY_KEY_ID]")
    .replace(/(authorization\s*[:=]\s*)(?:basic|bearer)\s+[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /((?:key_secret|api_secret|client_secret|password|token|secret)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu,
      "$1[REDACTED]"
    )
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}

export function sanitizeUnknown(value: unknown, sensitiveValues: readonly string[] = []): unknown {
  if (typeof value === "string") {
    return sanitizeText(value, sensitiveValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, sensitiveValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeUnknown(item, sensitiveValues)])
    );
  }
  return value;
}

export function sanitizeToolResult(
  result: CallToolResult,
  sensitiveValues: readonly string[] = []
): CallToolResult {
  return sanitizeUnknown(result, sensitiveValues) as CallToolResult;
}

export function sanitizedErrorMessage(
  error: unknown,
  sensitiveValues: readonly string[] = []
): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeText(message, sensitiveValues);
}
