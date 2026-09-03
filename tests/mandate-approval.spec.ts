import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  approveMandateDraft,
  diffMandates,
  loadMandateDraft,
  saveApprovedMandate
} from "../src/mandate/artifacts.js";
import { loadMandate } from "../src/mandate/load.js";
import { mandateSchema } from "../src/mandate/schema.js";
import { IntentProofGateway } from "../src/gateway/gateway.js";

const draft = loadMandateDraft(resolve("examples/mandates/shop-owner.draft.json"));
const approvedAt = "2026-09-01T09:05:00.000+05:30";

describe("explicit mandate approval and versioning", () => {
  it("does not parse a draft as an enforceable mandate", () => {
    expect(mandateSchema.safeParse(draft).success).toBe(false);
    expect(() => loadMandate(resolve("examples/mandates/shop-owner.draft.json"))).toThrow();
    expect(
      () =>
        new IntentProofGateway({
          mandate: draft as never,
          upstream: {
            listTools: async () => [],
            callTool: async () => ({ content: [] }),
            close: async () => undefined
          },
          policyContext: async () => ({
            now: new Date(0),
            killSwitch: false,
            expectedMandateVersion: 1,
            rollingCalls: 0,
            rollingValuePaise: 0
          })
        })
    ).toThrow();
  });

  it("requires an explicit approver identity", () => {
    expect(() =>
      approveMandateDraft({ draft, approvedBy: "", approvedAt })
    ).toThrow();
  });

  it("creates the same content hash for the same approved content", () => {
    const first = approveMandateDraft({ draft, approvedBy: "demo-merchant", approvedAt });
    const second = approveMandateDraft({ draft, approvedBy: "demo-merchant", approvedAt });

    expect(second.mandate_hash).toBe(first.mandate_hash);
    expect(first.mandate_hash).toBe(loadMandate(resolve("mandates/default.yaml")).mandate_hash);
  });

  it("rejects content changed after approval", () => {
    const mandate = approveMandateDraft({ draft, approvedBy: "demo-merchant", approvedAt });
    const changed = structuredClone(mandate);
    changed.constraints[1] = { ...changed.constraints[1]!, max_paise: 999_999 } as typeof changed.constraints[number];

    expect(mandateSchema.safeParse(changed).success).toBe(false);
  });

  it("writes an approved version once and refuses to overwrite it", () => {
    const directory = mkdtempSync(join(tmpdir(), "intentproof-mandate-"));
    const path = join(directory, "mandate.v1.json");
    const mandate = approveMandateDraft({ draft, approvedBy: "demo-merchant", approvedAt });
    try {
      saveApprovedMandate(path, mandate);
      expect(() => saveApprovedMandate(path, mandate)).toThrow();
      expect(loadMandate(path)).toEqual(mandate);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("produces a deterministic rule-by-rule version diff", () => {
    const before = loadMandate(resolve("mandates/default.yaml"));
    const afterRules = {
      constraints: before.constraints.map((constraint) =>
        constraint.id === "C2" ? { ...constraint, max_paise: 200_000 } : constraint
      ) as typeof before.constraints,
      budgets: before.budgets
    };
    const diff = diffMandates(before, afterRules);

    expect(diff.filter((entry) => entry.operation === "CHANGE").map((entry) => entry.rule_id)).toEqual(["C2"]);
  });

  it("keeps the original instruction and generated draft provenance", () => {
    const mandate = approveMandateDraft({ draft, approvedBy: "demo-merchant", approvedAt });

    expect(mandate.source_text).toBe(draft.source_text);
    expect(mandate.approval).toEqual({ draft_id: draft.draft_id, draft_hash: draft.draft_hash });
    expect(readFileSync(resolve("examples/mandates/shop-owner.draft.json"), "utf8")).toContain(draft.draft_id);
  });
});
