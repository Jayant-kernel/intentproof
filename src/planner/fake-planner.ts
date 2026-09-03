import { createHash } from "node:crypto";

import type { PlannerPrompt, PlannerProvider } from "./planner.js";
import type { PlannerProposal } from "./schema.js";

function objectiveFromPrompt(prompt: PlannerPrompt): string {
  return /OBJECTIVE_BEGIN\n([\s\S]*)\nOBJECTIVE_END/u.exec(prompt.user)?.[1]?.trim() ?? "";
}

function proposalId(objective: string): string {
  return `int_${createHash("sha256").update(objective).digest("hex").slice(0, 16)}`;
}

export class DeterministicFakePlanner implements PlannerProvider {
  readonly providerName = "deterministic_fake";
  readonly modelName = "bounded-demo-planner-v1";

  async generate(prompt: PlannerPrompt): Promise<string> {
    const objective = objectiveFromPrompt(prompt);
    const intent_id = proposalId(objective);
    let proposal: PlannerProposal;

    const order = /(?:create|place|buy).*?order.*?([\d,]+)\s*paise/iu.exec(objective);
    const paymentLink = /(?:create|send).*?payment link.*?([\d,]+)\s*paise/iu.exec(objective);
    const capture = /capture.*?([\d,]+)\s*paise/iu.exec(objective);

    if (/\b(?:refund|payout|direct razorpay|bypass|ignore (?:the |all )?(?:rules|instructions))\b/iu.test(objective)) {
      proposal = {
        tool: "no_action",
        arguments: {},
        intent_id,
        explanation: "The objective is outside the constrained planner surface."
      };
    } else if (paymentLink?.[1]) {
      proposal = {
        tool: "create_payment_link",
        arguments: {
          amount: Number(paymentLink[1].replaceAll(",", "")),
          currency: "INR"
        },
        intent_id,
        explanation: "Propose a payment link for deterministic policy review."
      };
    } else if (capture?.[1]) {
      proposal = {
        tool: "capture_payment",
        arguments: {
          payment_id: `pay_synthetic${createHash("sha256").update(objective).digest("hex").slice(0, 8)}`,
          amount: Number(capture[1].replaceAll(",", "")),
          currency: "INR"
        },
        intent_id,
        explanation: "Propose capture for deterministic delivery and approval checks."
      };
    } else if (order?.[1]) {
      proposal = {
        tool: "create_order",
        arguments: {
          amount: Number(order[1].replaceAll(",", "")),
          currency: "INR"
        },
        intent_id,
        explanation: "Propose an order for deterministic policy review."
      };
    } else {
      proposal = {
        tool: "no_action",
        arguments: {},
        intent_id,
        explanation: "The objective does not map unambiguously to a supported action."
      };
    }
    return JSON.stringify(proposal);
  }
}

export class StaticFakePlanner implements PlannerProvider {
  readonly providerName = "static_fake";
  readonly modelName = "test-response-v1";

  constructor(
    private readonly response: string | Error,
    readonly onPrompt?: (prompt: PlannerPrompt) => void
  ) {}

  async generate(prompt: PlannerPrompt): Promise<string> {
    this.onPrompt?.(prompt);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}
