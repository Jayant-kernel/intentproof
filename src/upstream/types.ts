import type { CallToolResult, Tool } from "@modelcontextprotocol/client";

export interface UpstreamClient {
  listTools(): Promise<Tool[]>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
