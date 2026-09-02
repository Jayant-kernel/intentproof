import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { testModeCredentialsFromEnvironment } from "../upstream/credentials.js";
import {
  DEFAULT_RAZORPAY_MCP_IMAGE,
  RazorpayMcpClient
} from "../upstream/razorpay-mcp.js";

function classifyReadFailure(result: { content: Array<{ type: string; text?: string }> }): string {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join(" ")
    .toLowerCase();

  if (/401|authenticat|invalid key|credential/u.test(text)) return "authentication";
  if (/403|permission|forbidden|authoriz/u.test(text)) return "authorization";
  if (/429|rate.?limit/u.test(text)) return "rate_limit";
  if (/timeout|timed out|network|connect|dns|socket/u.test(text)) return "connectivity";
  return "upstream_error";
}

const outputPath = resolve(process.argv[2] ?? "evidence/upstream-probe.json");
const observedAt = new Date().toISOString();
const credentials = testModeCredentialsFromEnvironment();

let evidence: Record<string, unknown>;
if (!credentials) {
  evidence = {
    observed_at: observedAt,
    status: "credentials_missing",
    image: DEFAULT_RAZORPAY_MCP_IMAGE,
    tool_names: [],
    read_call: null,
    note: "No .env was read by this run because Test Mode credentials were unavailable."
  };
} else {
  const upstream = await RazorpayMcpClient.connect(credentials);
  try {
    const tools = await upstream.listTools();
    const toolNames = tools.map((tool) => tool.name).sort();
    const readTool = "fetch_all_payments";
    let readCall: Record<string, unknown>;
    if (!toolNames.includes(readTool)) {
      readCall = { tool: readTool, called: false, succeeded: false, reason: "tool_missing" };
    } else {
      const result = await upstream.callTool(readTool, { count: 1 });
      readCall = {
        tool: readTool,
        called: true,
        succeeded: result.isError !== true,
        content_types: result.content.map((item) => item.type),
        ...(result.isError === true ? { error_category: classifyReadFailure(result) } : {})
      };
    }
    evidence = {
      observed_at: observedAt,
      status: readCall.succeeded === true ? "complete" : "read_failed",
      image: DEFAULT_RAZORPAY_MCP_IMAGE,
      tool_count: toolNames.length,
      tool_names: toolNames,
      read_call: readCall,
      note: "Only tool metadata and read-call status are retained; response bodies and credentials are omitted."
    };
  } finally {
    await upstream.close();
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`Sanitized upstream probe evidence written to ${outputPath}\n`);
