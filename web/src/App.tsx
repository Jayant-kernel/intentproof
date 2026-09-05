import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  CircleDollarSign,
  FileCheck2,
  FileClock,
  Fingerprint,
  FlaskConical,
  Gauge,
  History,
  KeyRound,
  LockKeyhole,
  Menu,
  Play,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  X,
  type LucideIcon
} from "lucide-react";

import { api } from "./api.js";
import type { AgentResult, AuditRecord, EvidenceData, LabResult, MandateData, OverviewData, Rule, ScenarioSummary } from "./types.js";

type Tab = "overview" | "mandate" | "agent" | "audit" | "lab" | "evidence";
type Tone = "good" | "bad" | "warn" | "info" | "neutral";

const navGroups: Array<{ label: string; items: Array<{ id: Tab; label: string; icon: LucideIcon }> }> = [
  {
    label: "Control",
    items: [
      { id: "overview", label: "Overview", icon: Gauge },
      { id: "mandate", label: "Mandate", icon: FileCheck2 },
      { id: "agent", label: "Agent", icon: Bot }
    ]
  },
  {
    label: "Evidence",
    items: [
      { id: "audit", label: "Audit", icon: History },
      { id: "lab", label: "Counterfactual Lab", icon: FlaskConical },
      { id: "evidence", label: "Evidence", icon: Fingerprint }
    ]
  }
];

const nav: Array<{ id: Tab; label: string; icon: LucideIcon }> = navGroups.flatMap((group) => group.items);

const examples = [
  { id: "allowed_order", label: "Allowed ₹199 order" },
  { id: "over_limit", label: "Over-limit order" },
  { id: "capture_before_delivery", label: "Capture before delivery" },
  { id: "approval_required", label: "Approval-required capture" },
  { id: "prompt_injection", label: "Prompt-injection attempt" },
  { id: "kill_switch", label: "Kill switch" },
  { id: "stale_mandate", label: "Stale mandate version" }
];

const defaultInstruction = `Create orders up to 3,000 rupees.
Keep total action value under 25,000 rupees per day, with no more than 200 actions.
Do not capture a payment until delivery is confirmed.
Ask me before capturing more than 2,000 rupees.
Do not act between 10pm and 8am.`;

const verdictOrder = ["ALLOW", "BLOCK", "HOLD_FOR_APPROVAL", "ABSTAIN"] as const;

function money(paise: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);
}

function compactHash(value: string): string {
  return value.length > 28 ? `${value.slice(0, 17)}…${value.slice(-8)}` : value;
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/gu, (character) => character.toUpperCase());
}

function verdictTone(verdict: string | null): Tone {
  if (verdict === "ALLOW") return "good";
  if (verdict === "HOLD_FOR_APPROVAL") return "warn";
  if (verdict === "ABSTAIN") return "info";
  if (verdict === "BLOCK" || verdict === "PLANNER_REJECTED") return "bad";
  return "neutral";
}

const systemRuleText: Record<string, string> = {
  SYSTEM_KILL_SWITCH: "The merchant kill switch must be off before dispatch.",
  SYSTEM_MANDATE_REVOKED: "The mandate must not be revoked.",
  SYSTEM_MANDATE_VERSION: "The action must target the currently approved mandate version.",
  SYSTEM_TOOL_ALLOWLIST: "The tool must be inside the approved IntentProof tool surface.",
  SYSTEM_AMOUNT_FORMAT: "The amount must be provided as integer paise.",
  SYSTEM_ARGUMENT_SCHEMA: "The tool arguments must match the supported IntentProof schema."
};

function isMandateRule(ruleId: string | null): ruleId is string {
  return Boolean(ruleId && !ruleId.startsWith("SYSTEM_") && ruleId !== "PLANNER_CONSTRAINT");
}

function ruleText(ruleId: string | null, quote: string | null): string {
  if (quote) return quote;
  if (ruleId && systemRuleText[ruleId]) return systemRuleText[ruleId];
  return ruleId ? "This system check has no merchant-authored source quotation." : "All active policy checks passed.";
}

function agentExplanation(result: AgentResult): string {
  if (result.verdict === "ALLOW" || result.verdict === "PLANNER_REJECTED") return result.explanation;
  if (result.quote && result.ruleId) {
    if (result.verdict === "HOLD_FOR_APPROVAL") return `Held for explicit approval by approved rule ${result.ruleId}.`;
    if (result.verdict === "ABSTAIN") return `Approved rule ${result.ruleId} requires additional evidence.`;
    return `Blocked before dispatch by approved rule ${result.ruleId}.`;
  }
  const reason = ruleText(result.ruleId, result.quote);
  if (result.verdict === "HOLD_FOR_APPROVAL") return `Held for explicit approval: ${reason}`;
  if (result.verdict === "ABSTAIN") return `No decision without additional evidence: ${reason}`;
  return `Blocked before dispatch: ${reason}`;
}

function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`status status-${tone}`}><span className="status-dot" aria-hidden="true" />{children}</span>;
}

function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return <Status>NOT RUN</Status>;
  return <Status tone={verdictTone(verdict)}>{verdict.replaceAll("_", " ")}</Status>;
}

function Section({ icon: Icon, title, meta, action, children, className = "" }: { icon?: LucideIcon; title: string; meta?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`section ${className}`}><header className="section-header"><div>{Icon && <span className="section-icon" aria-hidden="true"><Icon size={15} /></span>}<h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action}</header>{children}</section>;
}

function Empty({ icon: Icon = FileClock, title, text }: { icon?: LucideIcon; title: string; text: string }) {
  return <div className="empty"><Icon size={21} aria-hidden="true" /><strong>{title}</strong><p>{text}</p></div>;
}

