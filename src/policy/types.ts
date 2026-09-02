import type { SupportedTool } from "../mandate/schema.js";

export type VerdictName = "ALLOW" | "BLOCK" | "HOLD_FOR_APPROVAL" | "ABSTAIN";

export interface PolicyRequest {
  tool: SupportedTool;
  amount_paise?: number;
}

export interface PolicyContext {
  now: Date;
  killSwitch: boolean;
  expectedMandateVersion: number;
  rollingCalls: number;
  rollingValuePaise: number;
  deliveryConfirmed?: boolean;
  approvalGranted?: boolean;
}

export interface PolicyDecision {
  verdict: VerdictName;
  rule_id: string | null;
  quote: string | null;
  message: string;
  observed?: string;
}
