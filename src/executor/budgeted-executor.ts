import { createHash } from "node:crypto";

import { canonicalJson } from "../ledger/canonical.js";
import type { CorrelationType, DispatchRecord } from "../budget/types.js";
import type { AuditStore } from "../ledger/audit-store.js";
import type {
  ExecuteMutationInput,
  ExecuteMutationResult,
  MutationDispatcher,
  ToolExecutor,
  UncertainDispatchReconciler
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
  reconciler?: UncertainDispatchReconciler;
}

interface PreparedMutation {
  arguments: Record<string, unknown>;
  correlationType: CorrelationType;
  correlationValue: string;
  requestFingerprint: string;
}

function generatedCorrelation(idempotencyKey: string): string {
  return `ip_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

export function prepareMutation(
  tool: string,
  arguments_: Record<string, unknown>,
  amountPaise: number,
  idempotencyKey: string
): PreparedMutation {
  let correlationType: CorrelationType;
  let correlationValue: string;
  if (tool === "create_order") {
    correlationType = "receipt";
    if (Object.hasOwn(arguments_, "receipt") && typeof arguments_.receipt !== "string") {
      throw new Error("caller-provided receipt must be a string");
    }
    correlationValue =
      typeof arguments_.receipt === "string"
        ? arguments_.receipt
        : generatedCorrelation(idempotencyKey);
  } else if (tool === "create_payment_link") {
    correlationType = "reference_id";
    if (Object.hasOwn(arguments_, "reference_id") && typeof arguments_.reference_id !== "string") {
      throw new Error("caller-provided reference_id must be a string");
    }
    correlationValue =
      typeof arguments_.reference_id === "string"
        ? arguments_.reference_id
        : generatedCorrelation(idempotencyKey);
  } else if (tool === "capture_payment") {
    correlationType = "payment_id";
    if (typeof arguments_.payment_id !== "string") {
      throw new Error("capture_payment requires a payment_id correlation");
    }
    correlationValue = arguments_.payment_id;
  } else {
    throw new Error(`Unsupported mutation tool: ${tool}`);
  }

  if (correlationValue.length < 1 || correlationValue.length > 40) {
    throw new Error(`${correlationType} must be between 1 and 40 characters`);
  }
  const preparedArguments = { ...arguments_, [correlationType]: correlationValue };
  const requestFingerprint = `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        tool,
        amount_paise: amountPaise,
        currency: preparedArguments.currency ?? null,
        arguments: preparedArguments
      })
    )
    .digest("hex")}`;
  return {
    arguments: preparedArguments,
    correlationType,
    correlationValue,
    requestFingerprint
  };
}

function persistedArguments(
  dispatch: DispatchRecord,
  original: Record<string, unknown>
): Record<string, unknown> {
  if (dispatch.correlationType === null || dispatch.correlationValue === null) {
    throw new Error("Reserved dispatch is missing durable correlation");
  }
  return { ...original, [dispatch.correlationType]: dispatch.correlationValue };
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
    const prepared = prepareMutation(input.tool, input.arguments, input.amountPaise, idempotencyKey);
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
      maxCalls: this.options.maxCalls,
      requestFingerprint: prepared.requestFingerprint,
      correlationType: prepared.correlationType,
      correlationValue: prepared.correlationValue
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
      const status =
        reservation.dispatch.state === "IN_DOUBT" && this.options.reconciler
          ? (await this.options.reconciler.reconcile(idempotencyKey)).status
          : reservation.dispatch.state;
      return {
        status,
        idempotencyKey,
        replayed: true
      };
    }
    if (reservation.status === "idempotency_conflict") {
      return {
        status: "BLOCKED",
        idempotencyKey,
        replayed: true,
        ruleId: "SYSTEM_IDEMPOTENCY_CONFLICT",
        message: "idempotency key was already used for a different mutation request"
      };
    }
    if (reservation.status === "correlation_conflict") {
      return {
        status: "BLOCKED",
        idempotencyKey,
        replayed: false,
        ruleId: "SYSTEM_CORRELATION_CONFLICT",
        message: "mutation correlation is already assigned to another request"
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
      const dispatchArguments = persistedArguments(claim.dispatch, prepared.arguments);
      const outcome = await this.options.dispatcher.dispatch(input.tool, dispatchArguments);
      const settledAt = this.clock().toISOString();
      if (outcome.kind === "CONFIRMED_SUCCESS") {
        const settled = this.options.store.settleDispatch(
          idempotencyKey,
          "COMMITTED",
          "confirmed_success",
          settledAt,
          outcome.upstreamEntityId
        );
        return {
          status: settled.state,
          idempotencyKey,
          replayed: false,
          result: outcome.result
        };
      }
      if (outcome.kind === "DEFINITIVE_FAILURE") {
        const settled = this.options.store.settleDispatch(
          idempotencyKey,
          "RELEASED",
          "definitive_failure",
          settledAt
        );
        return {
          status: settled.state,
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
      const reconciled = this.options.reconciler
        ? await this.options.reconciler.reconcile(idempotencyKey)
        : { status: "IN_DOUBT" as const };
      return {
        status: reconciled.status,
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
      const reconciled = this.options.reconciler
        ? await this.options.reconciler.reconcile(idempotencyKey)
        : { status: "IN_DOUBT" as const };
      return { status: reconciled.status, idempotencyKey, replayed: false };
    }
  }
}
