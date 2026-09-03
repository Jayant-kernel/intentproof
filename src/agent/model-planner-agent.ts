import { parseGatewayArguments } from "../gateway/schemas.js";
import { planObjective, PlannerError, type PlannerProvider } from "../planner/planner.js";

export interface PlannerGateway {
  callTool(toolName: string, rawArguments: unknown): Promise<unknown>;
}

export interface PlannerAgentOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type PlannerAgentResult =
  | {
      status: "PLANNER_REJECTED";
      error_code: PlannerError["code"];
      message: string;
    }
  | {
      status: "NO_ACTION";
      proposal: { tool: "no_action"; intent_id: string; explanation: string };
    }
  | {
      status: "GATEWAY_RESULT";
      proposal: {
        tool: "create_order" | "create_payment_link" | "capture_payment";
        intent_id: string;
        explanation: string;
      };
      gateway_result: unknown;
    };

export class ModelPlannerAgent {
  constructor(
    private readonly provider: PlannerProvider,
    private readonly gateway: PlannerGateway,
    private readonly options: PlannerAgentOptions = {}
  ) {}

  async pursue(objective: string): Promise<PlannerAgentResult> {
    let proposal;
    try {
      proposal = await planObjective({
        objective,
        provider: this.provider,
        ...this.options
      });
    } catch (error) {
      if (!(error instanceof PlannerError)) throw error;
      return {
        status: "PLANNER_REJECTED",
        error_code: error.code,
        message: error.message
      };
    }

    if (proposal.tool === "no_action") {
      return {
        status: "NO_ACTION",
        proposal: {
          tool: proposal.tool,
          intent_id: proposal.intent_id,
          explanation: proposal.explanation
        }
      };
    }

    const call = {
      tool: proposal.tool,
      arguments: parseGatewayArguments(proposal.tool, {
        ...proposal.arguments,
        idempotency_key: `planner:${proposal.intent_id}`
      })
    };
    return {
      status: "GATEWAY_RESULT",
      proposal: {
        tool: proposal.tool,
        intent_id: proposal.intent_id,
        explanation: proposal.explanation
      },
      gateway_result: await this.gateway.callTool(call.tool, call.arguments)
    };
  }
}
