import type { LabTool, LabVerdict, ProviderState } from "./schema.js";

export type LabDispatchState = "NONE" | "RESERVED" | "IN_DOUBT" | "COMMITTED" | "RELEASED";

export interface LabToolRequest {
  idempotencyKey: string;
  tool: LabTool;
  amountPaise: number;
  currency: "INR";
}

export interface LabIntentState {
  intentId: string;
  request: LabToolRequest | null;
  requestCount: number;
  verdict: LabVerdict | null;
  ruleId: string | null;
  dispatchState: LabDispatchState;
  dispatchClaimed: boolean;
  claimedMandateVersion: number | null;
  mutationAttemptIds: string[];
  providerEffectIds: string[];
  budgetCharged: boolean;
  moneyState: ProviderState | "none";
  moneyRank: number;
  terminalTransitions: number;
  terminalEvidenceEventId: string | null;
  evidenceEventIds: string[];
}

export interface ProviderEffect {
  effectId: string;
  intentId: string;
  tool: LabTool | null;
  state: ProviderState;
  stateRank: number;
}

export interface LabProviderState {
  mutationAttemptIds: string[];
  effects: Record<string, ProviderEffect>;
  idempotencyEffects: Record<string, string>;
  rejectedIntentIds: string[];
}

export interface LabState {
  schemaVersion: 1;
  clockMs: number;
  sequence: number;
  authority: {
    revoked: boolean;
    revokedAtSequence: number | null;
    mandateVersion: number | null;
    revokedThroughVersion: number;
  };
  process: {
    running: boolean;
    crashCount: number;
    restartCount: number;
  };
  intents: Record<string, LabIntentState>;
  provider: LabProviderState;
  seenWebhookDeliveries: string[];
  appliedEventIds: string[];
}

export function initialLabState(initialTimeMs: number): LabState {
  return {
    schemaVersion: 1,
    clockMs: initialTimeMs,
    sequence: 0,
    authority: {
      revoked: false,
      revokedAtSequence: null,
      mandateVersion: null,
      revokedThroughVersion: 0
    },
    process: {
      running: true,
      crashCount: 0,
      restartCount: 0
    },
    intents: {},
    provider: {
      mutationAttemptIds: [],
      effects: {},
      idempotencyEffects: {},
      rejectedIntentIds: []
    },
    seenWebhookDeliveries: [],
    appliedEventIds: []
  };
}

export function emptyIntent(intentId: string): LabIntentState {
  return {
    intentId,
    request: null,
    requestCount: 0,
    verdict: null,
    ruleId: null,
    dispatchState: "NONE",
    dispatchClaimed: false,
    claimedMandateVersion: null,
    mutationAttemptIds: [],
    providerEffectIds: [],
    budgetCharged: false,
    moneyState: "none",
    moneyRank: 0,
    terminalTransitions: 0,
    terminalEvidenceEventId: null,
    evidenceEventIds: []
  };
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

export function normalizeLabState(state: LabState): LabState {
  const normalized = structuredClone(state);
  normalized.intents = sortedRecord(
    Object.fromEntries(
      Object.entries(normalized.intents).map(([key, intent]) => [
        key,
        {
          ...intent,
          mutationAttemptIds: [...intent.mutationAttemptIds].sort(),
          providerEffectIds: [...intent.providerEffectIds].sort()
        }
      ])
    )
  );
  normalized.provider.effects = sortedRecord(normalized.provider.effects);
  normalized.provider.idempotencyEffects = sortedRecord(normalized.provider.idempotencyEffects);
  normalized.provider.mutationAttemptIds.sort();
  normalized.provider.rejectedIntentIds.sort();
  normalized.seenWebhookDeliveries.sort();
  return normalized;
}
