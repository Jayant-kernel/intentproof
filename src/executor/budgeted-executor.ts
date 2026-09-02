import { createHash } from "node:crypto";

import { canonicalJson } from "../ledger/canonical.js";
import type { AuditStore } from "../ledger/audit-store.js";
import type {
  ExecuteMutationInput,
  ExecuteMutationResult,
  MutationDispatcher,
  ToolExecutor
} from "./types.js";

const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1_000;
const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface BudgetedExecutorOptions {
  store: AuditStore;
  dispatcher: MutationDispatcher;
  mandateId: string;
  mandateVersion: number;
  agentId: string;
  maxTotalPaise: number;
  maxCalls: number;
  clock?: () => Date;
  beforeDispatch?: () => void | Promise<void>;
}

export function deriveIdempotencyKey(input: {
  mandateId: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  now: Date;
}): string {
  const logicalWindow = Math.floor(input.now.getTime() / IDEMPOTENCY_WINDOW_MS);
  const material = canonicalJson({
    mandate_id: input.mandateId,
    agent_id: input.agentId,
    tool: input.tool,
    arguments: input.arguments,
    logical_window: logicalWindow
  });
  return `ip_${createHash("sha256").update(material).digest("hex")}`;
}

export class BudgetedExecutor implements ToolExecutor {
  private readonly clock: () => Date;

  constructor(private readonly options: BudgetedExecutorOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async execute(input: ExecuteMutationInput): Promise<ExecuteMutationResult> {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < 0) {
      throw new Error("Executor amount must be non-negative integer paise");
    }

    const now = this.clock();
    const idempotencyKey =
      input.idempotencyKey ??
      deriveIdempotencyKey({
        mandateId: this.options.mandateId,
        agentId: this.options.agentId,
        tool: input.tool,
        arguments: input.arguments,
        now
      });
    const reservation = this.options.store.reserveDispatch({
      idempotencyKey,
      tool: input.tool,
      amountPaise: input.amountPaise,
      mandateId: this.options.mandateId,
      mandateVersion: this.options.mandateVersion,
      agentId: this.options.agentId,
      now: now.toISOString(),
      windowStart: new Date(now.getTime() - BUDGET_WINDOW_MS).toISOString(),
      maxTotalPaise: this.options.maxTotalPaise,
      maxCalls: this.options.maxCalls
    });

    if (reservation.status === "budget_exceeded") {
      return {
        status: "BLOCKED",
        idempotencyKey,
        replayed: false,
        ruleId: reservation.ruleId,
        message:
          reservation.ruleId === "BUDGET_CALLS"
            ? "rolling call budget is exhausted"
            : "rolling value budget is exhausted"
      };
    }
    if (reservation.status === "existing") {
      return {
        status: reservation.dispatch.state,
        idempotencyKey,
        replayed: true
      };
    }

    await this.options.beforeDispatch?.();
    const claimTime = this.clock().toISOString();
    const claim = this.options.store.claimDispatch(
      idempotencyKey,
      this.options.mandateVersion,
      claimTime
    );
    if (claim.status === "blocked") {
      const ruleId =
        claim.reason === "KILL_SWITCH"
          ? "SYSTEM_KILL_SWITCH"
          : claim.reason === "MANDATE_VERSION"
            ? "SYSTEM_MANDATE_VERSION"
            : "SYSTEM_DISPATCH_STATE";
      return {
        status: "BLOCKED",
        idempotencyKey,
        replayed: false,
        ruleId,
        message: `dispatch blocked during final recheck: ${claim.reason.toLowerCase()}`
      };
    }
    if (claim.status === "existing") {
      return {
        status: claim.dispatch.state,
        idempotencyKey,
        replayed: true
      };
    }

    try {
      const outcome = await this.options.dispatcher.dispatch(input.tool, input.arguments);
      const settledAt = this.clock().toISOString();
      if (outcome.kind === "CONFIRMED_SUCCESS") {
        this.options.store.settleDispatch(
          idempotencyKey,
          "COMMITTED",
          "confirmed_success",
          settledAt
        );
        return {
          status: "COMMITTED",
          idempotencyKey,
          replayed: false,
          result: outcome.result
        };
      }
      if (outcome.kind === "DEFINITIVE_FAILURE") {
        this.options.store.settleDispatch(
          idempotencyKey,
          "RELEASED",
          "definitive_failure",
          settledAt
        );
        return {
          status: "RELEASED",
          idempotencyKey,
          replayed: false,
          result: outcome.result
        };
      }

      this.options.store.settleDispatch(
        idempotencyKey,
        "IN_DOUBT",
        "indeterminate_result",
        settledAt
      );
      return {
        status: "IN_DOUBT",
        idempotencyKey,
        replayed: false,
        ...(outcome.result ? { result: outcome.result } : {})
      };
    } catch {
      this.options.store.settleDispatch(
        idempotencyKey,
        "IN_DOUBT",
        "transport_exception",
        this.clock().toISOString()
      );
      return { status: "IN_DOUBT", idempotencyKey, replayed: false };
    }
  }
}
