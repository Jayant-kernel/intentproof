import type { LabIntentState, LabProviderState } from "./state.js";
import type { ProviderState } from "./schema.js";

const stateRanks: Record<ProviderState, number> = {
  created: 1,
  authorized: 2,
  captured: 3,
  refunded: 4,
  failed: 1
};

export function providerStateRank(state: ProviderState): number {
  return stateRanks[state];
}

export function recordProviderMutation(
  provider: LabProviderState,
  intent: LabIntentState,
  attemptId: string
): LabProviderState {
  const next = structuredClone(provider);
  if (!next.mutationAttemptIds.includes(attemptId)) next.mutationAttemptIds.push(attemptId);
  if (!intent.mutationAttemptIds.includes(attemptId)) intent.mutationAttemptIds.push(attemptId);
  return next;
}

export function recordProviderAcceptance(
  provider: LabProviderState,
  intent: LabIntentState,
  effectId: string,
  state: ProviderState
): LabProviderState {
  const next = structuredClone(provider);
  const existing = next.effects[effectId];
  const rank = providerStateRank(state);
  if (!existing) {
    next.effects[effectId] = {
      effectId,
      intentId: intent.intentId,
      tool: intent.request?.tool ?? null,
      state,
      stateRank: rank
    };
  } else if (existing.intentId === intent.intentId && rank >= existing.stateRank) {
    existing.state = state;
    existing.stateRank = rank;
  }
  if (!intent.providerEffectIds.includes(effectId)) intent.providerEffectIds.push(effectId);
  return next;
}

export function recordProviderRejection(
  provider: LabProviderState,
  intentId: string
): LabProviderState {
  const next = structuredClone(provider);
  if (!next.rejectedIntentIds.includes(intentId)) next.rejectedIntentIds.push(intentId);
  return next;
}
