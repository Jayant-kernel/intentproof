import { Client, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/client/stdio";

import { sanitizedErrorMessage, sanitizeToolResult, sanitizeUnknown } from "./sanitize.js";
import type { UpstreamClient } from "./types.js";

export const DEFAULT_RAZORPAY_MCP_IMAGE =
  "razorpay/mcp@sha256:435109006d6247103899938cf7b1747ba8be1c1a8a28d452cf9fa8eff506e5c6";

export interface RazorpayMcpOptions {
  keyId: string;
  keySecret: string;
  image?: string;
}

export function assertTestModeKeyId(keyId: string): void {
  if (!keyId.startsWith("rzp_test_")) {
    throw new Error("IntentProof accepts Razorpay Test Mode keys only");
  }
}

export function dockerArguments(image = DEFAULT_RAZORPAY_MCP_IMAGE): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "-e",
    "RAZORPAY_KEY_ID",
    "-e",
    "RAZORPAY_KEY_SECRET",
    image
  ];
}

export class RazorpayMcpClient implements UpstreamClient {
  private constructor(
    private readonly client: Client,
    private readonly sensitiveValues: readonly string[]
  ) {}

  static async connect(options: RazorpayMcpOptions): Promise<RazorpayMcpClient> {
    assertTestModeKeyId(options.keyId);
    if (options.keySecret.length === 0) {
      throw new Error("Razorpay Test Mode key secret is required");
    }

    const sensitiveValues = [options.keyId, options.keySecret];
    const client = new Client({ name: "intentproof-upstream", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: "docker",
      args: dockerArguments(options.image),
      env: {
        ...getDefaultEnvironment(),
        RAZORPAY_KEY_ID: options.keyId,
        RAZORPAY_KEY_SECRET: options.keySecret
      },
      stderr: "pipe"
    });

    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_192);
    });

    try {
      await client.connect(transport);
      return new RazorpayMcpClient(client, sensitiveValues);
    } catch (error) {
      await transport.close().catch(() => undefined);
      const message = sanitizedErrorMessage(error, sensitiveValues);
      const detail = sanitizeUnknown(stderr.trim(), sensitiveValues);
      throw new Error(
        typeof detail === "string" && detail.length > 0 ? `${message}: ${detail}` : message
      );
    }
  }

  async listTools(): Promise<Tool[]> {
    try {
      const { tools } = await this.client.listTools();
      return sanitizeUnknown(tools, this.sensitiveValues) as Tool[];
    } catch (error) {
      throw new Error(sanitizedErrorMessage(error, this.sensitiveValues));
    }
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const result = await this.client.callTool({ name, arguments: arguments_ });
      return sanitizeToolResult(result, this.sensitiveValues);
    } catch (error) {
      throw new Error(sanitizedErrorMessage(error, this.sensitiveValues));
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
