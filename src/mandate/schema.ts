import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "../ledger/canonical.js";

export const supportedToolSchema = z.enum([
  "create_order",
  "create_payment_link",
  "capture_payment",
  "fetch_order",
  "fetch_payment"
]);

const ruleBase = z.object({
  id: z.string().min(1),
  quote: z.string().min(1)
}).strict();

const toolAllowlist = ruleBase.extend({
  rule: z.literal("tool_allowlist"),
  tools: z.array(supportedToolSchema).min(1)
}).strict();

const amountCeiling = ruleBase.extend({
  rule: z.literal("amount_ceiling"),
  tool: supportedToolSchema,
  max_paise: z.number().int().nonnegative()
}).strict();

const precondition = ruleBase.extend({
  rule: z.literal("precondition"),
  tool: z.literal("capture_payment"),
  assert: z.literal("delivery_confirmed"),
  on_unknown: z.literal("ABSTAIN")
}).strict();

const approvalGate = ruleBase.extend({
  rule: z.literal("approval_gate"),
  tool: z.literal("capture_payment"),
  above_paise: z.number().int().nonnegative(),
  timeout_seconds: z.number().int().positive()
}).strict();

const timeWindow = ruleBase.extend({
  rule: z.literal("time_window"),
  allowed: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/u),
  timezone: z.string().min(1)
}).strict();

export const constraintSchema = z.discriminatedUnion("rule", [
  toolAllowlist,
  amountCeiling,
  precondition,
  approvalGate,
  timeWindow
]);

export const budgetSchema = z.object({
  window: z.literal("24h"),
  tool: z.literal("*"),
  max_total_paise: z.number().int().nonnegative(),
  max_calls: z.number().int().positive(),
  quote: z.string().min(1)
}).strict();

export const mandateRulesSchema = z.object({
  constraints: z.array(constraintSchema).min(1),
  budgets: z.array(budgetSchema)
}).strict().superRefine((rules, context) => {
  const ids = new Set<string>();
  for (const [index, constraint] of rules.constraints.entries()) {
    if (ids.has(constraint.id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate constraint id ${constraint.id}`,
        path: ["constraints", index, "id"]
      });
    }
    ids.add(constraint.id);
  }
});

const approvalMetadataSchema = z.object({
  draft_id: z.string().min(1),
  draft_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict();

const mandateFields = {
  status: z.literal("approved"),
  mandate_id: z.string().trim().min(1),
  version: z.number().int().positive(),
  source_text: z.string().min(1),
  approved_by: z.string().trim().min(1),
  approved_at: z.string().datetime({ offset: true }),
  approval: approvalMetadataSchema,
  revoked: z.boolean(),
  constraints: z.array(constraintSchema).min(1),
  budgets: z.array(budgetSchema),
  mandate_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
} as const;

export const mandateSchema = z
  .object(mandateFields)
  .strict()
  .superRefine((mandate, context) => {
    const ids = new Set<string>();
    for (const [index, constraint] of mandate.constraints.entries()) {
      if (ids.has(constraint.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate constraint id ${constraint.id}`,
          path: ["constraints", index, "id"]
        });
      }
      ids.add(constraint.id);
    }
    const quoted = [
      ...mandate.constraints.map((constraint) => ({ id: constraint.id, quote: constraint.quote })),
      ...mandate.budgets.map((budget, index) => ({ id: `budget:${index}`, quote: budget.quote }))
    ];

    for (const item of quoted) {
      if (!mandate.source_text.includes(item.quote)) {
        context.addIssue({
          code: "custom",
          message: `${item.id} quote is not an exact substring of source_text`,
          path: ["source_text"]
        });
      }
    }

    if (mandate.mandate_hash !== computeMandateHash(mandate)) {
      context.addIssue({
        code: "custom",
        message: "mandate_hash does not match the approved mandate content",
        path: ["mandate_hash"]
      });
    }
  });

export type SupportedTool = z.infer<typeof supportedToolSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
export type Mandate = z.infer<typeof mandateSchema>;
export type MandateRules = z.infer<typeof mandateRulesSchema>;

export interface QuoteSpan {
  start: number;
  end: number;
}

export function deriveQuoteSpan(sourceText: string, quote: string): QuoteSpan {
  const start = sourceText.indexOf(quote);
  if (start < 0) {
    throw new Error("Rule quote is not an exact substring of source_text");
  }
  return { start, end: start + quote.length };
}

export function computeMandateHash(
  mandate: Omit<Mandate, "mandate_hash"> | Mandate
): string {
  const {
    status,
    mandate_id,
    version,
    source_text,
    approved_by,
    approved_at,
    approval,
    revoked,
    constraints,
    budgets
  } = mandate;
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        status,
        mandate_id,
        version,
        source_text,
        approved_by,
        approved_at,
        approval,
        revoked,
        constraints,
        budgets
      })
    )
    .digest("hex")}`;
}
