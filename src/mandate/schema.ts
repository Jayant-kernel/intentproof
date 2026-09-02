import { z } from "zod";

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
});

const toolAllowlist = ruleBase.extend({
  rule: z.literal("tool_allowlist"),
  tools: z.array(supportedToolSchema).min(1)
});

const amountCeiling = ruleBase.extend({
  rule: z.literal("amount_ceiling"),
  tool: supportedToolSchema,
  max_paise: z.number().int().nonnegative()
});

const precondition = ruleBase.extend({
  rule: z.literal("precondition"),
  tool: z.literal("capture_payment"),
  assert: z.literal("delivery_confirmed"),
  on_unknown: z.literal("ABSTAIN")
});

const approvalGate = ruleBase.extend({
  rule: z.literal("approval_gate"),
  tool: z.literal("capture_payment"),
  above_paise: z.number().int().nonnegative(),
  timeout_seconds: z.number().int().positive()
});

const timeWindow = ruleBase.extend({
  rule: z.literal("time_window"),
  allowed: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/u),
  timezone: z.string().min(1)
});

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
});

export const mandateSchema = z
  .object({
    mandate_id: z.string().min(1),
    version: z.number().int().positive(),
    source_text: z.string().min(1),
    approved_by: z.string().min(1),
    approved_at: z.string().datetime({ offset: true }).nullable(),
    revoked: z.boolean(),
    constraints: z.array(constraintSchema).min(1),
    budgets: z.array(budgetSchema)
  })
  .superRefine((mandate, context) => {
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
  });

export type SupportedTool = z.infer<typeof supportedToolSchema>;
export type Constraint = z.infer<typeof constraintSchema>;
export type Mandate = z.infer<typeof mandateSchema>;

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
