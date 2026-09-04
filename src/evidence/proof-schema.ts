import { z } from "zod";

export const evidenceProvenanceSchema = z.enum([
  "REAL_RAZORPAY_TEST_MODE",
  "MOCKED_GEMINI",
  "DETERMINISTIC_FAKE",
  "SYNTHETIC_CHAOS",
  "LOCAL_VERIFICATION",
  "PENDING_EXTERNAL_REPLAY"
]);

export type EvidenceProvenance = z.infer<typeof evidenceProvenanceSchema>;

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const metricSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const proofArtifactSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative(),
  provenance: evidenceProvenanceSchema
}).strict();

export const proofEvidenceItemSchema = z.object({
  id: z.string().min(1),
  provenance: evidenceProvenanceSchema,
  status: z.enum(["VERIFIED", "PENDING"]),
  artifact_ids: z.array(z.string().min(1)).min(1),
  metrics: z.record(z.string(), metricSchema)
}).strict();

export const scoreboardSchema = z.object({
  tests_passed: z.number().int().nonnegative(),
  test_files_passed: z.number().int().nonnegative(),
  invariants_checked: z.number().int().nonnegative(),
  chaos_schedules_explored: z.number().int().nonnegative(),
  failures_independently_discovered: z.number().int().nonnegative(),
  trace_original_events: z.number().int().nonnegative(),
  trace_minimized_events: z.number().int().nonnegative(),
  trace_events_removed: z.number().int().nonnegative(),
  unsafe_model_passed: z.boolean(),
  intentproof_passed: z.boolean(),
  non_allow_upstream_calls: z.number().int().nonnegative(),
  duplicate_effects_prevented: z.number().int().nonnegative(),
  ledger_verified: z.boolean(),
  real_webhook_status: z.enum(["VERIFIED", "PENDING_EXTERNAL_REPLAY"]),
  provenance_counts: z.record(evidenceProvenanceSchema, z.number().int().nonnegative())
}).strict();

const verificationSchema = z.object({
  tests_passed: z.number().int().nonnegative(),
  test_files_passed: z.number().int().nonnegative(),
  build_passed: z.literal(true),
  audit_vulnerabilities: z.number().int().nonnegative(),
  diff_check_passed: z.literal(true)
}).strict();

const ledgerVerificationSchema = z.object({
  valid: z.boolean(),
  records: z.number().int().nonnegative(),
  brokenSeq: z.number().int().positive().nullable(),
  reason: z.string()
}).strict();

const allowedProvenance: Record<string, readonly EvidenceProvenance[]> = {
  policy_real_test_mode: ["REAL_RAZORPAY_TEST_MODE"],
  non_allow_zero_calls: ["LOCAL_VERIFICATION"],
  mandate_approval: ["DETERMINISTIC_FAKE"],
  planner_validation: ["MOCKED_GEMINI"],
  counterfactual_lab: ["SYNTHETIC_CHAOS"],
  reconciliation_budget: ["DETERMINISTIC_FAKE"],
  executor_lifecycle: ["DETERMINISTIC_FAKE"],
  webhook_fixture: ["LOCAL_VERIFICATION"],
  real_webhook: ["REAL_RAZORPAY_TEST_MODE", "PENDING_EXTERNAL_REPLAY"],
  ledger_integrity: ["LOCAL_VERIFICATION"]
};

export const proofManifestSchema = z.object({
  bundle_version: z.literal(1),
  created_at: z.string().datetime({ offset: true }),
  time_basis: z.enum(["supplied", "git_commit_time"]),
  git_commit: z.string().regex(/^[a-f0-9]{40}$/u),
  git_dirty: z.boolean(),
  verification: verificationSchema,
  evidence: z.array(proofEvidenceItemSchema).min(1),
  artifacts: z.array(proofArtifactSchema).min(1),
  scoreboard: scoreboardSchema,
  ledger_verification: ledgerVerificationSchema,
  known_limitations: z.array(z.string().min(1)),
  external_assumptions: z.array(z.string().min(1)),
  bundle_digest: sha256Schema
}).strict().superRefine((manifest, context) => {
  const artifactIds = new Set(manifest.artifacts.map((artifact) => artifact.id));
  if (artifactIds.size !== manifest.artifacts.length) {
    context.addIssue({ code: "custom", message: "artifact IDs must be unique" });
  }
  const evidenceIds = new Set<string>();
  for (const item of manifest.evidence) {
    if (evidenceIds.has(item.id)) {
      context.addIssue({ code: "custom", message: `duplicate evidence ID: ${item.id}` });
    }
    evidenceIds.add(item.id);
    const allowed = allowedProvenance[item.id];
    if (!allowed || !allowed.includes(item.provenance)) {
      context.addIssue({ code: "custom", message: `invalid provenance for ${item.id}` });
    }
    for (const artifactId of item.artifact_ids) {
      if (!artifactIds.has(artifactId)) {
        context.addIssue({ code: "custom", message: `unknown artifact reference: ${artifactId}` });
      }
    }
    if (item.id === "real_webhook") {
      const expectedStatus = item.provenance === "REAL_RAZORPAY_TEST_MODE" ? "VERIFIED" : "PENDING";
      if (item.status !== expectedStatus) {
        context.addIssue({ code: "custom", message: "real webhook status does not match provenance" });
      }
    } else if (item.status !== "VERIFIED") {
      context.addIssue({ code: "custom", message: `only real_webhook may remain pending` });
    }
  }
});

export type ProofManifest = z.infer<typeof proofManifestSchema>;
export type ProofScoreboard = z.infer<typeof scoreboardSchema>;

export function parseProofManifest(value: unknown): ProofManifest {
  return proofManifestSchema.parse(value);
}
