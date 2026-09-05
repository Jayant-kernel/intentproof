import type { AgentResult, AuditRecord, EvidenceData, LabResult, MandateData, OverviewData, ScenarioSummary } from "./types.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/control-room${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers
  });
  if (!response.ok) throw new Error(response.status === 400 ? "Check the input and try again." : "The local control service could not complete this request.");
  return response.json() as Promise<T>;
}

export const api = {
  overview: () => request<OverviewData>("/overview"),
  mandate: () => request<MandateData>("/mandate"),
  evidence: () => request<EvidenceData>("/evidence"),
  scenarios: () => request<{ scenarios: ScenarioSummary[] }>("/lab/scenarios"),
  audit: () => request<{ records: AuditRecord[] }>("/audit"),
  draft: (sourceText: string) => request<MandateData>("/mandate/draft", { method: "POST", body: JSON.stringify({ sourceText }) }),
  approve: (draftId: string, approvedBy: string) => request<MandateData>("/mandate/approve", { method: "POST", body: JSON.stringify({ draftId, approvedBy }) }),
  killSwitch: (engaged: boolean) => request<{ engaged: boolean }>("/kill-switch", { method: "POST", body: JSON.stringify({ engaged }) }),
  runAgent: (objective: string, example?: string) => request<AgentResult>("/agent/run", { method: "POST", body: JSON.stringify({ objective, ...(example ? { example } : {}) }) }),
  replay: (scenarioId: string) => request<LabResult>("/lab/replay", { method: "POST", body: JSON.stringify({ scenarioId }) }),
  verifyLedger: (simulateTamper = false) => request<{ valid: boolean; records: number; reason: string; simulated: boolean }>("/audit/verify", { method: "POST", body: JSON.stringify({ simulateTamper }) })
};
