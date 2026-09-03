import "dotenv/config";

import { resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { BudgetedExecutor } from "../executor/budgeted-executor.js";
import { McpMutationDispatcher } from "../executor/mcp-dispatcher.js";
import { AuditStore } from "../ledger/audit-store.js";
import { loadMandate } from "../mandate/load.js";
import { McpReconciliationReadClient } from "../reconciliation/mcp-read-client.js";
import { DispatchReconciler } from "../reconciliation/reconciler.js";
import { inspectReconciliationCapabilities } from "../reconciliation/types.js";
import { testModeCredentialsFromEnvironment } from "../upstream/credentials.js";
import { RazorpayMcpClient } from "../upstream/razorpay-mcp.js";
import { IntentProofGateway } from "./gateway.js";
import { createGatewayMcpServer } from "./mcp-server.js";

const credentials = testModeCredentialsFromEnvironment();
if (!credentials) {
  throw new Error("RZP_KEY_ID and RZP_KEY_SECRET are required in the local ignored .env");
}

const mandate = loadMandate(resolve("mandates/default.yaml"));
const auditStore = new AuditStore(process.env.DB_PATH ?? "./intentproof.db");
auditStore.initializeRuntimeControls(mandate.version);
const recoveryStaleMs = 30_000;
const startupTime = new Date();
auditStore.recoverDispatches(
  new Date(startupTime.getTime() - recoveryStaleMs).toISOString(),
  startupTime.toISOString()
);
const upstream = await RazorpayMcpClient.connect(credentials);

const upstreamTools = await upstream.listTools();
const upstreamToolNames = new Set(upstreamTools.map((tool) => tool.name));
for (const required of ["create_order", "create_payment_link", "capture_payment"]) {
  if (!upstreamToolNames.has(required)) {
    await upstream.close();
    auditStore.close();
    throw new Error(`Official Razorpay MCP server does not expose required tool: ${required}`);
  }
}

const budget = mandate.budgets[0];
if (!budget) {
  await upstream.close();
  auditStore.close();
  throw new Error("The active mandate must define a rolling budget");
}
const reconciler = new DispatchReconciler({
  store: auditStore,
  readClient: new McpReconciliationReadClient(upstream),
  capabilities: inspectReconciliationCapabilities(upstreamTools)
});
const executor = new BudgetedExecutor({
  store: auditStore,
  dispatcher: new McpMutationDispatcher(upstream),
  mandateId: mandate.mandate_id,
  mandateVersion: mandate.version,
  agentId: "mcp-agent",
  maxTotalPaise: budget.max_total_paise,
  maxCalls: budget.max_calls,
  reconciler
});

const gateway = new IntentProofGateway({
  mandate,
  upstream,
  executor,
  auditStore,
  sensitiveValues: [credentials.keyId, credentials.keySecret],
  policyContext: () => {
    const now = new Date();
    const usage = auditStore.budgetUsage(
      new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString()
    );
    return {
      now,
      killSwitch: false,
      expectedMandateVersion: mandate.version,
      rollingCalls: usage.calls,
      rollingValuePaise: usage.valuePaise
    };
  }
});
const server = createGatewayMcpServer(gateway);
const transport = new StdioServerTransport();
let maintenancePromise: Promise<void> | null = null;
function runReconciliationMaintenance(): Promise<void> {
  if (maintenancePromise) return maintenancePromise;
  const work = (async () => {
    try {
      const now = new Date();
      auditStore.recoverDispatches(
        new Date(now.getTime() - recoveryStaleMs).toISOString(),
        now.toISOString()
      );
      await reconciler.reconcileDue();
    } catch {
      auditStore.append("RECONCILIATION_WORKER_ERROR", { outcome: "retry_later" });
    }
  })();
  maintenancePromise = work.finally(() => {
    maintenancePromise = null;
  });
  return maintenancePromise;
}
const reconciliationTimer = setInterval(() => {
  void runReconciliationMaintenance();
}, 30_000);
reconciliationTimer.unref();

async function shutdown(): Promise<void> {
  clearInterval(reconciliationTimer);
  await maintenancePromise?.catch(() => undefined);
  await server.close().catch(() => undefined);
  await upstream.close().catch(() => undefined);
  auditStore.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await server.connect(transport);
} catch (error) {
  await shutdown();
  throw error;
}
