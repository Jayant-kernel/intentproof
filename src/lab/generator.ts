import { executeProviderMutation } from "./provider-model.js";
import type { ExplorationSpec, LabModel } from "./exploration-schema.js";
import type { LabEvent } from "./schema.js";
import type { LabState } from "./state.js";

export type ExplorationActionKind =
  | "REQUEST"
  | "POLICY_ALLOW"
  | "RESERVE"
  | "DISPATCH"
  | "PROVIDER_CALL"
  | "TIMEOUT"
  | "RETRY_REQUEST"
  | "RETRY_DISPATCH"
  | "RETRY_PROVIDER_CALL"
  | "REVOKE"
  | "DUPLICATE_WEBHOOK"
  | "RACE_WEBHOOK"
  | "RECONCILE"
  | "CONTRADICTORY_FAILED"
  | "CRASH"
  | "RESTART"
  | "MALFORMED_READ";

export interface ExplorationAction {
  id: string;
  kind: ExplorationActionKind;
  atMs: number;
  after: string[];
}

function action(
  id: string,
  kind: ExplorationActionKind,
  atMs: number,
  after: string[]
): ExplorationAction {
  return { id, kind, atMs, after };
}

export function generateExplorationActions(specification: ExplorationSpec): ExplorationAction[] {
  const start = specification.initial_time_ms;
  const actions: ExplorationAction[] = [
    action("request", "REQUEST", start, []),
    action("policy", "POLICY_ALLOW", start + 10, ["request"]),
    action("reserve", "RESERVE", start + 20, ["policy"]),
    action("dispatch", "DISPATCH", start + 30, ["reserve"]),
    action("provider-call", "PROVIDER_CALL", start + 40, ["dispatch"])
  ];
  const faults = new Set(specification.workflow.faults);

  if (faults.has("revocation_race")) {
    actions.push(action("revoke", "REVOKE", start + 30, ["reserve"]));
  }
  if (faults.has("crash_restart")) {
    actions.push(action("crash", "CRASH", start + 35, ["dispatch"]));
    actions.push(action("restart", "RESTART", start + 45, ["crash"]));
  }
  if (faults.has("timeout_after_acceptance")) {
    actions.push(action("timeout", "TIMEOUT", start + 50, ["provider-call"]));
  }

  const uncertaintyAnchor = faults.has("timeout_after_acceptance") ? "timeout" : "provider-call";
  if (faults.has("retry")) {
    actions.push(action("retry-request", "RETRY_REQUEST", start + 60, [uncertaintyAnchor]));
    actions.push(action("retry-dispatch", "RETRY_DISPATCH", start + 70, ["retry-request"]));
    actions.push(
      action("retry-provider-call", "RETRY_PROVIDER_CALL", start + 80, ["retry-dispatch"])
    );
  }
  if (faults.has("duplicate_webhook")) {
    actions.push(action("duplicate-webhook-a", "DUPLICATE_WEBHOOK", start + 60, ["provider-call"]));
    actions.push(action("duplicate-webhook-b", "DUPLICATE_WEBHOOK", start + 60, ["provider-call"]));
  }
  if (faults.has("webhook_reconciler_race")) {
    actions.push(action("race-webhook", "RACE_WEBHOOK", start + 60, [uncertaintyAnchor]));
    actions.push(action("reconcile", "RECONCILE", start + 60, [uncertaintyAnchor]));
  }
  if (faults.has("contradictory_provider_state")) {
    actions.push(
      action("contradictory-failed", "CONTRADICTORY_FAILED", start + 60, ["provider-call"])
    );
  }
  if (faults.has("malformed_read")) {
    actions.push(action("malformed-read", "MALFORMED_READ", start + 60, [uncertaintyAnchor]));
  }

  return actions;
}

function eventBase(actionValue: ExplorationAction): Pick<LabEvent, "schema_version" | "event_id" | "at_ms"> {
  return { schema_version: 1, event_id: `generated-${actionValue.id}`, at_ms: actionValue.atMs };
}

function firstEffectId(state: LabState, intentId: string): string | undefined {
  return state.intents[intentId]?.providerEffectIds[0];
}

