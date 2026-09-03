import {
  providerStateRank,
  recordProviderAcceptance,
  recordProviderMutation,
  recordProviderRejection
} from "./provider-model.js";
import type { LabEvent } from "./schema.js";
import { emptyIntent, type LabDispatchState, type LabIntentState, type LabState } from "./state.js";

function isTerminal(state: LabDispatchState): boolean {
  return state === "COMMITTED" || state === "RELEASED";
}

function intentFor(state: LabState, intentId: string): LabIntentState {
  state.intents[intentId] ??= emptyIntent(intentId);
  return state.intents[intentId];
}

function addEvidence(intent: LabIntentState, eventId: string): void {
  if (!intent.evidenceEventIds.includes(eventId)) intent.evidenceEventIds.push(eventId);
}

function settle(
  intent: LabIntentState,
  target: "COMMITTED" | "RELEASED",
  evidenceEventId: string
): void {
  if (isTerminal(intent.dispatchState)) return;
  intent.dispatchState = target;
  intent.budgetCharged = target === "COMMITTED";
  intent.terminalTransitions += 1;
  intent.terminalEvidenceEventId = evidenceEventId;
  addEvidence(intent, evidenceEventId);
}

function observeMoney(intent: LabIntentState, providerState: LabEvent & { provider_state: unknown }): void {
  const state = providerState.provider_state;
  if (
    state !== "created" &&
    state !== "authorized" &&
    state !== "captured" &&
    state !== "refunded" &&
    state !== "failed"
  ) {
    return;
  }
  const rank = providerStateRank(state);
  if (rank >= intent.moneyRank) {
    intent.moneyRank = rank;
    intent.moneyState = state;
  }
}

export function reduceLabState(current: LabState, event: LabEvent): LabState {
  const state = structuredClone(current);
  if (state.appliedEventIds.includes(event.event_id)) return state;
  state.clockMs = event.at_ms;
  state.sequence += 1;
  state.appliedEventIds.push(event.event_id);

  switch (event.type) {
    case "AGENT_TOOL_REQUESTED": {
      const intent = intentFor(state, event.intent_id);
      intent.requestCount += 1;
      intent.request ??= {
        idempotencyKey: event.idempotency_key,
        tool: event.tool,
        amountPaise: event.amount_paise,
        currency: event.currency
      };
      addEvidence(intent, event.event_id);
      break;
    }
    case "POLICY_DECIDED": {
      const intent = intentFor(state, event.intent_id);
      intent.verdict = event.verdict;
      intent.ruleId = event.rule_id;
      addEvidence(intent, event.event_id);
      break;
    }
    case "BUDGET_RESERVED": {
      const intent = intentFor(state, event.intent_id);
      if (!isTerminal(intent.dispatchState)) {
        intent.dispatchState = "RESERVED";
        intent.budgetCharged = true;
      }
      addEvidence(intent, event.event_id);
      break;
    }
    case "DISPATCH_CLAIMED": {
      const intent = intentFor(state, event.intent_id);
      intent.dispatchClaimed = true;
      intent.claimedMandateVersion = event.mandate_version;
      addEvidence(intent, event.event_id);
      break;
    }
    case "PROVIDER_MUTATION_SENT": {
      const intent = intentFor(state, event.intent_id);
      state.provider = recordProviderMutation(state.provider, intent, event.attempt_id);
      addEvidence(intent, event.event_id);
      break;
    }
    case "PROVIDER_ACCEPTED": {
      const intent = intentFor(state, event.intent_id);
      state.provider = recordProviderAcceptance(
        state.provider,
        intent,
        event.effect_id,
        event.provider_state
      );
      observeMoney(intent, event);
      addEvidence(intent, event.event_id);
      break;
    }
    case "PROVIDER_REJECTED": {
      const intent = intentFor(state, event.intent_id);
      state.provider = recordProviderRejection(state.provider, event.intent_id);
      settle(intent, "RELEASED", event.event_id);
      break;
    }
    case "TIMEOUT_OBSERVED": {
      const intent = intentFor(state, event.intent_id);
      if (!isTerminal(intent.dispatchState)) {
        intent.dispatchState = "IN_DOUBT";
        intent.budgetCharged = true;
      }
      addEvidence(intent, event.event_id);
      break;
    }
    case "PROCESS_CRASHED": {
      state.process.running = false;
      state.process.crashCount += 1;
      break;
    }
    case "PROCESS_RESTARTED": {
      state.process.running = true;
      state.process.restartCount += 1;
      for (const intent of Object.values(state.intents)) {
        if (intent.dispatchState !== "RESERVED") continue;
        if (intent.dispatchClaimed) {
          intent.dispatchState = "IN_DOUBT";
          intent.budgetCharged = true;
          addEvidence(intent, event.event_id);
        } else {
          settle(intent, "RELEASED", event.event_id);
        }
      }
      break;
    }
    case "WEBHOOK_DELIVERED": {
      if (state.seenWebhookDeliveries.includes(event.delivery_id)) break;
      state.seenWebhookDeliveries.push(event.delivery_id);
      const intent = intentFor(state, event.intent_id);
      state.provider = recordProviderAcceptance(
        state.provider,
        intent,
        event.effect_id,
        event.provider_state
      );
      observeMoney(intent, event);
      addEvidence(intent, event.event_id);
      if (event.provider_state === "captured" || event.provider_state === "refunded") {
        settle(intent, "COMMITTED", event.event_id);
      }
      break;
    }
    case "RECONCILIATION_READ": {
      const intent = intentFor(state, event.intent_id);
      addEvidence(intent, event.event_id);
      if (event.outcome === "MATCHED_COMMITTED") {
        if (event.effect_id) {
          state.provider = recordProviderAcceptance(
            state.provider,
            intent,
            event.effect_id,
            intent.request?.tool === "capture_payment" ? "captured" : "created"
          );
        }
        settle(intent, "COMMITTED", event.event_id);
      } else if (
        event.outcome === "MATCHED_FAILED" &&
        intent.request?.tool === "capture_payment"
      ) {
        settle(intent, "RELEASED", event.event_id);
      } else if (!isTerminal(intent.dispatchState)) {
        intent.dispatchState = "IN_DOUBT";
        intent.budgetCharged = true;
      }
      break;
    }
    case "AUTHORITY_REVOKED": {
      state.authority.revoked = true;
      state.authority.revokedAtSequence = state.sequence;
      state.authority.mandateVersion = event.mandate_version;
      state.authority.revokedThroughVersion = Math.max(
        state.authority.revokedThroughVersion,
        event.mandate_version
      );
      break;
    }
    case "OPERATOR_DECIDED": {
      const intent = intentFor(state, event.intent_id);
      addEvidence(intent, event.event_id);
      if (event.decision === "COMMIT") settle(intent, "COMMITTED", event.event_id);
      else if (event.decision === "RELEASE") settle(intent, "RELEASED", event.event_id);
      else if (!isTerminal(intent.dispatchState)) {
        intent.dispatchState = "IN_DOUBT";
        intent.budgetCharged = true;
      }
      break;
    }
  }
  return state;
}
