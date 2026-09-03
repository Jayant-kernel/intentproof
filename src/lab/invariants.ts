import type { LabEvent, LabVerdict } from "./schema.js";
import type { LabState } from "./state.js";

export interface LabTraceEntry {
  sequence: number;
  event: LabEvent;
  state: LabState;
}

export interface InvariantResult {
  id:
    | "DENIED_ZERO_MUTATIONS"
    | "ONE_INTENT_ONE_EFFECT"
    | "UNCERTAINTY_STAYS_CHARGED"
    | "COMMITTED_MONEY_MONOTONIC"
    | "REVOCATION_STOPS_DISPATCH"
    | "RACING_SETTLEMENT_ONCE"
    | "TERMINAL_EVIDENCE_RECONSTRUCTABLE";
  passed: boolean;
  violations: string[];
}

const nonAllow = new Set<LabVerdict>(["BLOCK", "HOLD_FOR_APPROVAL", "ABSTAIN"]);

function deniedMutationViolations(trace: readonly LabTraceEntry[]): string[] {
  const verdicts = new Map<string, LabVerdict>();
  const violations: string[] = [];
  for (const entry of trace) {
    const event = entry.event;
    if (event.type === "POLICY_DECIDED") verdicts.set(event.intent_id, event.verdict);
    if (
      event.type === "PROVIDER_MUTATION_SENT" &&
      nonAllow.has(verdicts.get(event.intent_id) ?? "ABSTAIN")
    ) {
      violations.push(event.intent_id);
    }
  }
  return [...new Set(violations)].sort();
}

function duplicateEffectViolations(trace: readonly LabTraceEntry[]): string[] {
  const effects = new Map<string, Set<string>>();
  for (const { event } of trace) {
    let intentId: string | undefined;
    let effectId: string | undefined;
    if (event.type === "PROVIDER_ACCEPTED" || event.type === "WEBHOOK_DELIVERED") {
      intentId = event.intent_id;
      effectId = event.effect_id;
    } else if (event.type === "RECONCILIATION_READ" && event.effect_id) {
      intentId = event.intent_id;
      effectId = event.effect_id;
    }
    if (intentId && effectId) {
      const known = effects.get(intentId) ?? new Set<string>();
      known.add(effectId);
      effects.set(intentId, known);
    }
  }
  return [...effects.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([intentId]) => intentId)
    .sort();
}

function uncertaintyViolations(finalState: LabState): string[] {
  return Object.values(finalState.intents)
    .filter(
      (intent) =>
        (intent.dispatchState === "IN_DOUBT" && !intent.budgetCharged) ||
        (intent.providerEffectIds.length > 0 &&
          intent.dispatchState !== "COMMITTED" &&
          !intent.budgetCharged)
    )
    .map((intent) => intent.intentId)
    .sort();
}

function moneyRegressionViolations(trace: readonly LabTraceEntry[]): string[] {
  const committedRanks = new Map<string, number>();
  const violations = new Set<string>();
  for (const { state } of trace) {
    for (const intent of Object.values(state.intents)) {
      const prior = committedRanks.get(intent.intentId);
      if (prior !== undefined && intent.moneyRank < prior) violations.add(intent.intentId);
      if (intent.dispatchState === "COMMITTED") {
        committedRanks.set(intent.intentId, Math.max(prior ?? 0, intent.moneyRank));
      }
    }
  }
  return [...violations].sort();
}

function revocationViolations(trace: readonly LabTraceEntry[]): string[] {
  let revoked = false;
  const violations = new Set<string>();
  for (const { event } of trace) {
    if (event.type === "AUTHORITY_REVOKED") revoked = true;
    else if (
      revoked &&
      (event.type === "DISPATCH_CLAIMED" || event.type === "PROVIDER_MUTATION_SENT")
    ) {
      violations.add(event.intent_id);
    }
  }
  return [...violations].sort();
}

