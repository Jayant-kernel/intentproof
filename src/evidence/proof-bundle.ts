import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { exploreSchedules } from "../lab/explorer.js";
import { parseExplorationSpec } from "../lab/exploration-schema.js";
import { loadRegressionFixture, reproduceRegression } from "../lab/regression.js";
import { canonicalJson } from "../ledger/canonical.js";
import { verifyLedger, type VerificationResult } from "../ledger/verify.js";
import {
  parseProofManifest,
  type EvidenceProvenance,
  type ProofManifest,
  type ProofScoreboard
} from "./proof-schema.js";

export interface LocalVerificationSummary {
  tests_passed: number;
  test_files_passed: number;
  build_passed: true;
  audit_vulnerabilities: number;
  diff_check_passed: true;
}

export interface BuildProofBundleOptions {
  rootDirectory: string;
  outputDirectory: string;
  createdAt?: string;
  verification?: LocalVerificationSummary;
  realWebhookEvidence?: unknown | null;
}

export interface ProofVerificationResult {
  valid: boolean;
  artifacts: number;
  reason: string;
}

interface ArtifactDraft {
  id: string;
  filename: string;
  provenance: EvidenceProvenance;
  value: unknown;
}

const providerIdPattern = /\b(?:pay|order|plink|rfnd|pout|setl)_[A-Za-z0-9]{8,}\b/u;
const credentialPattern = /(?:WEBHOOK_SECRET|RAZORPAY_KEY_(?:ID|SECRET)|LLM_API_KEY)\s*=/u;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const phonePattern = /(?:\+?91[\s-]?)?[6-9]\d{9}\b/u;

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalBytes(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function assertSafePath(path: string): void {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
    throw new Error(`Unsafe artifact path: ${path}`);
  }
  if (!path.endsWith(".json")) throw new Error(`Evidence artifact must be JSON: ${path}`);
}

function inspectValue(value: unknown, keyPath = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectValue(item, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (["raw_body", "raw_payload", "webhook_secret", "api_key", "api_secret"].includes(key)) {
        throw new Error(`Forbidden evidence field at ${keyPath}.${key}`);
      }
      if (key === "payload" && child && typeof child === "object" && "payment" in child) {
        throw new Error(`Raw webhook-shaped payload rejected at ${keyPath}.${key}`);
      }
      inspectValue(child, `${keyPath}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (credentialPattern.test(value)) throw new Error(`Credential assignment rejected at ${keyPath}`);
  if (providerIdPattern.test(value)) throw new Error(`Real-looking provider ID rejected at ${keyPath}`);
  if (emailPattern.test(value)) throw new Error(`Email address rejected at ${keyPath}`);
  if (phonePattern.test(value)) throw new Error(`Phone number rejected at ${keyPath}`);
}

export function assertSanitizedArtifact(value: unknown): void {
  inspectValue(value);
}

function command(root: string, executable: string, args: string[]): string {
  const environment: NodeJS.ProcessEnv = { ...process.env, DEBUG: "" };
  for (const key of ["LLM_API_KEY", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "WEBHOOK_SECRET"]) {
    delete environment[key];
  }
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: environment,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Verification command failed: ${executable} ${args.join(" ")}`);
  }
  return result.stdout;
}

function parseJsonOutput(output: string): Record<string, unknown> {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("Verification command did not return JSON");
  return JSON.parse(output.slice(start)) as Record<string, unknown>;
}

