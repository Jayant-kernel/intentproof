import type { CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";

import type { UpstreamClient } from "../upstream/types.js";
import { parseMcpJson } from "../upstream/mcp-json.js";
import type { MutationDispatcher, MutationDispatchOutcome } from "./types.js";

const successfulMutationSchemas = {
  create_order: z.object({ id: z.string().regex(/^order_[A-Za-z0-9]+$/u) }).passthrough(),
  create_payment_link: z.object({ id: z.string().regex(/^plink_[A-Za-z0-9]+$/u) }).passthrough(),
  capture_payment: z
    .object({
      id: z.string().regex(/^pay_[A-Za-z0-9]+$/u),
      status: z.literal("captured")
    })
    .passthrough()
} as const;

function confirmedEntity(
  tool: string,
  result: CallToolResult
): { id: string } | undefined {
  const schema = successfulMutationSchemas[tool as keyof typeof successfulMutationSchemas];
  if (!schema) return undefined;
  const parsed = schema.safeParse(parseMcpJson(result));
  return parsed.success ? parsed.data : undefined;
}

export class McpMutationDispatcher implements MutationDispatcher {
  constructor(private readonly upstream: UpstreamClient) {}

  async dispatch(
    tool: string,
    arguments_: Record<string, unknown>
  ): Promise<MutationDispatchOutcome> {
    try {
      const result = await this.upstream.callTool(tool, arguments_);
      const entity = confirmedEntity(tool, result);
      return entity
        ? { kind: "CONFIRMED_SUCCESS", result, upstreamEntityId: entity.id }
        : { kind: "INDETERMINATE", result };
    } catch {
      return { kind: "INDETERMINATE" };
    }
  }
}
