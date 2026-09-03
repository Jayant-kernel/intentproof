export type DispatchState = "RESERVED" | "COMMITTED" | "RELEASED" | "IN_DOUBT";

export type CorrelationType = "receipt" | "reference_id" | "payment_id";

export interface DispatchRecord {
  idempotencyKey: string;
  tool: string;
  state: DispatchState;
  amountPaise: number;
  mandateId: string;
  mandateVersion: number;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  dispatchStartedAt: string | null;
  upstreamStatus: string | null;
  requestFingerprint: string | null;
  correlationType: CorrelationType | null;
  correlationValue: string | null;
  upstreamEntityId: string | null;
  reconcileLeaseOwner: string | null;
  reconcileLeaseUntil: string | null;
  reconcileAttempts: number;
  lastReconcileAt: string | null;
  nextReconcileAt: string | null;
  escalatedAt: string | null;
}

export interface ReserveDispatchInput {
  idempotencyKey: string;
  tool: string;
  amountPaise: number;
  mandateId: string;
  mandateVersion: number;
  agentId: string;
  now: string;
  windowStart: string;
  maxTotalPaise: number;
  maxCalls: number;
  requestFingerprint: string;
  correlationType: CorrelationType;
  correlationValue: string;
}

export type ReserveDispatchResult =
  | { status: "reserved"; dispatch: DispatchRecord }
  | { status: "existing"; dispatch: DispatchRecord }
  | { status: "idempotency_conflict"; dispatch: DispatchRecord }
  | { status: "correlation_conflict"; dispatch: DispatchRecord }
  | {
      status: "budget_exceeded";
      ruleId: "BUDGET_CALLS" | "BUDGET_VALUE";
      rollingCalls: number;
      rollingValuePaise: number;
    };

export type ClaimDispatchResult =
  | { status: "claimed"; dispatch: DispatchRecord }
  | { status: "existing"; dispatch: DispatchRecord }
  | {
      status: "blocked";
      reason: "KILL_SWITCH" | "MANDATE_VERSION" | "RUNTIME_STATE_MISSING" | "RESERVATION_MISSING";
      dispatch?: DispatchRecord;
    };

export interface BudgetUsage {
  calls: number;
  valuePaise: number;
}

export type ReconcileLeaseResult =
  | { status: "acquired"; dispatch: DispatchRecord }
  | { status: "not_found" }
  | { status: "not_due" | "lease_held" | "terminal"; dispatch: DispatchRecord };

export interface RecoveryResult {
  releasedNeverSent: number;
  markedInDoubt: number;
}