function settlementRaceViolations(
  trace: readonly LabTraceEntry[],
  finalState: LabState
): string[] {
  const terminalCounts = new Map<string, number>();
  const previous = new Map<string, string>();
  for (const { state } of trace) {
    for (const intent of Object.values(state.intents)) {
      const was = previous.get(intent.intentId) ?? "NONE";
      const terminal = intent.dispatchState === "COMMITTED" || intent.dispatchState === "RELEASED";
      if (terminal && was !== "COMMITTED" && was !== "RELEASED") {
        terminalCounts.set(intent.intentId, (terminalCounts.get(intent.intentId) ?? 0) + 1);
      }
      previous.set(intent.intentId, intent.dispatchState);
    }
  }
  const violations = new Set(
    [...terminalCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([intentId]) => intentId)
  );
  for (const intent of Object.values(finalState.intents)) {
    if (intent.terminalTransitions > 1) violations.add(intent.intentId);
  }
  return [...violations].sort();
}

function terminalEvidenceViolations(finalState: LabState, events: readonly LabEvent[]): string[] {
  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  return Object.values(finalState.intents)
    .filter((intent) => {
      const terminal = intent.dispatchState === "COMMITTED" || intent.dispatchState === "RELEASED";
      if (!terminal) return false;
      const evidence = intent.terminalEvidenceEventId
        ? eventsById.get(intent.terminalEvidenceEventId)
        : undefined;
      const requestEvidence = events.some(
        (event) =>
          event.type === "AGENT_TOOL_REQUESTED" &&
          event.intent_id === intent.intentId &&
          intent.evidenceEventIds.includes(event.event_id)
      );
      const policyEvidence = events.some(
        (event) =>
          event.type === "POLICY_DECIDED" &&
          event.intent_id === intent.intentId &&
          event.verdict === intent.verdict &&
          intent.evidenceEventIds.includes(event.event_id)
      );
      const evidenceMatchesIntent =
        evidence?.type === "PROCESS_RESTARTED" ||
        (evidence !== undefined && "intent_id" in evidence && evidence.intent_id === intent.intentId);
      const explainsCommit =
        (evidence?.type === "WEBHOOK_DELIVERED" &&
          (evidence.provider_state === "captured" || evidence.provider_state === "refunded")) ||
        (evidence?.type === "RECONCILIATION_READ" &&
          evidence.outcome === "MATCHED_COMMITTED") ||
        (evidence?.type === "OPERATOR_DECIDED" && evidence.decision === "COMMIT");
      const explainsRelease =
        evidence?.type === "PROVIDER_REJECTED" ||
        (evidence?.type === "PROCESS_RESTARTED" && !intent.dispatchClaimed) ||
        (evidence?.type === "RECONCILIATION_READ" &&
          evidence.outcome === "MATCHED_FAILED" &&
          intent.request?.tool === "capture_payment") ||
        (evidence?.type === "OPERATOR_DECIDED" && evidence.decision === "RELEASE");
      return (
        intent.request === null ||
        intent.verdict === null ||
        !requestEvidence ||
        !policyEvidence ||
        intent.terminalEvidenceEventId === null ||
        !intent.evidenceEventIds.includes(intent.terminalEvidenceEventId) ||
        !evidenceMatchesIntent ||
        (intent.dispatchState === "COMMITTED" && !explainsCommit) ||
        (intent.dispatchState === "RELEASED" && !explainsRelease)
      );
    })
    .map((intent) => intent.intentId)
    .sort();
}

export function evaluateLabInvariants(
  trace: readonly LabTraceEntry[],
  finalState: LabState
): InvariantResult[] {
  const events = trace.map((entry) => entry.event);
  const checks: Array<[InvariantResult["id"], string[]]> = [
    ["DENIED_ZERO_MUTATIONS", deniedMutationViolations(trace)],
    ["ONE_INTENT_ONE_EFFECT", duplicateEffectViolations(trace)],
    ["UNCERTAINTY_STAYS_CHARGED", uncertaintyViolations(finalState)],
    ["COMMITTED_MONEY_MONOTONIC", moneyRegressionViolations(trace)],
    ["REVOCATION_STOPS_DISPATCH", revocationViolations(trace)],
    ["RACING_SETTLEMENT_ONCE", settlementRaceViolations(trace, finalState)],
    ["TERMINAL_EVIDENCE_RECONSTRUCTABLE", terminalEvidenceViolations(finalState, events)]
  ];
  return checks.map(([id, violations]) => ({ id, passed: violations.length === 0, violations }));
}
