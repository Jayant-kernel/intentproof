import type { UpstreamClient } from "../upstream/types.js";
import type { ReconciliationReadClient, ReconciliationReadTool } from "./types.js";

const READ_TOOLS = new Set<ReconciliationReadTool>([
  "fetch_all_orders",
  "fetch_all_payment_links",
  "fetch_payment"
]);

export class McpReconciliationReadClient implements ReconciliationReadClient {
  constructor(private readonly upstream: UpstreamClient) {}

  callReadTool(name: ReconciliationReadTool, arguments_: Record<string, unknown>) {
    if (!READ_TOOLS.has(name)) {
      throw new Error(`Reconciliation tool is not allowlisted: ${String(name)}`);
    }
    return this.upstream.callTool(name, arguments_);
  }
}