export function materializeAction(
  actionValue: ExplorationAction,
  specification: ExplorationSpec,
  state: LabState,
  model: LabModel
): LabEvent[] {
  const base = eventBase(actionValue);
  const workflow = specification.workflow;
  switch (actionValue.kind) {
    case "REQUEST":
    case "RETRY_REQUEST":
      return [
        {
          ...base,
          type: "AGENT_TOOL_REQUESTED",
          intent_id: workflow.intent_id,
          idempotency_key: workflow.idempotency_key,
          tool: workflow.tool,
          amount_paise: workflow.amount_paise,
          currency: "INR"
        }
      ];
    case "POLICY_ALLOW":
      return [
        {
          ...base,
          type: "POLICY_DECIDED",
          intent_id: workflow.intent_id,
          verdict: "ALLOW",
          rule_id: "GENERATED_ALLOW"
        }
      ];
    case "RESERVE":
      return [{ ...base, type: "BUDGET_RESERVED", intent_id: workflow.intent_id }];
    case "DISPATCH":
    case "RETRY_DISPATCH":
      return [
        {
          ...base,
          type: "DISPATCH_CLAIMED",
          intent_id: workflow.intent_id,
          mandate_version: workflow.mandate_version
        }
      ];
    case "PROVIDER_CALL":
    case "RETRY_PROVIDER_CALL": {
      const intent = state.intents[workflow.intent_id];
      if (!intent) return [];
      const attemptId = `${workflow.intent_id}-${actionValue.id}`;
      const execution = executeProviderMutation(state.provider, intent, attemptId, model);
      const sent: LabEvent = {
        ...base,
        event_id: `${base.event_id}-sent`,
        type: "PROVIDER_MUTATION_SENT",
        intent_id: workflow.intent_id,
        attempt_id: attemptId
      };
      if (!execution.accepted) {
        return [
          sent,
          {
            ...base,
            event_id: `${base.event_id}-rejected`,
            type: "PROVIDER_REJECTED",
            intent_id: workflow.intent_id,
            reason: execution.reason
          }
        ];
      }
      return [
        sent,
        {
          ...base,
          event_id: `${base.event_id}-accepted`,
          type: "PROVIDER_ACCEPTED",
          intent_id: workflow.intent_id,
          attempt_id: attemptId,
          effect_id: execution.effectId,
          provider_state: execution.state
        }
      ];
    }
    case "TIMEOUT":
      return [
        {
          ...base,
          type: "TIMEOUT_OBSERVED",
          intent_id: workflow.intent_id,
          phase: "AFTER_ACCEPTANCE"
        }
      ];
    case "REVOKE":
      return [
        {
          ...base,
          type: "AUTHORITY_REVOKED",
          mandate_version: workflow.mandate_version,
          reason: "generated revocation race"
        }
      ];
    case "DUPLICATE_WEBHOOK":
    case "RACE_WEBHOOK": {
      const effectId = firstEffectId(state, workflow.intent_id);
      if (!effectId) return [];
      return [
        {
          ...base,
          type: "WEBHOOK_DELIVERED",
          intent_id: workflow.intent_id,
          delivery_id:
            actionValue.kind === "DUPLICATE_WEBHOOK" ? "generated-duplicate" : "generated-race",
          effect_id: effectId,
          provider_state: workflow.tool === "capture_payment" ? "captured" : "created"
        }
      ];
    }
    case "RECONCILE": {
      const effectId = firstEffectId(state, workflow.intent_id);
      if (!effectId) return [];
      return [
        {
          ...base,
          type: "RECONCILIATION_READ",
          intent_id: workflow.intent_id,
          outcome: "MATCHED_COMMITTED",
          effect_id: effectId
        }
      ];
    }
    case "CONTRADICTORY_FAILED": {
      const effectId = firstEffectId(state, workflow.intent_id);
      if (!effectId) return [];
      return [
        {
          ...base,
          type: "WEBHOOK_DELIVERED",
          intent_id: workflow.intent_id,
          delivery_id: "generated-contradiction",
          effect_id: effectId,
          provider_state: "failed"
        }
      ];
    }
    case "CRASH":
      return [
        {
          ...base,
          type: "PROCESS_CRASHED",
          process_id: "generated-gateway",
          reason: "generated crash"
        }
      ];
    case "RESTART":
      return [
        {
          ...base,
          type: "PROCESS_RESTARTED",
          process_id: "generated-gateway"
        }
      ];
    case "MALFORMED_READ":
      return [
        {
          ...base,
          type: "RECONCILIATION_READ",
          intent_id: workflow.intent_id,
          outcome: "MALFORMED"
        }
      ];
  }
}
