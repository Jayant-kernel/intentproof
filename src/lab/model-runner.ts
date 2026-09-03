import { createHash } from "node:crypto";

import { canonicalJson } from "../ledger/canonical.js";
import { evaluateLabInvariants, type InvariantResult, type LabTraceEntry } from "./invariants.js";
import type { LabModel } from "./exploration-schema.js";
import { reduceLabState } from "./reducer.js";
import type { LabEvent } from "./schema.js";
import { initialLabState, normalizeLabState, type LabIntentState, type LabState } from "./state.js";

export interface LabModelRun {
  model: LabModel;
  passed: boolean;
  stateHash: string;
  finalState: LabState;
  trace: LabTraceEntry[];
  invariants: InvariantResult[];
}

interface ModelContext {
  pendingProviderResponses: Map<string, string[]>;
}

function ignoredState(current: LabState, event: LabEvent): LabState {
  const state = structuredClone(current);
  state.clockMs = Math.max(state.clockMs, event.at_ms);
  return state;
}

function canClaim(intent: LabIntentState | undefined, state: LabState, version: number): boolean {
  return Boolean(
    intent &&
      state.process.running &&
      intent.verdict === "ALLOW" &&
      intent.dispatchState === "RESERVED" &&
      !intent.dispatchClaimed &&
      version > state.authority.revokedThroughVersion
  );
}

function canSend(intent: LabIntentState | undefined, state: LabState): boolean {
  return Boolean(
    intent &&
      state.process.running &&
      intent.verdict === "ALLOW" &&
      intent.dispatchState === "RESERVED" &&
      intent.dispatchClaimed &&
      intent.claimedMandateVersion !== null &&
      intent.claimedMandateVersion > state.authority.revokedThroughVersion &&
      intent.mutationAttemptIds.length === 0
  );
}

function applyIntentProofEvent(
  current: LabState,
  event: LabEvent,
  context: ModelContext
): { state: LabState; applied: boolean } {
  const intent = "intent_id" in event ? current.intents[event.intent_id] : undefined;
  if (
    event.type === "DISPATCH_CLAIMED" &&
    !canClaim(intent, current, event.mandate_version)
  ) {
    return { state: ignoredState(current, event), applied: false };
  }
  if (event.type === "PROVIDER_MUTATION_SENT") {
    if (!canSend(intent, current)) return { state: ignoredState(current, event), applied: false };
    const pending = context.pendingProviderResponses.get(event.intent_id) ?? [];
    context.pendingProviderResponses.set(event.intent_id, [...pending, event.attempt_id]);
  }
  if (event.type === "PROVIDER_ACCEPTED" || event.type === "PROVIDER_REJECTED") {
    const pending = context.pendingProviderResponses.get(event.intent_id) ?? [];
    const responseIndex =
      event.type === "PROVIDER_ACCEPTED" && event.attempt_id
        ? pending.indexOf(event.attempt_id)
        : 0;
    if (pending.length === 0 || responseIndex < 0) {
      return { state: ignoredState(current, event), applied: false };
    }
    context.pendingProviderResponses.set(
      event.intent_id,
      pending.filter((_, index) => index !== responseIndex)
    );
  }
  return { state: reduceLabState(current, event), applied: true };
}

function isSettlementEvent(event: LabEvent): boolean {
  return (
    (event.type === "WEBHOOK_DELIVERED" &&
      (event.provider_state === "captured" || event.provider_state === "refunded")) ||
    (event.type === "RECONCILIATION_READ" && event.outcome === "MATCHED_COMMITTED") ||
    (event.type === "OPERATOR_DECIDED" && event.decision !== "KEEP_IN_DOUBT")
  );
}

function applyUnsafeEvent(current: LabState, event: LabEvent): LabState {
  const intentBefore = "intent_id" in event ? current.intents[event.intent_id] : undefined;
  const wasTerminal =
    intentBefore?.dispatchState === "COMMITTED" || intentBefore?.dispatchState === "RELEASED";
  const state = reduceLabState(current, event);

  if (event.type === "TIMEOUT_OBSERVED") {
    const intent = state.intents[event.intent_id];
    if (intent) {
      intent.dispatchState = "RELEASED";
      intent.budgetCharged = false;
      intent.terminalTransitions += 1;
      intent.terminalEvidenceEventId = event.event_id;
    }
  }
  if (
    event.type === "RECONCILIATION_READ" &&
    (event.outcome === "EMPTY" || event.outcome === "MALFORMED")
  ) {
    const intent = state.intents[event.intent_id];
    if (intent) {
      intent.dispatchState = "RELEASED";
      intent.budgetCharged = false;
      intent.terminalTransitions += 1;
      intent.terminalEvidenceEventId = event.event_id;
    }
  }
  if (wasTerminal && isSettlementEvent(event) && "intent_id" in event) {
    const intent = state.intents[event.intent_id];
    if (intent) intent.terminalTransitions += 1;
  }
  return state;
}

export function hashLabState(state: LabState): string {
  return `sha256:${createHash("sha256").update(canonicalJson(normalizeLabState(state))).digest("hex")}`;
}

export function runLabEvents(
  events: readonly LabEvent[],
  model: LabModel,
  initialTimeMs = 0
): LabModelRun {
  let state = initialLabState(initialTimeMs);
  const trace: LabTraceEntry[] = [];
  const context: ModelContext = { pendingProviderResponses: new Map() };

  for (const event of events) {
    let applied = true;
    if (model === "intentproof") {
      const result = applyIntentProofEvent(state, event, context);
      state = result.state;
      applied = result.applied;
    } else {
      state = applyUnsafeEvent(state, event);
    }
    state = normalizeLabState(state);
    trace.push({
      sequence: trace.length + 1,
      event: structuredClone(event),
      state: structuredClone(state),
      applied
    });
  }

  const finalState = normalizeLabState(state);
  const invariants = evaluateLabInvariants(trace, finalState);
  return {
    model,
    passed: invariants.every((invariant) => invariant.passed),
    stateHash: hashLabState(finalState),
    finalState,
    trace,
    invariants
  };
}
