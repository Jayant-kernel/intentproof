import "dotenv/config";

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { runGatewayPassThroughProbe } from "../evidence/gateway-pass-through.js";
import { loadMandate } from "../mandate/load.js";
import { testModeCredentialsFromEnvironment } from "../upstream/credentials.js";
import {
  DEFAULT_RAZORPAY_MCP_IMAGE,
  RazorpayMcpClient
} from "../upstream/razorpay-mcp.js";

const outputPath = resolve(process.argv[2] ?? "evidence/gateway-pass-through.json");
if (existsSync(outputPath)) {
  throw new Error(
    `Refusing to repeat the mutating probe because evidence already exists at ${outputPath}`
  );
}

const credentials = testModeCredentialsFromEnvironment();
if (!credentials) {
  throw new Error("Razorpay Test Mode credentials are missing");
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      observed_at: new Date().toISOString(),
      status: "started",
      mode: "Razorpay Test Mode",
      order_attempt_limit: 1,
      note: "This marker prevents an automatic retry if the process stops after dispatch."
    },
    null,
    2
  )}\n`,
  { encoding: "utf8", mode: 0o600 }
);

const upstream = await RazorpayMcpClient.connect(credentials);
try {
  const evidence = await runGatewayPassThroughProbe({
    upstream,
    mandate: loadMandate(resolve("mandates/default.yaml")),
    policyNow: new Date("2026-09-03T04:30:00.000Z"),
    upstreamImage: DEFAULT_RAZORPAY_MCP_IMAGE,
    sensitiveValues: [credentials.keyId, credentials.keySecret]
  });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  process.stdout.write(`Sanitized gateway probe evidence written to ${outputPath}\n`);
  if (evidence.status !== "complete") {
    process.exitCode = 1;
  }
} catch {
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        observed_at: new Date().toISOString(),
        status: "failed",
        mode: "Razorpay Test Mode",
        order_attempt_may_have_occurred: true,
        note: "No automatic retry is permitted; inspect the Razorpay Test Mode dashboard first."
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  throw new Error("Gateway probe failed; sanitized failure evidence was saved");
} finally {
  await upstream.close();
}
