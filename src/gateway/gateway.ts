import { createHash, randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/client";
import { ZodError } from "zod";

import { canonicalJson } from "../ledger/canonical.js";
import type { AuditPayload } from "../ledger/types.js";
import { mandateSchema, type Mandate } from "../mandate/schema.js";
import { evaluatePolicy } from "../policy/evaluate.js";
import type { PolicyContext, PolicyDecision } from "../policy/types.js";
import type { ExecuteMutationResult, ToolExecutor } from "../executor/types.js";
import { sanitizedErrorMessage, sanitizeToolResult } from "../upstream/sanitize.js";
import type { UpstreamClient } from "../upstream/types.js";
import {
  isGatewayToolName,
  parseGatewayArguments,
  type GatewayToolName
} from "./schemas.js";

export interface AuditSink {
  append(type: string, payload: AuditPayload, timestamp?: string): unknown;
}

export interface GatewayCall {
  tool: GatewayToolName;
  arguments: Record<string, unknown>;
}

export type PolicyContextProvider = (
  call: GatewayCall
) => PolicyContext | Promise<PolicyContext>;

export interface IntentProofGatewayOptions {
  mandate: Mandate;
  upstream: UpstreamClient;
  executor?: ToolExecutor;
  policyContext: PolicyContextProvider;
  auditStore?: AuditSink;
  sensitiveValues?: readonly string[];
  traceIdFactory?: () => string;
}

function argumentsDigest(arguments_: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(arguments_)).digest("hex")}`;
}

function endpoint(tool: GatewayToolName, arguments_: Record<string, unknown>): string {
  switch (tool) {
    case "create_order":
      return "POST /v1/orders";
    case "create_payment_link":
      return "POST /v1/payment_links";
    case "capture_payment":
      return `POST /v1/payments/${String(arguments_.payment_id)}/capture`;
  }
}

function toolClass(tool: GatewayToolName): "BOUNDED" | "IRREVERSIBLE" {
  return tool === "capture_payment" ? "IRREVERSIBLE" : "BOUNDED";
}

function decisionResult(decision: PolicyDecision, traceId: string): CallToolResult {
  const body = { ...decision, trace_id: traceId };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: decision.verdict !== "ALLOW"
  };
}

function schemaFailure(error: ZodError, traceId: string): CallToolResult {
  const body = {
    verdict: "ABSTAIN",
    rule_id: "SYSTEM_ARGUMENT_SCHEMA",
    quote: null,
    message: "tool arguments do not match the supported IntentProof schema",
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    trace_id: traceId
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true
  };
}

function executorStateResult(result: ExecuteMutationResult): CallToolResult {
  const body = {
    status: result.status,
    idempotency_key: result.idempotencyKey,
    replayed: result.replayed,
    ...(result.status === "BLOCKED"
      ? { verdict: "BLOCK", rule_id: result.ruleId, message: result.message }
      : {})
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: result.status !== "COMMITTED"
  };
}

export class IntentProofGateway {
  private readonly options: IntentProofGatewayOptions;

  constructor(options: IntentProofGatewayOptions) {
    this.options = { ...options, mandate: mandateSchema.parse(options.mandate) };
  }

  async callTool(toolName: string, rawArguments: unknown): Promise<CallToolResult> {
    const traceId = this.options.traceIdFactory?.() ?? `trc_${randomUUID()}`;
    if (!isGatewayToolName(toolName)) {
      const decision: PolicyDecision = {
        verdict: "BLOCK",
        rule_id: "SYSTEM_TOOL_ALLOWLIST",
        quote: null,
        message: `${toolName} is outside the supported IntentProof tool surface`
      };
      this.options.auditStore?.append("TOOL_BLOCKED", {
        trace_id: traceId,
        tool: toolName,
        verdict: decision.verdict,
        rule_id: decision.rule_id
      });
      return decisionResult(decision, traceId);
    }

    let arguments_: Record<string, unknown>;
    try {
      arguments_ = parseGatewayArguments(toolName, rawArguments);
    } catch (error) {
      if (!(error instanceof ZodError)) {
        throw error;
      }
      this.options.auditStore?.append("TOOL_ABSTAINED", {
        trace_id: traceId,
        tool: toolName,
        verdict: "ABSTAIN",
        rule_id: "SYSTEM_ARGUMENT_SCHEMA"
      });
      return schemaFailure(error, traceId);
    }

    const call = { tool: toolName, arguments: arguments_ };
    const context = await this.options.policyContext(call);
    const decision = evaluatePolicy(
      this.options.mandate,
      { tool: toolName, amount_paise: arguments_.amount as number },
      context
    );
    const commonAudit = {
      trace_id: traceId,
      mandate_id: this.options.mandate.mandate_id,
      mandate_version: this.options.mandate.version,
      tool: toolName,
      args_digest: argumentsDigest(arguments_),
      verdict: decision.verdict,
      rule_id: decision.rule_id,
      quote: decision.quote,
      counterfactual: {
        endpoint: endpoint(toolName, arguments_),
        amount_paise: arguments_.amount as number,
        class: toolClass(toolName)
      }
    };

    if (decision.verdict !== "ALLOW") {
      const auditType = {
        BLOCK: "TOOL_BLOCKED",
        HOLD_FOR_APPROVAL: "TOOL_HELD",
        ABSTAIN: "TOOL_ABSTAINED"
      }[decision.verdict];
      this.options.auditStore?.append(auditType, commonAudit);
      return decisionResult(decision, traceId);
    }

    this.options.auditStore?.append("TOOL_ALLOWED", commonAudit);
    try {
      const { idempotency_key: idempotencyKey, ...upstreamArguments } = arguments_;
      if (this.options.executor) {
        const execution = await this.options.executor.execute({
          tool: toolName,
          arguments: upstreamArguments,
          amountPaise: arguments_.amount as number,
          ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {})
        });
        if ("result" in execution && execution.result && execution.status !== "IN_DOUBT") {
          return sanitizeToolResult(execution.result, this.options.sensitiveValues);
        }
        return executorStateResult(execution);
      }

      const upstreamResult = sanitizeToolResult(
        await this.options.upstream.callTool(toolName, upstreamArguments),
        this.options.sensitiveValues
      );
      this.options.auditStore?.append(
        upstreamResult.isError ? "TOOL_UNVERIFIED" : "TOOL_EXECUTED",
        {
          ...commonAudit,
          upstream_error: upstreamResult.isError === true
        }
      );
      return upstreamResult;
    } catch (error) {
      const message = sanitizedErrorMessage(error, this.options.sensitiveValues);
      this.options.auditStore?.append("TOOL_UNVERIFIED", {
        ...commonAudit,
        upstream_error: true,
        error: message
      });
      return {
        content: [{ type: "text", text: `Razorpay upstream error: ${message}` }],
        isError: true
      };
    }
  }
}
