import { providerStateRank } from "./provider-model.js";
import type { LabEvent, LabTool, LabVerdict, ProviderState } from "./schema.js";
import type { LabState } from "./state.js";

export const LAB_INVARIANT_IDS = [
  "DENIED_ZERO_MUTATIONS",
  "ONE_INTENT_ONE_EFFECT",
  "ONE_EFFECT_ONE_INTENT",
  "RAW_PROVIDER_HISTORY_VALID",
  "UNCERTAINTY_STAYS_CHARGED",
  "COMMITTED_MONEY_MONOTONIC",
  "REVOCATION_STOPS_DISPATCH",
  "RACING_SETTLEMENT_ONCE",
  "TERMINAL_EVIDENCE_RECONSTRUCTABLE"
] as const;

export type LabInvariantId = (typeof LAB_INVARIANT_IDS)[number];

export interface LabTraceEntry {
  sequence: number;
  event: LabEvent;
  state: LabState;
  applied?: boolean;
}

export interface InvariantResult {
  id: LabInvariantId;
  passed: boolean;
  violations: string[];
  observations: string[];
}

interface EffectObservation {
  eventId: string;
  intentId: string;
  effectId: string;
  state: ProviderState;
  tool: LabTool | null;
}

const nonAllow = new Set<LabVerdict>(["BLOCK", "HOLD_FOR_APPROVAL", "ABSTAIN"]);

function wasApplied(entry: LabTraceEntry): boolean {
  return entry.applied !== false;
}

function effectObservations(trace: readonly LabTraceEntry[]): EffectObservation[] {
  const tools = new Map<string, LabTool>();
  const observations: EffectObservation[] = [];
  for (const entry of trace) {
    if (!wasApplied(entry)) continue;
    const event = entry.event;
    if (event.type === "AGENT_TOOL_REQUESTED" && !tools.has(event.intent_id)) {
      tools.set(event.intent_id, event.tool);
    }
    if (event.type === "PROVIDER_ACCEPTED" || event.type === "WEBHOOK_DELIVERED") {
      observations.push({
        eventId: event.event_id,
        intentId: event.intent_id,
        effectId: event.effect_id,
        state: event.provider_state,
        tool: tools.get(event.intent_id) ?? null
      });
    } else if (
      event.type === "RECONCILIATION_READ" &&
      event.outcome === "MATCHED_COMMITTED" &&
      event.effect_id
    ) {
      observations.push({
        eventId: event.event_id,
        intentId: event.intent_id,
        effectId: event.effect_id,
        state: tools.get(event.intent_id) === "capture_payment" ? "captured" : "created",
        tool: tools.get(event.intent_id) ?? null
      });
    }
  }
  return observations;
}

function deniedMutationViolations(trace: readonly LabTraceEntry[]): string[] {
  const verdicts = new Map<string, LabVerdict>();
  const violations = new Set<string>();
  for (const entry of trace) {
    if (!wasApplied(entry)) continue;
    const event = entry.event;
    if (event.type === "POLICY_DECIDED") verdicts.set(event.intent_id, event.verdict);
    if (
      event.type === "PROVIDER_MUTATION_SENT" &&
      nonAllow.has(verdicts.get(event.intent_id) ?? "ABSTAIN")
    ) {
      violations.add(event.intent_id);
    }
  }
  return [...violations].sort();
}

function intentEffectViolations(observations: readonly EffectObservation[]): string[] {
  const effects = new Map<string, Set<string>>();
  for (const observation of observations) {
    const known = effects.get(observation.intentId) ?? new Set<string>();
    known.add(observation.effectId);
    effects.set(observation.intentId, known);
  }
  return [...effects.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([intentId]) => intentId)
    .sort();
}

function effectIntentViolations(observations: readonly EffectObservation[]): string[] {
  const intents = new Map<string, Set<string>>();
  for (const observation of observations) {
    const known = intents.get(observation.effectId) ?? new Set<string>();
    known.add(observation.intentId);
    intents.set(observation.effectId, known);
  }
  return [...intents.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([effectId]) => effectId)
    .sort();
}

