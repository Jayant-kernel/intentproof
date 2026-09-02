export type DispatchState = "RESERVED" | "COMMITTED" | "RELEASED" | "IN_DOUBT";

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
}

export type ReserveDispatchResult =
  | { status: "reserved"; dispatch: DispatchRecord }
  | { status: "existing"; dispatch: DispatchRecord }
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