function ConfirmDialog({ open, title, text, confirmLabel, danger, onCancel, onConfirm }: { open: boolean; title: string; text: string; confirmLabel: string; danger?: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); previousFocus?.focus(); };
  }, [open, onCancel]);
  if (!open) return null;
  return <div className="dialog-backdrop"><button className="dialog-dismiss-layer" aria-label="Close confirmation" onClick={onCancel} /><div ref={dialogRef} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description"><button className="icon-button dialog-close" aria-label="Close confirmation" title="Close" onClick={onCancel}><X size={18} aria-hidden="true" /></button><div className={`dialog-icon ${danger ? "danger" : "safe"}`} aria-hidden="true">{danger ? <ShieldAlert /> : <ShieldCheck />}</div><h2 id="dialog-title">{title}</h2><p id="dialog-description">{text}</p><div className="dialog-actions"><button ref={cancelRef} className="button secondary" onClick={onCancel}>Cancel</button><button className={`button ${danger ? "danger" : "primary"}`} onClick={onConfirm}>{confirmLabel}</button></div></div></div>;
}

interface LatestDecision { record: AuditRecord; quote: string | null; upstreamCalled: boolean; }

function findLatestDecision(records: AuditRecord[]): LatestDecision | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record?.verdict || !verdictOrder.includes(record.verdict as typeof verdictOrder[number])) continue;
    const later = records.slice(index + 1);
    const nextDecision = later.findIndex((item) => Boolean(item.verdict));
    const related = nextDecision === -1 ? later : later.slice(0, nextDecision);
    return { record, quote: typeof record.details.quote === "string" ? record.details.quote : null, upstreamCalled: record.upstreamEffect.includes("called") || related.some((item) => item.upstreamEffect.includes("called")) };
  }
  return null;
}

function auditContinuity(records: AuditRecord[]): boolean {
  return records.every((record, index) => index === 0 || record.previousHash === records[index - 1]?.evidenceHash);
}

function VerdictDistribution({ records }: { records: AuditRecord[] }) {
  const counts = verdictOrder.map((verdict) => ({ verdict, count: records.filter((record) => record.verdict === verdict).length }));
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  const portions = counts.map(({ count }) => total === 0 ? 0 : (count / total) * 100);
  const stops = portions.reduce<number[]>((result, portion, index) => [...result, portion + (result[index - 1] ?? 0)], []);
  const ringStyle = total === 0 ? undefined : {
    background: `conic-gradient(var(--green) 0% ${stops[0]}%, var(--red) ${stops[0]}% ${stops[1]}%, var(--amber) ${stops[1]}% ${stops[2]}%, var(--blue) ${stops[2]}% 100%)`
  } as CSSProperties;
  const chartLabel = counts.map(({ verdict, count }) => `${verdict.replaceAll("_", " ")} ${count}`).join(", ");
  return <div className="distribution">{total === 0 ? <Empty icon={Activity} title="No audited verdicts" text="Run a deterministic example to populate this distribution." /> : <div className="distribution-visual"><div className="distribution-ring" style={ringStyle} role="img" aria-label={`Verdict distribution: ${chartLabel}`}><span><strong>{total}</strong><small>decisions</small></span></div><div className="distribution-legend">{counts.map(({ verdict, count }) => <div className="distribution-row" key={verdict}><i className={`tone-${verdict.toLowerCase()}`} aria-hidden="true" /><span>{verdict === "HOLD_FOR_APPROVAL" ? "HOLD" : verdict}</span><strong>{count}</strong></div>)}</div></div>}<p className="data-source">Source: local Control Room audit, {total} policy decision{total === 1 ? "" : "s"}.</p></div>;
}

function LifecycleEvidence({ data }: { data: EvidenceData }) {
  const lifecycle = data.operationalEvidence?.executorLifecycle;
  if (!lifecycle) return <Empty icon={CircleDollarSign} title="Lifecycle evidence unavailable" text="No executor lifecycle artifact was returned." />;
  return <div className="lifecycle-evidence"><div className="lifecycle-lane"><span>Confirmed success</span><div><b className="state reserved">RESERVED <strong>{lifecycle.reservedObserved}</strong></b><ArrowRight aria-hidden="true" /><b className="state committed">COMMITTED <strong>{lifecycle.committedObserved}</strong></b></div></div><div className="lifecycle-lane"><span>Timeout uncertainty</span><div><b className="state reserved">RESERVED</b><ArrowRight aria-hidden="true" /><b className="state doubt">IN_DOUBT <strong>{lifecycle.inDoubtObserved}</strong></b></div></div><div className="lifecycle-foot"><span>Definitive failure released</span><strong>{lifecycle.releasedObserved}</strong></div><p className="data-source">Source: {lifecycle.sourceArtifact}.json. {titleCase(lifecycle.provenance)}. {lifecycle.realMutations} real mutations.</p></div>;
}

