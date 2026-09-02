import type { CallToolResult } from "@modelcontextprotocol/client";

import type { DispatchState } from "../budget/types.js";

export type MutationDispatchOutcome =
  | { kind: "CONFIRMED_SUCCESS"; result: CallToolResult }
  | { kind: "DEFINITIVE_FAILURE"; result: CallToolResult }
  | { kind: "INDETERMINATE"; result?: CallToolResult };

export interface MutationDispatcher {
  dispatch(tool: string, arguments_: Record<string, unknown>): Promise<MutationDispatchOutcome>;
}

export interface ExecuteMutationInput {
  tool: string;
  arguments: Record<string, unknown>;
  amountPaise: number;
  idempotencyKey?: string;
}

export type ExecuteMutationResult =
  | {
      status: DispatchState;
      idempotencyKey: string;
      replayed: boolean;
      result?: CallToolResult;
    }
  | {
      status: "BLOCKED";
      idempotencyKey: string;
      replayed: boolean;
      ruleId: string;
      message: string;
    };

export interface ToolExecutor {
  execute(input: ExecuteMutationInput): Promise<ExecuteMutationResult>;
}
