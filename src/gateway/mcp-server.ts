import { McpServer } from "@modelcontextprotocol/server";

import type { IntentProofGateway } from "./gateway.js";
import {
  capturePaymentSchema,
  createOrderSchema,
  createPaymentLinkSchema
} from "./schemas.js";

const mutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false
} as const;

export function createGatewayMcpServer(gateway: IntentProofGateway): McpServer {
  const server = new McpServer({ name: "intentproof-chowkidar", version: "0.1.0" });

  server.registerTool(
    "create_order",
    {
      description: "Create an INR order after deterministic IntentProof policy enforcement.",
      inputSchema: createOrderSchema,
      annotations: mutationAnnotations
    },
    async (arguments_) => gateway.callTool("create_order", arguments_)
  );

  server.registerTool(
    "create_payment_link",
    {
      description: "Create an INR Payment Link after deterministic IntentProof policy enforcement.",
      inputSchema: createPaymentLinkSchema,
      annotations: mutationAnnotations
    },
    async (arguments_) => gateway.callTool("create_payment_link", arguments_)
  );

  server.registerTool(
    "capture_payment",
    {
      description: "Capture a full authorized INR payment after deterministic IntentProof policy enforcement.",
      inputSchema: capturePaymentSchema,
      annotations: mutationAnnotations
    },
    async (arguments_) => gateway.callTool("capture_payment", arguments_)
  );

  return server;
}