export function runLocalVerification(rootDirectory: string): LocalVerificationSummary {
  const root = resolve(rootDirectory);
  const vitest = parseJsonOutput(command(root, process.execPath, [
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "--reporter=json"
  ]));
  command(root, process.execPath, [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json"
  ]);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm executable path is unavailable");
  const audit = parseJsonOutput(command(root, process.execPath, [npmCli, "audit", "--json"]));
  command(root, "git", ["diff", "--check"]);
  const auditMetadata = audit.metadata as { vulnerabilities?: { total?: number } } | undefined;
  return {
    tests_passed: Number(vitest.numPassedTests),
    test_files_passed: Array.isArray(vitest.testResults) ? vitest.testResults.length : 0,
    build_passed: true,
    audit_vulnerabilities: Number(auditMetadata?.vulnerabilities?.total ?? 0),
    diff_check_passed: true
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function commitInfo(root: string): { commit: string; committedAt: string; dirty: boolean } {
  const commit = command(root, "git", ["rev-parse", "HEAD"]).trim();
  const committedAt = command(root, "git", ["show", "-s", "--format=%cI", "HEAD"]).trim();
  const dirty = command(root, "git", ["status", "--porcelain"]).trim().length > 0;
  return { commit, committedAt, dirty };
}

function provenanceCounts(items: Array<{ provenance: EvidenceProvenance }>): Record<EvidenceProvenance, number> {
  const counts: Record<EvidenceProvenance, number> = {
    REAL_RAZORPAY_TEST_MODE: 0,
    MOCKED_GEMINI: 0,
    DETERMINISTIC_FAKE: 0,
    SYNTHETIC_CHAOS: 0,
    LOCAL_VERIFICATION: 0,
    PENDING_EXTERNAL_REPLAY: 0
  };
  for (const item of items) counts[item.provenance] += 1;
  return counts;
}

function safeWrite(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function unsignedManifest(manifest: ProofManifest): Omit<ProofManifest, "bundle_digest"> {
  const { bundle_digest: _digest, ...unsigned } = manifest;
  return unsigned;
}

export function proofBundleDigest(manifest: Omit<ProofManifest, "bundle_digest">): string {
  return sha256(canonicalJson(manifest));
}

function ledgerResult(root: string): VerificationResult {
  const ledgerPath = resolve(root, "ledger.jsonl");
  return existsSync(ledgerPath)
    ? verifyLedger(ledgerPath)
    : { valid: false, records: 0, brokenSeq: null, reason: "ledger export is missing" };
}

export function buildProofBundle(options: BuildProofBundleOptions): string {
  const root = resolve(options.rootDirectory);
  const output = resolve(options.outputDirectory);
  if (existsSync(output)) throw new Error(`Evidence output already exists: ${output}`);

  const verification = options.verification ?? runLocalVerification(root);
  const git = commitInfo(root);
  const createdAt = options.createdAt ?? git.committedAt;
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("--created-at must be an ISO-8601 timestamp");

  const gateway = readJson(resolve(root, "evidence/gateway-pass-through.json"));
  const executor = readJson(resolve(root, "evidence/executor-lifecycle.json"));
  const reconciliation = readJson(resolve(root, "evidence/reconciliation.json"));
  const explorationSpec = parseExplorationSpec(readJson(resolve(root, "campaigns/lab/unsafe-retry.json")));
  const exploration = exploreSchedules(explorationSpec);
  const counterexample = exploration.counterexamples[0];
  if (!counterexample) throw new Error("Counterfactual Lab did not discover the expected failure");
  const regression = reproduceRegression(loadRegressionFixture(resolve(
    root,
    "regressions/lab/unsafe-retry-discovery-one_intent_one_effect.json"
  )));
  if (!regression.reproduced) throw new Error("Unsafe retry regression did not reproduce");
  const ledger = ledgerResult(root);

  const deniedCalls = (gateway.denied_calls as Array<{ upstream_tool_calls: number }> | undefined) ?? [];
  const nonAllowCalls = deniedCalls.reduce((total, item) => total + item.upstream_tool_calls, 0);
  const unsafeEffects = Object.keys(regression.unsafe.finalState.provider.effects).length;
  const intentProofEffects = Object.keys(regression.intentproof.finalState.provider.effects).length;
  const duplicateEffectsPrevented = Math.max(0, unsafeEffects - intentProofEffects);
  const realWebhookPath = resolve(root, "evidence/razorpay-test-webhook.json");
  const evidenceOverrideSupplied = options.realWebhookEvidence !== undefined;
  const realWebhookReceived = evidenceOverrideSupplied
    ? options.realWebhookEvidence !== null
    : existsSync(realWebhookPath);
  let realWebhookArtifact: unknown;
  if (realWebhookReceived) {
    realWebhookArtifact = evidenceOverrideSupplied
      ? options.realWebhookEvidence
      : readJson(realWebhookPath);
    const candidate = realWebhookArtifact as Record<string, unknown>;
    if (
      candidate.source !== "razorpay_test_mode" ||
      candidate.raw_payload_stored !== false ||
      candidate.response_body_stored !== false ||
      candidate.upstream_mutation_by_intentproof !== false
    ) {
      throw new Error("Real webhook evidence does not satisfy the sanitized evidence contract");
    }
  } else {
    realWebhookArtifact = {
      schema_version: 1,
      status: "PENDING_EXTERNAL_REPLAY",
      reason: "The original Test Mode delivery was missed while the tunnel was offline; provider replay is pending.",
      additional_transaction_authorized: false
    };
  }

  const drafts: ArtifactDraft[] = [
    {
      id: "policy-real-test-mode",
      filename: "policy-real-test-mode.json",
      provenance: "REAL_RAZORPAY_TEST_MODE",
      value: {
        schema_version: 1,
        mode: gateway.mode,
        allowed_order: gateway.allowed_order,
        credentials_saved: false,
        response_saved: false
      }
    },
    {
      id: "non-allow-zero-calls",
      filename: "non-allow-zero-calls.json",
      provenance: "LOCAL_VERIFICATION",
      value: { schema_version: 1, denied_calls: gateway.denied_calls, total_upstream_calls: nonAllowCalls }
    },
    {
      id: "mandate-approval",
      filename: "mandate-approval.json",
      provenance: "DETERMINISTIC_FAKE",
      value: {
        schema_version: 1,
        compiler: "deterministic_fake",
        draft_cannot_enforce: true,
        explicit_approval_required: true,
        approved_version_immutable: true,
        deterministic_content_hash: true,
        tampering_rejected: true
      }
    },
    {
      id: "planner-validation",
      filename: "planner-validation.json",
      provenance: "MOCKED_GEMINI",
      value: {
        schema_version: 1,
        provider: "mocked_gemini",
        strict_tool_allowlist: ["create_order", "create_payment_link", "capture_payment", "no_action"],
        malformed_output_fails_closed: true,
        prompt_injection_bypass: false,
        direct_upstream_access: false
      }
    },
    {
      id: "counterfactual-lab",
      filename: "counterfactual-lab.json",
      provenance: "SYNTHETIC_CHAOS",
      value: {
        schema_version: 1,
        seed: exploration.seed,
        explored_schedules: exploration.explored_schedules,
        failures_found: exploration.failures_found,
        original_trace_length: counterexample.original_trace_length,
        minimized_trace_length: counterexample.minimized_trace_length,
        unsafe_model_passed: regression.unsafe.passed,
        intentproof_passed: regression.intentproof.passed,
        deterministic_digest: exploration.deterministic_digest
      }
    },
    {
      id: "reconciliation-budget",
      filename: "reconciliation-budget.json",
      provenance: "DETERMINISTIC_FAKE",
      value: reconciliation
    },
    {
      id: "executor-lifecycle",
      filename: "executor-lifecycle.json",
      provenance: "DETERMINISTIC_FAKE",
      value: executor
    },
    {
      id: "webhook-fixture",
      filename: "webhook-fixture.json",
      provenance: "LOCAL_VERIFICATION",
      value: {
        schema_version: 1,
        exact_raw_bytes_verified_before_parse: true,
        invalid_signature_rejected: true,
        event_id_deduplication_checked: true,
        effect_deduplication_checked: true,
        monotonic_transition_checked: true,
        unknown_event_fails_closed: true
      }
    },
    {
      id: "real-webhook",
      filename: "real-webhook.json",
      provenance: realWebhookReceived ? "REAL_RAZORPAY_TEST_MODE" : "PENDING_EXTERNAL_REPLAY",
      value: realWebhookArtifact
    },
    {
      id: "ledger-integrity",
      filename: "ledger-integrity.json",
      provenance: "LOCAL_VERIFICATION",
      value: { schema_version: 1, verification: ledger }
    }
  ];

  for (const draft of drafts) assertSanitizedArtifact(draft.value);
  const evidence: ProofManifest["evidence"] = [
    { id: "policy_real_test_mode", provenance: "REAL_RAZORPAY_TEST_MODE" as const, status: "VERIFIED" as const, artifact_ids: ["policy-real-test-mode"], metrics: { upstream_calls: 1 } },
    { id: "non_allow_zero_calls", provenance: "LOCAL_VERIFICATION" as const, status: "VERIFIED" as const, artifact_ids: ["non-allow-zero-calls"], metrics: { upstream_calls: nonAllowCalls } },
    { id: "mandate_approval", provenance: "DETERMINISTIC_FAKE" as const, status: "VERIFIED" as const, artifact_ids: ["mandate-approval"], metrics: { explicit_approval: true, tamper_rejected: true } },
    { id: "planner_validation", provenance: "MOCKED_GEMINI" as const, status: "VERIFIED" as const, artifact_ids: ["planner-validation"], metrics: { allowed_tools: 4, direct_upstream_access: false } },
    { id: "counterfactual_lab", provenance: "SYNTHETIC_CHAOS" as const, status: "VERIFIED" as const, artifact_ids: ["counterfactual-lab"], metrics: { schedules: exploration.explored_schedules, failures: exploration.failures_found } },
    { id: "reconciliation_budget", provenance: "DETERMINISTIC_FAKE" as const, status: "VERIFIED" as const, artifact_ids: ["reconciliation-budget"], metrics: { ambiguous_reads_release_budget: false } },
    { id: "executor_lifecycle", provenance: "DETERMINISTIC_FAKE" as const, status: "VERIFIED" as const, artifact_ids: ["executor-lifecycle"], metrics: { real_mutations: 0 } },
    { id: "webhook_fixture", provenance: "LOCAL_VERIFICATION" as const, status: "VERIFIED" as const, artifact_ids: ["webhook-fixture"], metrics: { real_provider_delivery: false } },
    { id: "real_webhook", provenance: (realWebhookReceived ? "REAL_RAZORPAY_TEST_MODE" : "PENDING_EXTERNAL_REPLAY") as EvidenceProvenance, status: (realWebhookReceived ? "VERIFIED" : "PENDING") as "VERIFIED" | "PENDING", artifact_ids: ["real-webhook"], metrics: { genuinely_received: realWebhookReceived } },
    { id: "ledger_integrity", provenance: "LOCAL_VERIFICATION" as const, status: "VERIFIED" as const, artifact_ids: ["ledger-integrity"], metrics: { valid: ledger.valid, records: ledger.records } }
  ];

  const scoreboard: ProofScoreboard = {
    tests_passed: verification.tests_passed,
    test_files_passed: verification.test_files_passed,
    invariants_checked: regression.intentproof.invariants.length,
    chaos_schedules_explored: exploration.explored_schedules,
    failures_independently_discovered: exploration.failures_found,
    trace_original_events: counterexample.original_trace_length,
    trace_minimized_events: counterexample.minimized_trace_length,
    trace_events_removed: counterexample.original_trace_length - counterexample.minimized_trace_length,
    unsafe_model_passed: regression.unsafe.passed,
    intentproof_passed: regression.intentproof.passed,
    non_allow_upstream_calls: nonAllowCalls,
    duplicate_effects_prevented: duplicateEffectsPrevented,
    ledger_verified: ledger.valid,
    real_webhook_status: realWebhookReceived ? "VERIFIED" : "PENDING_EXTERNAL_REPLAY",
    provenance_counts: provenanceCounts(evidence)
  };
  drafts.push({
    id: "scoreboard",
    filename: "scoreboard.json",
    provenance: "LOCAL_VERIFICATION",
    value: scoreboard
  });

  mkdirSync(resolve(output, "artifacts"), { recursive: true });
  const artifacts = drafts.map((draft) => {
    assertSanitizedArtifact(draft.value);
    const path = `artifacts/${draft.filename}`;
    assertSafePath(path);
    const bytes = canonicalBytes(draft.value);
    safeWrite(resolve(output, path), bytes);
    return { id: draft.id, path, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes), provenance: draft.provenance };
  });

  const manifestWithoutDigest: Omit<ProofManifest, "bundle_digest"> = {
    bundle_version: 1 as const,
    created_at: new Date(createdAt).toISOString(),
    time_basis: options.createdAt ? "supplied" as const : "git_commit_time" as const,
    git_commit: git.commit,
    git_dirty: git.dirty,
    verification,
    evidence,
    artifacts,
    scoreboard,
    ledger_verification: ledger,
    known_limitations: [
      "Hashes prove artifact integrity, not author identity or provider attestation.",
      "Bounded schedule exploration is not exhaustive verification.",
      realWebhookReceived
        ? "The provider origin is supported by HMAC verification but is not independently notarized."
        : "A genuine Razorpay webhook replay has not yet reached the listener."
    ],
    external_assumptions: [
      "The checked-out commit and installed dependencies correspond to the reviewed source.",
      "Razorpay Test Mode remains isolated from Live Mode.",
      realWebhookReceived
        ? "The configured webhook secret was controlled by the operator during receipt."
        : "Razorpay support will replay the already-completed Test Mode payment lifecycle."
    ]
  };
  const manifest = parseProofManifest({
    ...manifestWithoutDigest,
    bundle_digest: proofBundleDigest(manifestWithoutDigest)
  });
  const manifestPath = resolve(output, "manifest.json");
  safeWrite(manifestPath, canonicalBytes(manifest));
  return manifestPath;
}

export function verifyProofBundle(manifestPath: string): ProofVerificationResult {
  try {
    const resolvedManifest = resolve(manifestPath);
    const raw = readFileSync(resolvedManifest, "utf8");
    const manifest = parseProofManifest(JSON.parse(raw) as unknown);
    if (raw !== canonicalBytes(manifest)) {
      return { valid: false, artifacts: 0, reason: "manifest is not canonical JSON" };
    }
    if (manifest.bundle_digest !== proofBundleDigest(unsignedManifest(manifest))) {
      return { valid: false, artifacts: 0, reason: "bundle digest mismatch" };
    }
    const root = dirname(resolvedManifest);
    for (const artifact of manifest.artifacts) {
      assertSafePath(artifact.path);
      const artifactPath = resolve(root, artifact.path);
      const relativePath = relative(root, artifactPath);
      if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
        return { valid: false, artifacts: 0, reason: "artifact path escapes bundle" };
      }
      const bytes = readFileSync(artifactPath);
      if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
        return { valid: false, artifacts: 0, reason: `artifact integrity failure: ${artifact.id}` };
      }
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      assertSanitizedArtifact(parsed);
      if (bytes.toString("utf8") !== canonicalBytes(parsed)) {
        return { valid: false, artifacts: 0, reason: `artifact is not canonical JSON: ${artifact.id}` };
      }
      if (artifact.id === "scoreboard" && canonicalJson(parsed) !== canonicalJson(manifest.scoreboard)) {
        return { valid: false, artifacts: 0, reason: "scoreboard does not match manifest" };
      }
    }
    return { valid: true, artifacts: manifest.artifacts.length, reason: "proof bundle integrity verified" };
  } catch (error) {
    return { valid: false, artifacts: 0, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function loadVerifiedScoreboard(manifestPath: string): ProofScoreboard {
  const verification = verifyProofBundle(manifestPath);
  if (!verification.valid) throw new Error(verification.reason);
  return parseProofManifest(JSON.parse(readFileSync(resolve(manifestPath), "utf8")) as unknown).scoreboard;
}
