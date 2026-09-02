import type { Constraint, Mandate } from "../mandate/schema.js";
import { isWithinWindow } from "./time-window.js";
import type { PolicyContext, PolicyDecision, PolicyRequest, VerdictName } from "./types.js";

function decision(
  verdict: VerdictName,
  ruleId: string | null,
  quote: string | null,
  message: string,
  observed?: string
): PolicyDecision {
  return { verdict, rule_id: ruleId, quote, message, ...(observed ? { observed } : {}) };
}

export function evaluatePolicy(
  mandate: Mandate,
  request: PolicyRequest,
  context: PolicyContext
): PolicyDecision {
  if (context.killSwitch) {
    return decision("BLOCK", "SYSTEM_KILL_SWITCH", null, "merchant kill switch is engaged");
  }

  if (mandate.revoked) {
    return decision("BLOCK", "SYSTEM_MANDATE_REVOKED", null, "mandate is revoked");
  }

  if (mandate.version !== context.expectedMandateVersion) {
    return decision(
      "BLOCK",
      "SYSTEM_MANDATE_VERSION",
      null,
      "mandate version is not current",
      `expected=${context.expectedMandateVersion}, observed=${mandate.version}`
    );
  }

  const timeWindow = mandate.constraints.find((constraint) => constraint.rule === "time_window");
  if (timeWindow && !isWithinWindow(context.now, timeWindow.timezone, timeWindow.allowed)) {
    return decision("BLOCK", timeWindow.id, timeWindow.quote, "action is outside the allowed time window");
  }

  const allowlist = mandate.constraints.find((constraint) => constraint.rule === "tool_allowlist");
  if (!allowlist || !allowlist.tools.includes(request.tool)) {
    return decision(
      "BLOCK",
      allowlist?.id ?? "SYSTEM_TOOL_ALLOWLIST",
      allowlist?.quote ?? null,
      `${request.tool} is outside the approved tool allowlist`
    );
  }

  if (request.amount_paise !== undefined && !Number.isSafeInteger(request.amount_paise)) {
    return decision("ABSTAIN", "SYSTEM_AMOUNT_FORMAT", null, "amount must be integer paise");
  }

  const ceiling = mandate.constraints.find(
    (constraint): constraint is Extract<Constraint, { rule: "amount_ceiling" }> =>
      constraint.rule === "amount_ceiling" && constraint.tool === request.tool
  );
  if (ceiling) {
    if (request.amount_paise === undefined) {
      return decision("ABSTAIN", ceiling.id, ceiling.quote, "amount evidence is missing");
    }
    if (request.amount_paise > ceiling.max_paise) {
      return decision(
        "BLOCK",
        ceiling.id,
        ceiling.quote,
        "requested amount exceeds the per-call ceiling",
        `limit=${ceiling.max_paise}, observed=${request.amount_paise}`
      );
    }
  }

  const budget = mandate.budgets[0];
  const actionValue = request.amount_paise ?? 0;
  if (budget) {
    if (context.rollingCalls + 1 > budget.max_calls) {
      return decision("BLOCK", "BUDGET_CALLS", budget.quote, "rolling call budget is exhausted");
    }
    if (context.rollingValuePaise + actionValue > budget.max_total_paise) {
      return decision("BLOCK", "BUDGET_VALUE", budget.quote, "rolling value budget is exhausted");
    }
  }

  const precondition = mandate.constraints.find(
    (constraint): constraint is Extract<Constraint, { rule: "precondition" }> =>
      constraint.rule === "precondition" && constraint.tool === request.tool
  );
  if (precondition) {
    if (context.deliveryConfirmed === undefined) {
      return decision(
        "ABSTAIN",
        precondition.id,
        precondition.quote,
        "delivery confirmation is unavailable"
      );
    }
    if (!context.deliveryConfirmed) {
      return decision(
        "BLOCK",
        precondition.id,
        precondition.quote,
        "capture requires delivery confirmation",
        "delivery_confirmed=false"
      );
    }
  }

  const approval = mandate.constraints.find(
    (constraint): constraint is Extract<Constraint, { rule: "approval_gate" }> =>
      constraint.rule === "approval_gate" && constraint.tool === request.tool
  );
  if (
    approval &&
    request.amount_paise !== undefined &&
    request.amount_paise > approval.above_paise &&
    context.approvalGranted !== true
  ) {
    return decision(
      "HOLD_FOR_APPROVAL",
      approval.id,
      approval.quote,
      "merchant approval is required above the configured threshold"
    );
  }

  return decision("ALLOW", null, null, "all active policy checks passed");
}
