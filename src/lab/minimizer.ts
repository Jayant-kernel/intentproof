import type { LabInvariantId } from "./invariants.js";
import type { LabModel } from "./exploration-schema.js";
import { runLabEvents } from "./model-runner.js";
import type { LabEvent } from "./schema.js";

export interface MinimizedTrace {
  invariantId: LabInvariantId;
  originalLength: number;
  minimizedLength: number;
  events: LabEvent[];
}

function failurePreserved(
  events: readonly LabEvent[],
  model: LabModel,
  target: LabInvariantId,
  initialTimeMs: number
): boolean {
  return runLabEvents(events, model, initialTimeMs).invariants.some(
    (invariant) => invariant.id === target && !invariant.passed
  );
}

export function isCausallyValidTrace(events: readonly LabEvent[]): boolean {
  const eventIds = new Set<string>();
  const requestCount = new Map<string, number>();
  const allowed = new Set<string>();
  const reservations = new Set<string>();
  const claimCount = new Map<string, number>();
  const mutationCount = new Map<string, number>();
  const responseCount = new Map<string, number>();
  const pendingAttempts = new Map<string, Set<string>>();
  const timedOut = new Set<string>();
  let priorTime = -1;

  for (const event of events) {
    if (eventIds.has(event.event_id) || event.at_ms < priorTime) return false;
    eventIds.add(event.event_id);
    priorTime = event.at_ms;

    switch (event.type) {
      case "AGENT_TOOL_REQUESTED":
        if (
          (requestCount.get(event.intent_id) ?? 0) > 0 &&
          !timedOut.has(event.intent_id)
        ) {
          return false;
        }
        requestCount.set(event.intent_id, (requestCount.get(event.intent_id) ?? 0) + 1);
        break;
      case "POLICY_DECIDED":
        if ((requestCount.get(event.intent_id) ?? 0) === 0) return false;
        if (event.verdict === "ALLOW") allowed.add(event.intent_id);
        break;
      case "BUDGET_RESERVED":
        if (!allowed.has(event.intent_id)) return false;
        reservations.add(event.intent_id);
        break;
      case "DISPATCH_CLAIMED":
        if (!reservations.has(event.intent_id)) return false;
        claimCount.set(event.intent_id, (claimCount.get(event.intent_id) ?? 0) + 1);
        if (
          (claimCount.get(event.intent_id) ?? 0) >
          (requestCount.get(event.intent_id) ?? 0)
        ) {
          return false;
        }
        break;
      case "PROVIDER_MUTATION_SENT":
        mutationCount.set(event.intent_id, (mutationCount.get(event.intent_id) ?? 0) + 1);
        if (
          (mutationCount.get(event.intent_id) ?? 0) >
          (claimCount.get(event.intent_id) ?? 0)
        ) {
          return false;
        }
        {
          const pending = pendingAttempts.get(event.intent_id) ?? new Set<string>();
          pending.add(event.attempt_id);
          pendingAttempts.set(event.intent_id, pending);
        }
        break;
      case "PROVIDER_ACCEPTED":
      case "PROVIDER_REJECTED": {
        if (event.type === "PROVIDER_ACCEPTED" && event.attempt_id) {
          const pending = pendingAttempts.get(event.intent_id);
          if (!pending?.has(event.attempt_id)) return false;
          pending.delete(event.attempt_id);
        }
        const responses = (responseCount.get(event.intent_id) ?? 0) + 1;
        if (responses > (mutationCount.get(event.intent_id) ?? 0)) return false;
        responseCount.set(event.intent_id, responses);
        break;
      }
      case "TIMEOUT_OBSERVED":
        if ((mutationCount.get(event.intent_id) ?? 0) === 0) return false;
        timedOut.add(event.intent_id);
        break;
      case "WEBHOOK_DELIVERED":
      case "RECONCILIATION_READ":
        if ((mutationCount.get(event.intent_id) ?? 0) === 0) return false;
        break;
      case "OPERATOR_DECIDED":
        if ((requestCount.get(event.intent_id) ?? 0) === 0) return false;
        break;
      case "PROCESS_CRASHED":
      case "PROCESS_RESTARTED":
      case "AUTHORITY_REVOKED":
        break;
    }
  }
  return true;
}

export function minimizeFailingTrace(
  events: readonly LabEvent[],
  model: LabModel,
  target: LabInvariantId,
  initialTimeMs = 0
): MinimizedTrace {
  if (
    !isCausallyValidTrace(events) ||
    !failurePreserved(events, model, target, initialTimeMs)
  ) {
    throw new Error(`Trace does not contain a valid ${target} failure`);
  }

  let current = structuredClone(events) as LabEvent[];
  let partitions = 2;
  while (current.length >= 2) {
    const chunkSize = Math.ceil(current.length / partitions);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunkSize) {
      const candidate = current.filter(
        (_, index) => index < start || index >= start + chunkSize
      );
      if (
        candidate.length > 0 &&
        isCausallyValidTrace(candidate) &&
        failurePreserved(candidate, model, target, initialTimeMs)
      ) {
        current = candidate;
        partitions = Math.max(2, partitions - 1);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (partitions >= current.length) break;
    partitions = Math.min(current.length, partitions * 2);
  }

  for (let index = current.length - 1; index >= 0; index -= 1) {
    const candidate = current.filter((_, candidateIndex) => candidateIndex !== index);
    if (
      candidate.length > 0 &&
      isCausallyValidTrace(candidate) &&
      failurePreserved(candidate, model, target, initialTimeMs)
    ) {
      current = candidate;
    }
  }

  const simplified = current.map((event) => ({ ...event, at_ms: initialTimeMs })) as LabEvent[];
  if (
    isCausallyValidTrace(simplified) &&
    failurePreserved(simplified, model, target, initialTimeMs)
  ) {
    current = simplified;
  }

  return {
    invariantId: target,
    originalLength: events.length,
    minimizedLength: current.length,
    events: current
  };
}
