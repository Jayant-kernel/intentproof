export type Verdict = "ALLOW" | "BLOCK" | "HOLD_FOR_APPROVAL" | "ABSTAIN" | "PLANNER_REJECTED";

export interface OverviewData {
  mandate: { id: string; version: number; hash: string; approvedBy: string };
  killSwitch: boolean;
  budget: { usedPaise: number; limitPaise: number; calls: number; maxCalls: number };
  allowedTools: string[];
  lastVerdict: Verdict | null;
  upstreamCallsPrevented: number;
  ledger: { valid: boolean; records: number; reason: string };
  webhookStatus: "VERIFIED" | "PENDING_EXTERNAL_REPLAY";
  evidenceDigest: string;
  evidenceDigestShort: string;
  runtime: string;
}

export interface Rule {
  id?: string;
  rule?: string;
  quote: string;
  tools?: string[];
  tool?: string;
  max_paise?: number;
  above_paise?: number;
  allowed?: string;
  timezone?: string;
  assert?: string;
  window?: string;
  max_total_paise?: number;
  max_calls?: number;
}

export interface MandateData {
  approved: {
    mandate_id: string;
    version: number;
    source_text: string;
    approved_by: string;
    approved_at: string;
    mandate_hash: string;
    constraints: Rule[];
    budgets: Rule[];
  };
  draft: null | {
    draft_id: string;
    draft_hash: string;
    proposed_version: number;
    source_text: string;
    compiler: { provider: string; model: string };
    rules: { constraints: Rule[]; budgets: Rule[] };
    review: {
      approvable: boolean;
      unsupported_instructions: Array<{ source_text: string; reason: string }>;
      ambiguities: Array<{ source_text: string; reason: string }>;
      conservative_assumptions: string[];
      validation_errors: string[];
      source_references: Array<{ rule_id: string; quote: string; start: number; end: number }>;
    };
  };
  diff: Array<{ operation: string; rule_id: string }>;
  enforcementBoundary: string;
}

export interface AgentResult {
  example: string | null;
  objective: string;
  verdict: Verdict;
  explanation: string;
  proposedTool: string | null;
  arguments: Record<string, unknown>;
  intentId: string | null;
  ruleId: string | null;
  quote: string | null;
  gatewayCallCount: number;
  upstreamCallCount: number;
}

export interface AuditRecord {
  seq: number;
  timestamp: string;
  actor: string;
  action: string;
  verdict: string | null;
  rule: string | null;
  upstreamEffect: string;
  stateTransition: string;
  evidenceHash: string;
  previousHash: string;
  details: Record<string, unknown>;
}

export interface ScenarioSummary {
  id: string;
  name: string;
  description: string;
  seed: number;
  events: number;
}

export interface LabResult {
  scenario: { id: string; name: string; description: string; seed: number; digest: string; passed: boolean };
  timeline: Array<{ atMs: number; type: string; summary: string }>;
  invariants: Array<{ id: string; passed: boolean; violations: string[]; observations: string[] }>;
  comparison: {
    unsafePassed: boolean;
    intentProofPassed: boolean;
    originalTraceLength: number;
    minimizedTraceLength: number;
    invariant: string;
    explanation: string;
  };
}

export interface EvidenceData {
  manifest: { createdAt: string; gitCommit: string; digest: string; verified: boolean; artifactsVerified: number };
  scoreboard: Record<string, unknown> & {
    tests_passed: number;
    invariants_checked: number;
    failures_independently_discovered: number;
    trace_original_events: number;
    trace_minimized_events: number;
    non_allow_upstream_calls: number;
    duplicate_effects_prevented: number;
    ledger_verified: boolean;
    real_webhook_status: string;
    provenance_counts: Record<string, number>;
  };
  evidence: Array<{ id: string; provenance: string; status: string; metrics: Record<string, string | number | boolean> }>;
  limitations: string[];
  provenanceDigest: string;
  operationalEvidence: {
    executorLifecycle: {
      sourceArtifact: string;
      provenance: "DETERMINISTIC_FAKE";
      reservedObserved: number;
      committedObserved: number;
      inDoubtObserved: number;
      releasedObserved: number;
      realMutations: number;
    };
    paymentLifecycle: {
      sourceArtifact: string;
      provenance: "PENDING_EXTERNAL_REPLAY";
      status: "PENDING_EXTERNAL_REPLAY";
      reason: string;
      additionalTransactionAuthorized: boolean;
    };
  };
}
