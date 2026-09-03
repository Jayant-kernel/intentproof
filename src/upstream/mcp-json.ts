import type { CallToolResult } from "@modelcontextprotocol/client";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseMcpJson(result: CallToolResult): unknown {
  if (result.isError === true) return undefined;
  if (isObject(result.structuredContent)) return result.structuredContent;

  const text = result.content.filter(
    (item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
      item.type === "text"
  );
  if (text.length !== 1) return undefined;

  try {
    return JSON.parse(text[0]!.text) as unknown;
  } catch {
    return undefined;
  }
}
