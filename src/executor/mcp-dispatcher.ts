import type { CallToolResult } from "@modelcontextprotocol/client";

import type { UpstreamClient } from "../upstream/types.js";
import type { MutationDispatcher, MutationDispatchOutcome } from "./types.js";

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> =>
      item.type === "text"
    )
    .map((item) => item.text)
    .join(" ");
}

function isDefinitiveClientFailure(result: CallToolResult): boolean {
  return /\b(?:400|401|403|404|409|422)\b/u.test(textOf(result));
}

export class McpMutationDispatcher implements MutationDispatcher {
  constructor(private readonly upstream: UpstreamClient) {}

  async dispatch(
    tool: string,
    arguments_: Record<string, unknown>
  ): Promise<MutationDispatchOutcome> {
    try {
      const result = await this.upstream.callTool(tool, arguments_);
      if (result.isError !== true) {
        return { kind: "CONFIRMED_SUCCESS", result };
      }
      return isDefinitiveClientFailure(result)
        ? { kind: "DEFINITIVE_FAILURE", result }
        : { kind: "INDETERMINATE", result };
    } catch {
      return { kind: "INDETERMINATE" };
    }
  }
}