function rawProviderHistory(
  observations: readonly EffectObservation[]
): { violations: string[]; observations: string[] } {
  const histories = new Map<string, EffectObservation[]>();
  const violations = new Set<string>();
  const findings = new Set<string>();

  for (const observation of observations) {
    const history = histories.get(observation.effectId) ?? [];
    const priorStates = history.map((prior) => prior.state);
    const highestPriorRank = Math.max(0, ...priorStates.map(providerStateRank));

    if (providerStateRank(observation.state) < highestPriorRank) {
      findings.add(
        `STALE_PROVIDER_STATE:${observation.intentId}:${observation.effectId}:${observation.state}:${observation.eventId}`
      );
    }
    if (
      (observation.state === "failed" &&
        priorStates.some((state) => state === "captured" || state === "refunded")) ||
      (priorStates.includes("failed") &&
        (observation.state === "authorized" ||
          observation.state === "captured" ||
          observation.state === "refunded"))
    ) {
      violations.add(
        `CONTRADICTORY_PROVIDER_STATE:${observation.intentId}:${observation.effectId}:${observation.eventId}`
      );
    }
    if (
      (observation.tool === "create_order" || observation.tool === "create_payment_link") &&
      observation.state !== "created"
    ) {
      violations.add(
        `IMPOSSIBLE_TOOL_STATE:${observation.intentId}:${observation.tool}:${observation.state}:${observation.eventId}`
      );
    }
    if (observation.tool === "capture_payment" && observation.state === "created") {
      violations.add(
        `IMPOSSIBLE_TOOL_STATE:${observation.intentId}:capture_payment:created:${observation.eventId}`
      );
    }

    history.push(observation);
    histories.set(observation.effectId, history);
  }

  for (const [effectId, history] of histories) {
    const states = history.map((entry) => entry.state);
    if (states.includes("refunded") && !states.includes("captured")) {
      violations.add(`REFUND_WITHOUT_CAPTURE:${effectId}`);
    }
  }

  return { violations: [...violations].sort(), observations: [...findings].sort() };
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
  let revokedThroughVersion = 0;
  const claimedVersions = new Map<string, number>();
  const violations = new Set<string>();

  for (const entry of trace) {
    if (!wasApplied(entry)) continue;
    const event = entry.event;
    if (event.type === "AUTHORITY_REVOKED") {
      revokedThroughVersion = Math.max(revokedThroughVersion, event.mandate_version);
    } else if (event.type === "DISPATCH_CLAIMED") {
      claimedVersions.set(event.intent_id, event.mandate_version);
      if (event.mandate_version <= revokedThroughVersion) violations.add(event.intent_id);
    } else if (event.type === "PROVIDER_MUTATION_SENT") {
      const claimedVersion = claimedVersions.get(event.intent_id);
      if (claimedVersion !== undefined && claimedVersion <= revokedThroughVersion) {
        violations.add(event.intent_id);
      }
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

function terminalEvidenceViolations(finalState: LabState, trace: readonly LabTraceEntry[]): string[] {
  const appliedEvents = trace.filter(wasApplied).map((entry) => entry.event);
  const eventsById = new Map(appliedEvents.map((event) => [event.event_id, event]));
  return Object.values(finalState.intents)
    .filter((intent) => {
      const terminal = intent.dispatchState === "COMMITTED" || intent.dispatchState === "RELEASED";
      if (!terminal) return false;
      const evidence = intent.terminalEvidenceEventId
        ? eventsById.get(intent.terminalEvidenceEventId)
        : undefined;
      const requestEvidence = appliedEvents.some(
        (event) =>
          event.type === "AGENT_TOOL_REQUESTED" &&
          event.intent_id === intent.intentId &&
          intent.evidenceEventIds.includes(event.event_id)
      );
      const policyEvidence = appliedEvents.some(
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
  const effects = effectObservations(trace);
  const rawHistory = rawProviderHistory(effects);
  const checks: Array<[LabInvariantId, string[], string[]]> = [
    ["DENIED_ZERO_MUTATIONS", deniedMutationViolations(trace), []],
    ["ONE_INTENT_ONE_EFFECT", intentEffectViolations(effects), []],
    ["ONE_EFFECT_ONE_INTENT", effectIntentViolations(effects), []],
    ["RAW_PROVIDER_HISTORY_VALID", rawHistory.violations, rawHistory.observations],
    ["UNCERTAINTY_STAYS_CHARGED", uncertaintyViolations(finalState), []],
    ["COMMITTED_MONEY_MONOTONIC", moneyRegressionViolations(trace), []],
    ["REVOCATION_STOPS_DISPATCH", revocationViolations(trace), []],
    ["RACING_SETTLEMENT_ONCE", settlementRaceViolations(trace, finalState), []],
    ["TERMINAL_EVIDENCE_RECONSTRUCTABLE", terminalEvidenceViolations(finalState, trace), []]
  ];
  return checks.map(([id, violations, observations]) => ({
    id,
    passed: violations.length === 0,
    violations,
    observations
  }));
}
