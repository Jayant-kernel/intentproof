import type { CallToolResult, Tool } from "@modelcontextprotocol/client";

import type { DispatchState } from "../budget/types.js";

export type ReconciliationReadTool =
  | "fetch_all_orders"
  | "fetch_all_payment_links"
  | "fetch_payment";

export interface ReconciliationReadClient {
  callReadTool(
    name: ReconciliationReadTool,
    arguments_: Record<string, unknown>
  ): Promise<CallToolResult>;
}

export interface ReconciliationCapabilities {
  orderReceiptFilter: boolean;
  paymentLinkReferenceFilter: boolean;
  fetchPayment: boolean;
}

function hasInputProperty(tool: Tool | undefined, property: string): boolean {
  const schema = tool?.inputSchema as { properties?: unknown } | undefined;
  return (
    schema?.properties !== null &&
    typeof schema?.properties === "object" &&
    Object.hasOwn(schema.properties, property)
  );
}

export function inspectReconciliationCapabilities(
  tools: readonly Tool[]
): ReconciliationCapabilities {
  const named = (name: string): Tool | undefined => tools.find((tool) => tool.name === name);
  return {
    orderReceiptFilter: hasInputProperty(named("fetch_all_orders"), "receipt"),
    paymentLinkReferenceFilter: hasInputProperty(
      named("fetch_all_payment_links"),
      "reference_id"
    ),
    fetchPayment: hasInputProperty(named("fetch_payment"), "payment_id")
  };
}

export interface ReconcileResult {
  status: DispatchState;
  disposition:
    | "settled"
    | "deferred"
    | "not_due"
    | "lease_held"
    | "terminal"
    | "not_found";
  reads: number;
}