function Overview({ data, evidence, audit, onNavigate, onInspectRule }: { data: OverviewData; evidence: EvidenceData; audit: AuditRecord[]; onNavigate: (tab: Tab) => void; onInspectRule: (ruleId: string | null) => void }) {
  const latest = findLatestDecision(audit);
  const progress = data.budget.limitPaise ? Math.min(100, (data.budget.usedPaise / data.budget.limitPaise) * 100) : 0;
  const callProgress = data.budget.maxCalls ? Math.min(100, (data.budget.calls / data.budget.maxCalls) * 100) : 0;
  const payment = evidence.operationalEvidence?.paymentLifecycle;
  const recentHashes = audit.slice(-5);
  return <div className="screen overview-screen"><div className="page-heading compact-heading"><div><span className="kicker">Deterministic payment safety</span><h1>Control Room</h1><p>Merchant authority, decision evidence, and unresolved external state in one operating view.</p></div><button className="button primary" onClick={() => onNavigate("agent")}><Play size={16} aria-hidden="true" />Propose Action</button></div>
    <div className="overview-grid"><Section icon={Shield} title="Latest Deterministic Verdict" meta={latest ? `Audit sequence ${latest.record.seq}` : "No gateway decision recorded"} className={`decision-inspector decision-${latest?.record.verdict?.toLowerCase() ?? "none"}`}>{latest ? <div className="decision-body"><div className="decision-verdict"><VerdictBadge verdict={latest.record.verdict} /><strong>{latest.record.verdict?.replaceAll("_", " ")}</strong><span>{titleCase(latest.record.action)}</span></div><dl className="decision-facts"><div><dt>Responsible Rule</dt><dd>{isMandateRule(latest.record.rule) ? <button className="rule-link" onClick={() => onInspectRule(latest.record.rule)}>{latest.record.rule}<ChevronRight size={14} aria-hidden="true" /></button> : latest.record.rule ?? "All checks passed"}</dd></div><div className="rule-quote"><dt>{latest.quote ? "Exact Rule Text" : latest.record.rule ? "System Check" : "Policy Outcome"}</dt><dd>{latest.quote ? <q>{latest.quote}</q> : ruleText(latest.record.rule, null)}</dd></div><div><dt>Upstream Call</dt><dd className={latest.upstreamCalled ? "text-warn" : "text-good"}>{latest.upstreamCalled ? "YES · DETERMINISTIC FAKE" : "NO"}</dd></div><div><dt>Recorded</dt><dd>{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(latest.record.timestamp))}</dd></div></dl></div> : <Empty icon={Shield} title="No deterministic verdict yet" text="The interface will not infer a decision. Run an action to create audited evidence." />}</Section>
      <div className="overview-side"><Section icon={Activity} title="Verdict Distribution" meta="Audited gateway decisions"><VerdictDistribution records={audit} /></Section></div></div>
    <div className="operational-band">
      <div><span>24-hour budget</span><button className="stat-link" title="Open audited decisions" aria-label="Open audited decisions" onClick={() => onNavigate("audit")}><ArrowUpRight size={14} aria-hidden="true" /></button><strong>{money(data.budget.usedPaise)} <small>of {money(data.budget.limitPaise)}</small></strong><div className="budget-track" role="meter" aria-label="Value budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><i style={{ width: `${progress}%` }} /></div></div>
      <div><span>Action budget</span><button className="stat-link" title="Open audited actions" aria-label="Open audited actions" onClick={() => onNavigate("audit")}><ArrowUpRight size={14} aria-hidden="true" /></button><strong>{data.budget.calls} <small>of {data.budget.maxCalls}</small></strong><p>Current local store</p><div className="budget-track" role="meter" aria-label="Action budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(callProgress)}><i style={{ width: `${callProgress}%` }} /></div></div>
      <div><span>Kill switch</span><button className="stat-link" title="Open agent controls" aria-label="Open agent controls" onClick={() => onNavigate("agent")}><ArrowUpRight size={14} aria-hidden="true" /></button><strong className={data.killSwitch ? "text-bad" : "text-good"}>{data.killSwitch ? "ENGAGED" : "OFF"}</strong><p>Checked before dispatch</p></div>
      <div><span>Mandate authority</span><button className="stat-link" title="Inspect approved mandate" aria-label="Inspect approved mandate" onClick={() => onNavigate("mandate")}><ArrowUpRight size={14} aria-hidden="true" /></button><strong>v{data.mandate.version}</strong><p>Approved by {data.mandate.approvedBy}</p></div>
    </div>
    <div className="overview-lower"><Section icon={CircleDollarSign} title="Budget Lifecycle" meta="Deterministic evidence"><LifecycleEvidence data={evidence} /></Section><Section icon={Fingerprint} title="Audit Hash-Chain Continuity" meta={`${audit.length} local record${audit.length === 1 ? "" : "s"}`} action={<Status tone={audit.length === 0 ? "neutral" : auditContinuity(audit) ? "good" : "bad"}>{audit.length === 0 ? "EMPTY" : auditContinuity(audit) ? "CONTINUOUS" : "BREAK DETECTED"}</Status>}>{recentHashes.length ? <div className="hash-chain">{recentHashes.map((record, index) => <div className="hash-node" key={record.seq}><span>#{record.seq}</span><code title={record.evidenceHash}>{compactHash(record.evidenceHash)}</code>{index < recentHashes.length - 1 && <ArrowRight aria-hidden="true" />}</div>)}</div> : <Empty icon={History} title="Chain has no local records" text="No continuity claim is shown until evidence exists." />}<button className="section-link" onClick={() => onNavigate("audit")}>Open Audit Inspector <ChevronRight size={14} aria-hidden="true" /></button></Section>
      <Section icon={FileClock} title="Payment Lifecycle" meta="External evidence" action={<Status tone="warn">PENDING EXTERNAL REPLAY</Status>}><div className="payment-timeline"><div className="timeline-step complete"><i aria-hidden="true" /><span><strong>Original Test Mode Delivery</strong><small>Missed while the tunnel was offline</small></span></div><div className="timeline-step current"><i aria-hidden="true" /><span><strong>Provider Replay</strong><small>{payment?.reason ?? "External replay evidence has not arrived."}</small></span></div><div className="timeline-step unresolved"><i aria-hidden="true" /><span><strong>Signature Verification</strong><small>Unresolved until genuine raw bytes reach the existing listener</small></span></div></div><div className="authorization-note"><LockKeyhole size={16} aria-hidden="true" /><span>Additional transaction authorized</span><strong>{payment?.additionalTransactionAuthorized ? "YES" : "NO"}</strong></div></Section></div>
  </div>;
}

function describeRule(rule: Rule): string {
  if (rule.rule === "tool_allowlist") return rule.tools?.join(", ") ?? "";
  if (rule.max_paise !== undefined) return `${rule.tool}: up to ${money(rule.max_paise)}`;
  if (rule.above_paise !== undefined) return `${rule.tool}: above ${money(rule.above_paise)}`;
  if (rule.allowed) return `${rule.allowed} · ${rule.timezone}`;
  if (rule.assert) return `${rule.tool}: ${rule.assert}`;
  if (rule.max_total_paise !== undefined) return `${money(rule.max_total_paise)} · ${rule.max_calls} calls / 24h`;
  return "Configured rule";
}

function RuleTable({ rules, highlightedRule, idPrefix = "rule" }: { rules: Rule[]; highlightedRule?: string | null; idPrefix?: string }) {
  return <div className="table-wrap"><table><thead><tr><th>Rule</th><th>Constraint</th><th>Exact Source Quotation</th></tr></thead><tbody>{rules.map((rule, index) => { const id = rule.id ?? `B${index + 1}`; return <tr id={`${idPrefix}-${id}`} className={highlightedRule === id ? "highlighted-rule" : ""} key={`${id}-${index}`}><td><code>{id}</code><span className="subcell">{titleCase(rule.rule ?? rule.window ?? "rolling budget")}</span></td><td>{describeRule(rule)}</td><td><q>{rule.quote}</q></td></tr>; })}</tbody></table></div>;
}

function Mandate({ data, highlightedRule, onUpdate, notify }: { data: MandateData; highlightedRule: string | null; onUpdate: (data: MandateData) => void; notify: (message: string) => void }) {
  const [source, setSource] = useState(data.approved.source_text || defaultInstruction);
  const [working, setWorking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [approver, setApprover] = useState("demo-merchant");
  const [error, setError] = useState("");
  const draft = data.draft;
  const allDraftRules = draft ? [...draft.rules.constraints, ...draft.rules.budgets] : [];
  useEffect(() => {
    if (!highlightedRule) return;
    requestAnimationFrame(() => {
      const row = document.getElementById(`rule-${highlightedRule}`);
      if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "center" });
    });
  }, [highlightedRule]);
  async function generateDraft() { setWorking(true); setError(""); try { onUpdate(await api.draft(source)); notify("Draft generated. It is not active."); } catch (caught) { setError(caught instanceof Error ? caught.message : "Draft failed. Check the instruction and try again."); } finally { setWorking(false); } }
  async function approve() { if (!draft) return; setWorking(true); setError(""); setConfirm(false); try { onUpdate(await api.approve(draft.draft_id, approver)); notify("Mandate approved and activated."); } catch (caught) { setError(caught instanceof Error ? caught.message : "Approval failed. Review the draft and retry."); } finally { setWorking(false); } }
  return <div className="screen"><div className="page-heading"><div><span className="kicker">Human authority</span><h1>Mandate</h1><p>Draft offline, review exact quotations, then approve explicitly.</p></div><Status tone="good">APPROVED v{data.approved.version}</Status></div><div className="mandate-layout"><Section icon={FileCheck2} title="Merchant Instruction" meta="Deterministic fake compiler"><label className="field-label" htmlFor="instruction">Financial Rules in Plain English</label><textarea id="instruction" name="instruction" autoComplete="off" value={source} onChange={(event) => setSource(event.target.value)} rows={9} /><div className="composer-footer"><span>{source.length.toLocaleString()} / 20,000</span><button className="button primary" disabled={working || !source.trim()} onClick={generateDraft}>{working ? <RefreshCw className="spin" size={16} aria-hidden="true" /> : <FileCheck2 size={16} aria-hidden="true" />}Generate Draft</button></div>{error && <div className="inline-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}</Section><Section icon={LockKeyhole} title="Authority Boundary" meta="Enforcement state"><div className="boundary-callout"><LockKeyhole aria-hidden="true" /><div><strong>{draft ? "Draft cannot enforce policy" : "Approved mandate is active"}</strong><p>{data.enforcementBoundary}</p></div></div><dl className="detail-list"><div><dt>Mandate</dt><dd>{data.approved.mandate_id}</dd></div><div><dt>Active Version</dt><dd>{data.approved.version}</dd></div><div><dt>Approved By</dt><dd>{data.approved.approved_by}</dd></div><div><dt>Content Hash</dt><dd><code title={data.approved.mandate_hash}>{compactHash(data.approved.mandate_hash)}</code></dd></div></dl></Section></div>
    <Section icon={FileCheck2} title={draft ? "Approved Rules" : "Structured Rules"} meta={`Active version ${data.approved.version}`}><RuleTable rules={[...data.approved.constraints, ...data.approved.budgets]} highlightedRule={highlightedRule} /></Section>
    {draft && <Section icon={FileClock} title={`Draft v${draft.proposed_version}`} meta={draft.review.approvable ? "Ready for human review · not active" : "Review required · not active"} action={<Status tone={draft.review.approvable ? "good" : "warn"}>{draft.review.approvable ? "APPROVABLE" : "NOT APPROVABLE"}</Status>}><div className="draft-meta"><span><code>{draft.draft_id}</code></span><span>{draft.compiler.provider} · {draft.compiler.model}</span><span><code>{compactHash(draft.draft_hash)}</code></span></div><RuleTable rules={allDraftRules} idPrefix="draft-rule" /><div className="review-grid"><div><h3>Source Coverage</h3><strong>{draft.review.source_references.length}</strong><span>Exact quotations verified</span></div><div><h3>Unsupported</h3><strong>{draft.review.unsupported_instructions.length}</strong><span>{draft.review.unsupported_instructions[0]?.reason ?? "None"}</span></div><div><h3>Ambiguous</h3><strong>{draft.review.ambiguities.length}</strong><span>{draft.review.ambiguities[0]?.reason ?? "None"}</span></div><div><h3>Changes</h3><strong>{data.diff.filter((item) => item.operation !== "UNCHANGED").length}</strong><span>From approved v{data.approved.version}</span></div></div>{draft.review.conservative_assumptions.length > 0 && <div className="assumptions"><strong>Conservative Assumptions</strong>{draft.review.conservative_assumptions.map((item) => <span key={item}><Check size={14} aria-hidden="true" />{item}</span>)}</div>}<div className="approval-bar"><div><label className="field-label" htmlFor="approver">Approval Identity</label><input id="approver" name="approver" autoComplete="off" spellCheck={false} value={approver} onChange={(event) => setApprover(event.target.value)} /></div><button className="button primary" disabled={!draft.review.approvable || working || approver.trim().length < 2} onClick={() => setConfirm(true)}><KeyRound size={16} aria-hidden="true" />Approve v{draft.proposed_version}</button></div></Section>}
    <ConfirmDialog open={confirm} title={`Activate Mandate v${draft?.proposed_version ?? ""}?`} text="This explicit action replaces the current policy authority. The draft hash and approval identity will be recorded." confirmLabel="Approve and Activate" onCancel={() => setConfirm(false)} onConfirm={approve} /></div>;
}

function Agent({ overview, onActivity, onInspectRule, notify }: { overview: OverviewData; onActivity: () => Promise<void>; onInspectRule: (ruleId: string) => void; notify: (message: string) => void }) {
  const [objective, setObjective] = useState("Create an order for 19900 paise.");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [confirmKill, setConfirmKill] = useState(false);
  const [pendingRun, setPendingRun] = useState<{ example?: string; label: string } | null>(null);

  async function run() {
    const requested = pendingRun;
    if (!requested) return;
    setPendingRun(null); setWorking(true); setError("");
    try {
      const next = await api.runAgent(objective, requested.example);
      setResult(next);
      await onActivity();
      notify(`${next.verdict.replaceAll("_", " ")} · ${next.upstreamCallCount} upstream call${next.upstreamCallCount === 1 ? "" : "s"}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Agent run failed. Check the objective and retry."); }
    finally { setWorking(false); }
  }

  async function changeKillSwitch() {
    const next = !overview.killSwitch;
    setWorking(true); setConfirmKill(false); setError("");
    try { await api.killSwitch(next); await onActivity(); notify(`Kill switch ${next ? "engaged" : "released"}.`); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Control change failed. Retry the operation."); }
    finally { setWorking(false); }
  }

  function requestRun(example?: { id: string; label: string }) {
    setPendingRun({ ...(example ? { example: example.id } : {}), label: example?.label ?? "Custom objective" });
  }

  return <div className="screen"><div className="page-heading"><div><span className="kicker">Constrained fake planner</span><h1>Agent</h1><p>The model proposes. The gateway validates. Deterministic policy decides.</p></div><button className={`button ${overview.killSwitch ? "danger" : "secondary"}`} onClick={() => setConfirmKill(true)}>{overview.killSwitch ? <ToggleRight size={18} aria-hidden="true" /> : <ToggleLeft size={18} aria-hidden="true" />}Kill Switch {overview.killSwitch ? "On" : "Off"}</button></div>
    <Section icon={Bot} title="Propose an Action" meta="Gateway-only execution"><label className="field-label" htmlFor="objective">Agent Objective</label><div className="objective-row"><input id="objective" name="objective" autoComplete="off" value={objective} onChange={(event) => setObjective(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && objective.trim()) { event.preventDefault(); requestRun(); } }} /><button className="button primary" disabled={working || !objective.trim()} onClick={() => requestRun()}>{working ? <RefreshCw className="spin" size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}Run Objective</button></div><div className="example-list" aria-label="Deterministic examples">{examples.map((example) => <button key={example.id} disabled={working} onClick={() => requestRun(example)}>{example.label}<ChevronRight size={14} aria-hidden="true" /></button>)}</div>{error && <div className="inline-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}</Section>
    {result ? <div className="result-layout">
      <Section icon={Shield} title="Deterministic Verdict" meta={result.example ?? "Custom objective"} className={`verdict-panel verdict-${result.verdict.toLowerCase()}`}>
        <div className="verdict-hero"><VerdictBadge verdict={result.verdict} /><h2>{result.verdict === "ALLOW" ? "Action May Proceed" : result.verdict === "HOLD_FOR_APPROVAL" ? "Human Approval Required" : result.verdict === "ABSTAIN" ? "Evidence Is Insufficient" : result.verdict === "PLANNER_REJECTED" ? "Proposal Rejected Before Gateway" : "Action Blocked"}</h2><p>{agentExplanation(result)}</p></div>
        {result.quote && <blockquote><q>{result.quote}</q>{result.ruleId && <button className="rule-link" onClick={() => onInspectRule(result.ruleId!)}>{result.ruleId}<ChevronRight size={14} aria-hidden="true" /></button>}</blockquote>}
        <div className="call-counters"><div><span>Gateway Calls</span><strong>{result.gatewayCallCount}</strong></div><ArrowRight aria-hidden="true" /><div><span>Upstream Calls</span><strong className={result.upstreamCallCount === 0 ? "text-good" : "text-warn"}>{result.upstreamCallCount}</strong></div></div>
      </Section>
      <Section icon={FileCheck2} title="Proposal Envelope" meta="Sanitized"><dl className="detail-list"><div><dt>Tool</dt><dd><code>{result.proposedTool ?? "none"}</code></dd></div><div><dt>Intent ID</dt><dd><code>{result.intentId ?? "not issued"}</code></dd></div><div><dt>Rule</dt><dd>{result.ruleId ?? "all checks passed"}</dd></div></dl><div className="code-block"><span>ARGUMENTS</span><pre>{JSON.stringify(result.arguments, null, 2)}</pre></div></Section>
    </div> : <Empty icon={Bot} title="No action proposed yet" text="Run the ₹199 order for the shortest complete enforcement path." />}
    <ConfirmDialog open={Boolean(pendingRun)} title={`Run ${pendingRun?.label ?? "Objective"}?`} text="This calls the local deterministic planner and gateway. Only an ALLOW verdict may reach the deterministic fake upstream." confirmLabel="Run Through Gateway" onCancel={() => setPendingRun(null)} onConfirm={() => void run()} />
    <ConfirmDialog open={confirmKill} danger={!overview.killSwitch} title={`${overview.killSwitch ? "Release" : "Engage"} the Kill Switch?`} text={overview.killSwitch ? "New actions will return to normal mandate evaluation." : "Every proposed action will be blocked before any fake upstream call."} confirmLabel={overview.killSwitch ? "Release Switch" : "Engage Switch"} onCancel={() => setConfirmKill(false)} onConfirm={() => void changeKillSwitch()} /></div>;
}

function Audit({ records, onRefresh, onInspectRule }: { records: AuditRecord[]; onRefresh: () => Promise<void>; onInspectRule: (ruleId: string) => void }) {
  const [verification, setVerification] = useState<{ valid: boolean; records: number; reason: string; simulated: boolean } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  async function verify(simulateTamper = false) { setWorking(true); try { setVerification(await api.verifyLedger(simulateTamper)); await onRefresh(); } finally { setWorking(false); } }
  const continuity = records.length > 0 && auditContinuity(records);
  return <div className="screen"><div className="page-heading"><div><span className="kicker">Tamper-evident history</span><h1>Audit</h1><p>Expand each sanitized record to inspect policy context and chain linkage.</p></div><div className="heading-actions"><button className="button secondary" disabled={working} onClick={() => void verify(true)}>Simulate Tamper</button><button className="button primary" disabled={working} onClick={() => void verify(false)}><ShieldCheck size={16} aria-hidden="true" />Verify Ledger</button></div></div><div className="audit-summary"><div><span>Local Record Chain</span><strong className={continuity ? "text-good" : records.length ? "text-bad" : ""}>{records.length ? continuity ? "CONTINUOUS" : "BREAK DETECTED" : "EMPTY"}</strong></div><div><span>Records</span><strong>{records.length}</strong></div><div><span>Repository Ledger</span><strong>{verification ? verification.valid ? "VALID" : "INVALID" : "NOT CHECKED THIS SESSION"}</strong></div></div>{verification && <div className={`verification-banner ${verification.valid ? "valid" : "invalid"}`} role="status">{verification.valid ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}<div><strong>{verification.valid ? "Ledger Valid" : "Tamper Detected"}</strong><span>{verification.reason}. {verification.records} record{verification.records === 1 ? "" : "s"}{verification.simulated ? ". Isolated simulation." : "."}</span></div></div>}<Section icon={History} title="Chronological Evidence" meta={`${records.length} local Control Room records`}>{records.length ? <div className="table-wrap"><table className="audit-table"><thead><tr><th>Record</th><th>Action</th><th>Verdict / Rule</th><th>Upstream</th><th>Evidence Hash</th></tr></thead><tbody>{[...records].reverse().map((record) => <AuditRows key={record.seq} record={record} expanded={expanded === record.seq} onToggle={() => setExpanded(expanded === record.seq ? null : record.seq)} onInspectRule={onInspectRule} />)}</tbody></table></div> : <Empty icon={History} title="No local actions yet" text="Run an agent example or create a mandate draft to add evidence." />}</Section></div>;
}

function AuditRows({ record, expanded, onToggle, onInspectRule }: { record: AuditRecord; expanded: boolean; onToggle: () => void; onInspectRule: (ruleId: string) => void }) {
  return <><tr className={expanded ? "expanded" : ""}><td><button className="audit-expand" aria-expanded={expanded} aria-controls={`audit-detail-${record.seq}`} onClick={onToggle}>{expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}<span>{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(record.timestamp))}<small>{record.actor} · #{record.seq}</small></span></button></td><td>{titleCase(record.action)}<span className="subcell">{record.stateTransition}</span></td><td><VerdictBadge verdict={record.verdict} />{record.rule && <button className="table-rule-link" onClick={() => onInspectRule(record.rule!)}>{record.rule}</button>}</td><td>{record.upstreamEffect}</td><td><code title={record.evidenceHash}>{compactHash(record.evidenceHash)}</code></td></tr>{expanded && <tr className="audit-detail-row" id={`audit-detail-${record.seq}`}><td colSpan={5}><dl><div><dt>Previous Hash</dt><dd><code>{record.previousHash}</code></dd></div><div><dt>Evidence Hash</dt><dd><code>{record.evidenceHash}</code></dd></div>{Object.entries(record.details).map(([key, value]) => <div key={key}><dt>{titleCase(key)}</dt><dd>{value !== null && typeof value === "object" ? <pre className="audit-json">{JSON.stringify(value, null, 2)}</pre> : String(value)}</dd></div>)}</dl></td></tr>}</>;
}

function Lab({ scenarios }: { scenarios: ScenarioSummary[] }) {
  const [selected, setSelected] = useState(scenarios[0]?.id ?? "");
  const [result, setResult] = useState<LabResult | null>(null);
  const [eventIndex, setEventIndex] = useState(0);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function replay() { if (!selected) return; setWorking(true); setError(""); try { const next = await api.replay(selected); setResult(next); setEventIndex(0); } catch (caught) { setError(caught instanceof Error ? caught.message : "Replay failed. Select a scenario and retry."); } finally { setWorking(false); } }
  const activeEvent = result?.timeline[eventIndex];
  return <div className="screen"><div className="page-heading"><div><span className="kicker">Synthetic chaos · existing Lab engine</span><h1>Counterfactual Lab</h1><p>Select and inspect deterministic event order without contacting Razorpay.</p></div></div><Section icon={FlaskConical} title="Replay Scenario" meta={`${scenarios.length} checked-in scenarios`}><div className="replay-controls"><label className="sr-only" htmlFor="scenario">Replay Scenario</label><select id="scenario" name="scenario" value={selected} onChange={(event) => setSelected(event.target.value)}>{scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name} · {scenario.events} events</option>)}</select><button className="button primary" disabled={working || !selected} onClick={() => void replay()}>{working ? <RefreshCw className="spin" size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}Replay</button></div><p className="scenario-description">{scenarios.find((scenario) => scenario.id === selected)?.description}</p>{error && <div className="inline-error" role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}</Section>
    {result ? <><div className="comparison-grid"><div className="model-state unsafe"><span>Unsafe Reference</span><strong>{result.comparison.unsafePassed ? "PASS" : "FAIL"}</strong><p>Counterfactual baseline</p></div><ArrowRight className="comparison-arrow" aria-hidden="true" /><div className="model-state safe"><span>IntentProof</span><strong>{result.comparison.intentProofPassed ? "PASS" : "FAIL"}</strong><p>Invariant outcome</p></div><div className="trace-state"><span>Trace Minimized</span><strong>{result.comparison.originalTraceLength} <small>→</small> {result.comparison.minimizedTraceLength}</strong><p>{result.comparison.invariant}</p></div></div><div className="lab-layout"><Section icon={Activity} title="Counterfactual Event Sequence" meta={`${result.timeline.length} deterministic events`}><div className="scrubber"><label htmlFor="event-scrubber">Selected Event</label><input id="event-scrubber" name="selected-event" type="range" min="0" max={Math.max(0, result.timeline.length - 1)} value={eventIndex} onChange={(event) => setEventIndex(Number(event.target.value))} /><output>{eventIndex + 1} / {result.timeline.length}</output></div><div className="timeline">{result.timeline.map((event, index) => <button key={`${event.type}-${index}`} className={eventIndex === index ? "active" : ""} aria-pressed={eventIndex === index} onClick={() => setEventIndex(index)}><span>{event.atMs}ms</span><i aria-hidden="true" /><span><strong>{titleCase(event.type)}</strong><small>{event.summary}</small></span></button>)}</div></Section><Section icon={Gauge} title="Event & Invariant Inspector" meta={`Seed ${result.scenario.seed}`}>{activeEvent && <div className="event-inspector"><span>EVENT {eventIndex + 1}</span><strong>{titleCase(activeEvent.type)}</strong><p>{activeEvent.summary}</p><code>{activeEvent.atMs}ms virtual time</code></div>}<div className="digest-row"><span>State Digest</span><code title={result.scenario.digest}>{compactHash(result.scenario.digest)}</code></div><div className="invariant-list">{result.invariants.map((item) => <div key={item.id}><span className={item.passed ? "check good" : "check bad"}>{item.passed ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}</span><div><strong>{titleCase(item.id)}</strong><p>{item.violations[0] ?? item.observations[0] ?? "Invariant held across the trace."}</p></div></div>)}</div><div className="failure-note"><AlertTriangle size={17} aria-hidden="true" /><span><strong>Observed Counterfactual Failure</strong>{result.comparison.explanation}</span></div></Section></div></> : <Empty icon={FlaskConical} title="Select a replay" text="The scenario runs locally against existing Lab logic, never Razorpay." />}</div>;
}

const provenanceLabels: Record<string, string> = {
  REAL_RAZORPAY_TEST_MODE: "Real Razorpay Test Mode",
  MOCKED_GEMINI: "Mocked Gemini",
  DETERMINISTIC_FAKE: "Deterministic Fake",
  SYNTHETIC_CHAOS: "Synthetic Chaos",
  LOCAL_VERIFICATION: "Local Verification",
  PENDING_EXTERNAL_REPLAY: "Pending External Replay"
};

function Evidence({ data }: { data: EvidenceData }) {
  const [filter, setFilter] = useState("ALL");
  const score = data.scoreboard;
  const provenanceEntries = Object.entries(score.provenance_counts).sort(([left], [right]) => left.localeCompare(right));
  const filtered = filter === "ALL" ? data.evidence : data.evidence.filter((item) => item.provenance === filter);
  const metrics = [["Tests Passed", score.tests_passed], ["Invariants Checked", score.invariants_checked], ["Failure Discovered", score.failures_independently_discovered], ["Trace Minimized", `${score.trace_original_events} → ${score.trace_minimized_events}`], ["Non-ALLOW Upstream Calls", score.non_allow_upstream_calls], ["Duplicate Effects Prevented", score.duplicate_effects_prevented]];
  return <div className="screen"><div className="page-heading"><div><span className="kicker">Verifiable proof bundle</span><h1>Evidence</h1><p>Every claim stays attached to repository-derived provenance.</p></div><Status tone={data.manifest.verified ? "good" : "bad"}>{data.manifest.verified ? `${data.manifest.artifactsVerified} ARTIFACTS VERIFIED` : "VERIFICATION FAILED"}</Status></div><section className="evidence-digest"><div><Fingerprint size={22} aria-hidden="true" /><span>MANIFEST DIGEST</span></div><code title={data.manifest.digest}>{data.manifest.digest}</code></section><div className="score-grid">{metrics.map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{String(value)}</strong></div>)}</div><div className="evidence-layout"><Section icon={Fingerprint} title="Evidence Register" meta={`${filtered.length} of ${data.evidence.length} artifacts shown`}><div className="filter-toolbar" role="toolbar" aria-label="Filter evidence by provenance"><button className={filter === "ALL" ? "active" : ""} aria-pressed={filter === "ALL"} onClick={() => setFilter("ALL")}>All <span>{data.evidence.length}</span></button>{provenanceEntries.map(([provenance, count]) => <button key={provenance} className={filter === provenance ? "active" : ""} aria-pressed={filter === provenance} onClick={() => setFilter(provenance)}>{provenanceLabels[provenance] ?? titleCase(provenance)} <span>{count}</span></button>)}</div>{filtered.length ? <div className="evidence-list">{filtered.map((item) => <div key={item.id}><span className={`provenance-icon provenance-${item.provenance.toLowerCase()}`}><FileCheck2 aria-hidden="true" /></span><div><strong>{titleCase(item.id)}</strong><span>{provenanceLabels[item.provenance] ?? titleCase(item.provenance)}</span></div><Status tone={item.status === "VERIFIED" ? "good" : "warn"}>{item.status}</Status></div>)}</div> : <Empty title="No evidence matches" text="Choose a different provenance filter." />}</Section><div className="evidence-side"><Section icon={Activity} title="Provenance Distribution" meta="Manifest counts"><div className="provenance-chart">{provenanceEntries.map(([provenance, count]) => <div key={provenance}><span>{provenanceLabels[provenance] ?? titleCase(provenance)}</span><div aria-hidden="true"><i style={{ width: `${data.evidence.length ? (count / data.evidence.length) * 100 : 0}%` }} /></div><strong>{count}</strong></div>)}</div><p className="data-source">Source: manifest.scoreboard.provenance_counts.</p></Section><Section icon={ShieldCheck} title="Scoreboard Integrity" meta="Local verification"><div className="integrity-stack"><div><span>Ledger</span><strong className={score.ledger_verified ? "text-good" : "text-bad"}>{score.ledger_verified ? "VALID" : "FAILED"}</strong></div><div><span>IntentProof Model</span><strong className="text-good">PASS</strong></div><div><span>Unsafe Model</span><strong className="text-bad">EXPECTED FAIL</strong></div><div><span>Genuine Webhook</span><strong className="text-warn">PENDING</strong></div></div><div className="limitations"><strong>Known Limits</strong>{data.limitations.map((item) => <p key={item}>{item}</p>)}</div></Section></div></div></div>;
}

function CommandBar({ overview, latest, onOpenMenu }: { overview: OverviewData; latest: LatestDecision | null; onOpenMenu: () => void }) {
  const latestVerdict = latest?.record.verdict ?? overview.lastVerdict;
  const latestLabel = latestVerdict?.replaceAll("_", " ") ?? "NOT RUN";
  return <header className="command-bar">
    <div className="mobile-command">
      <button className="icon-button" aria-label="Open navigation" title="Open navigation" onClick={onOpenMenu}><Menu aria-hidden="true" /></button>
      <div className="mobile-brand"><strong translate="no">IntentProof</strong><span>CONTROL ROOM</span></div>
      <strong className={`mobile-verdict text-${verdictTone(latestVerdict)}`}><span className="status-dot" aria-hidden="true" />{latestLabel}</strong>
    </div>
    <div className="command-status-rail" role="group" aria-label="Current safety status">
      <div className="command-brand"><strong translate="no">IntentProof</strong><span>CONTROL ROOM</span></div>
      <div className="command-segment"><span>Mandate</span><strong>v{overview.mandate.version}</strong></div>
      <div className="command-segment"><span>Kill Switch</span><strong className={overview.killSwitch ? "text-bad" : "text-good"}>{overview.killSwitch ? "ENGAGED" : "OFF"}</strong></div>
      <div className="command-segment pending-segment"><span>External Replay</span><strong>PENDING_EXTERNAL_REPLAY</strong></div>
      <div className="command-segment"><span>Latest Verdict</span><strong className={`text-${verdictTone(latestVerdict)}`}>{latestLabel}</strong></div>
    </div>
  </header>;
}

export function App() {
  const initialTab = typeof location !== "undefined" && nav.some((item) => `#${item.id}` === location.hash) ? location.hash.slice(1) as Tab : "overview";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [mandate, setMandate] = useState<MandateData | null>(null);
  const [evidence, setEvidence] = useState<EvidenceData | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [audit, setAudit] = useState<AuditRecord[]>([]);
  const [highlightedRule, setHighlightedRule] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState("");
  const [toast, setToast] = useState("");
  const [menu, setMenu] = useState(false);
  async function refreshAudit() { const data = await api.audit(); setAudit(data.records); }
  async function refreshActivity() { const [overviewData, auditData] = await Promise.all([api.overview(), api.audit()]); setOverview(overviewData); setAudit(auditData.records); }
  useEffect(() => { Promise.all([api.overview(), api.mandate(), api.evidence(), api.scenarios(), api.audit()]).then(([overviewData, mandateData, evidenceData, scenarioData, auditData]) => { setOverview(overviewData); setMandate(mandateData); setEvidence(evidenceData); setScenarios(scenarioData.scenarios); setAudit(auditData.records); }).catch((error: unknown) => setFatal(error instanceof Error ? error.message : "The Control Room could not start.")).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!toast) return; const timeout = setTimeout(() => setToast(""), 3200); return () => clearTimeout(timeout); }, [toast]);
  useEffect(() => { function syncHash() { const next = location.hash.slice(1); if (nav.some((item) => item.id === next)) setTab(next as Tab); } window.addEventListener("hashchange", syncHash); return () => window.removeEventListener("hashchange", syncHash); }, []);
  const latest = useMemo(() => findLatestDecision(audit), [audit]);
  function navigate(next: Tab) { setTab(next); setMenu(false); history.replaceState(null, "", `#${next}`); if (next === "audit") void refreshAudit(); }
  function inspectRule(ruleId: string | null) { if (!ruleId) return; setHighlightedRule(ruleId); navigate("mandate"); }
  if (loading) return <div className="boot" role="status" aria-live="polite"><div className="brand-mark"><ShieldCheck aria-hidden="true" /></div><strong translate="no">IntentProof</strong><span>Verifying local evidence…</span><div className="skeleton-lines" aria-hidden="true"><i /><i /><i /></div></div>;
  if (fatal || !overview || !mandate || !evidence) return <div className="boot error" role="alert"><AlertTriangle aria-hidden="true" /><strong>Control Room Unavailable</strong><span>{fatal || "Required local data is missing."}</span><button className="button primary" onClick={() => location.reload()}>Retry</button></div>;
  return <div className="app-shell"><a className="skip-link" href="#main-content">Skip to Control Room</a><aside className={menu ? "open" : ""} aria-label="Primary navigation"><div className="brand"><div className="brand-mark"><ShieldCheck aria-hidden="true" /></div><div><strong translate="no">IntentProof</strong><span>CONTROL ROOM</span></div><button className="icon-button mobile-close" aria-label="Close navigation" title="Close navigation" onClick={() => setMenu(false)}><X aria-hidden="true" /></button></div><nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.items.map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} aria-current={tab === id ? "page" : undefined} className={tab === id ? "active" : ""} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(id); }}><Icon size={18} aria-hidden="true" /><span>{label}</span>{tab === id && <ChevronRight size={15} aria-hidden="true" />}</a>)}</div>)}</nav><div className="environment"><span>EXECUTION BOUNDARY</span><div><i aria-hidden="true" />Razorpay Test Mode</div><div><i className="fake" aria-hidden="true" />Deterministic fake</div><div><i className="pending" aria-hidden="true" />Webhook unresolved</div></div><div className="sidebar-foot"><Shield size={15} aria-hidden="true" /><span>No live credentials<br />No real money</span></div></aside>{menu && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMenu(false)} />}<main><CommandBar overview={overview} latest={latest} onOpenMenu={() => setMenu(true)} /><div className="workspace-scroll" id="main-content" tabIndex={-1}>{tab === "overview" && <Overview data={overview} evidence={evidence} audit={audit} onNavigate={navigate} onInspectRule={inspectRule} />}{tab === "mandate" && <Mandate data={mandate} highlightedRule={highlightedRule} onUpdate={(data) => { setMandate(data); void refreshActivity(); }} notify={setToast} />}{tab === "agent" && <Agent overview={overview} onActivity={refreshActivity} onInspectRule={inspectRule} notify={setToast} />}{tab === "audit" && <Audit records={audit} onRefresh={refreshAudit} onInspectRule={inspectRule} />}{tab === "lab" && <Lab scenarios={scenarios} />}{tab === "evidence" && <Evidence data={evidence} />}</div></main>{toast && <div className="toast" role="status" aria-live="polite"><CheckCircle2 size={18} aria-hidden="true" />{toast}</div>}</div>;
}
