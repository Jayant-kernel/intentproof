import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { canonicalJson } from "../ledger/canonical.js";
import {
  computeMandateHash,
  constraintSchema,
  deriveQuoteSpan,
  mandateSchema,
  mandateRulesSchema,
  budgetSchema,
  type Mandate,
  type MandateRules
} from "./schema.js";

const compilerReviewItemSchema = z.object({
  source_text: z.string().min(1),
  reason: z.string().min(1)
}).strict();

export const compilerOutputSchema = z.object({
  constraints: z.array(constraintSchema),
  budgets: z.array(budgetSchema),
  unsupported_instructions: z.array(compilerReviewItemSchema),
  ambiguities: z.array(compilerReviewItemSchema),
  conservative_assumptions: z.array(z.string().min(1))
}).strict();

const sourceReferenceSchema = z.object({
  rule_id: z.string().min(1),
  quote: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive()
}).strict();

const draftFields = {
  schema_version: z.literal(1),
  kind: z.literal("mandate_draft"),
  draft_id: z.string().min(1),
  draft_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  created_at: z.string().datetime({ offset: true }),
  compiler: z.object({
    provider: z.string().min(1),
    model: z.string().min(1)
  }).strict(),
  mandate_id: z.string().min(1),
  proposed_version: z.number().int().positive(),
  source_text: z.string().min(1),
  rules: z.object({
    constraints: z.array(constraintSchema),
    budgets: z.array(budgetSchema)
  }).strict(),
  review: z.object({
    approvable: z.boolean(),
    unsupported_instructions: z.array(compilerReviewItemSchema),
    ambiguities: z.array(compilerReviewItemSchema),
    conservative_assumptions: z.array(z.string().min(1)),
    validation_errors: z.array(z.string().min(1)),
    source_references: z.array(sourceReferenceSchema)
  }).strict()
} as const;

export const mandateDraftSchema = z.object(draftFields).strict().superRefine((draft, context) => {
  const expectedApprovable =
    draft.review.unsupported_instructions.length === 0 &&
    draft.review.ambiguities.length === 0 &&
    draft.review.validation_errors.length === 0;
  if (draft.review.approvable !== expectedApprovable) {
    context.addIssue({
      code: "custom",
      path: ["review", "approvable"],
      message: "approvable does not match the deterministic safety review"
    });
  }
  const expectedReferences = [
    ...draft.rules.constraints.map((constraint) => ({ rule_id: constraint.id, quote: constraint.quote })),
    ...draft.rules.budgets.map((budget, index) => ({ rule_id: `budget:${index}`, quote: budget.quote }))
  ];
  if (
    draft.review.approvable &&
    draft.review.source_references.length !== expectedReferences.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["review", "source_references"],
      message: "source references must cover every generated rule"
    });
  }
  for (const expected of expectedReferences) {
    const start = draft.source_text.indexOf(expected.quote);
    const reference = draft.review.source_references.find(
      (candidate) => candidate.rule_id === expected.rule_id && candidate.quote === expected.quote
    );
    const requiredReferenceMissing = draft.review.approvable && (start < 0 || !reference);
    const presentReferenceIsInvalid =
      reference !== undefined &&
      (start < 0 ||
        reference.start !== start ||
        reference.end !== start + expected.quote.length);
    if (requiredReferenceMissing || presentReferenceIsInvalid) {
      context.addIssue({
        code: "custom",
        path: ["review", "source_references"],
        message: `${expected.rule_id} source reference is missing or not deterministic`
      });
    }
  }
  if (draft.draft_hash !== computeDraftHash(draft)) {
    context.addIssue({
      code: "custom",
      path: ["draft_hash"],
      message: "draft_hash does not match draft content"
    });
  }
});

export type CompilerOutput = z.infer<typeof compilerOutputSchema>;
export type MandateDraft = z.infer<typeof mandateDraftSchema>;
export type CompilerReviewItem = z.infer<typeof compilerReviewItemSchema>;

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function draftHashContent(draft: Omit<MandateDraft, "draft_hash"> | MandateDraft): unknown {
  const {
    schema_version,
    kind,
    draft_id,
    created_at,
    compiler,
    mandate_id,
    proposed_version,
    source_text,
    rules,
    review
  } = draft;
  return {
    schema_version,
    kind,
    draft_id,
    created_at,
    compiler,
    mandate_id,
    proposed_version,
    source_text,
    rules,
    review
  };
}

export function computeDraftHash(
  draft: Omit<MandateDraft, "draft_hash"> | MandateDraft
): string {
  return sha256(draftHashContent(draft));
}

export function sourceReferences(sourceText: string, rules: MandateRules) {
  return [
    ...rules.constraints.map((constraint) => ({ rule_id: constraint.id, quote: constraint.quote })),
    ...rules.budgets.map((budget, index) => ({ rule_id: `budget:${index}`, quote: budget.quote }))
  ].map((entry) => ({ ...entry, ...deriveQuoteSpan(sourceText, entry.quote) }));
}

export function createMandateDraft(input: {
  sourceText: string;
  mandateId: string;
  proposedVersion: number;
  provider: string;
  model: string;
  createdAt: string;
  output: CompilerOutput;
  validationErrors?: readonly string[];
}): MandateDraft {
  const rules = {
    constraints: input.output.constraints,
    budgets: input.output.budgets
  };
  const validationErrors = [...(input.validationErrors ?? [])];
  const rulesResult = mandateRulesSchema.safeParse(rules);
  if (!rulesResult.success) {
    validationErrors.push(
      ...rulesResult.error.issues.map(
        (issue) => `${issue.path.join(".") || "rules"}: ${issue.message}`
      )
    );
  }
  const accountedSource = new Set([
    ...rules.constraints.map((constraint) => constraint.quote),
    ...rules.budgets.map((budget) => budget.quote),
    ...input.output.unsupported_instructions.map((item) => item.source_text),
    ...input.output.ambiguities.map((item) => item.source_text)
  ]);
  const sourceSentences = (input.sourceText.match(/[^.!?]+[.!?]?/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const item of [
    ...input.output.unsupported_instructions,
    ...input.output.ambiguities
  ]) {
    if (!input.sourceText.includes(item.source_text)) {
      validationErrors.push(`Review item is not an exact source substring: ${item.source_text}`);
    }
  }
  for (const sentence of sourceSentences) {
    if (!accountedSource.has(sentence)) {
      validationErrors.push(`Instruction was not represented or flagged: ${sentence}`);
    }
  }
  let references: ReturnType<typeof sourceReferences> = [];
  try {
    references = sourceReferences(input.sourceText, rules);
  } catch (error) {
    validationErrors.push(error instanceof Error ? error.message : String(error));
  }
  const draftId = `dft_${sha256({
    mandate_id: input.mandateId,
    proposed_version: input.proposedVersion,
    source_text: input.sourceText,
    rules
  }).slice("sha256:".length, "sha256:".length + 16)}`;
  const withoutHash = {
    schema_version: 1 as const,
    kind: "mandate_draft" as const,
    draft_id: draftId,
    created_at: input.createdAt,
    compiler: { provider: input.provider, model: input.model },
    mandate_id: input.mandateId,
    proposed_version: input.proposedVersion,
    source_text: input.sourceText,
    rules,
    review: {
      approvable:
        input.output.unsupported_instructions.length === 0 &&
        input.output.ambiguities.length === 0 &&
        validationErrors.length === 0,
      unsupported_instructions: input.output.unsupported_instructions,
      ambiguities: input.output.ambiguities,
      conservative_assumptions: input.output.conservative_assumptions,
      validation_errors: validationErrors,
      source_references: references
    }
  };
  return mandateDraftSchema.parse({
    ...withoutHash,
    draft_hash: computeDraftHash(withoutHash as Omit<MandateDraft, "draft_hash">)
  });
}

export function approveMandateDraft(input: {
  draft: MandateDraft;
  approvedBy: string;
  approvedAt: string;
  previous?: Mandate;
}): Mandate {
  const draft = mandateDraftSchema.parse(input.draft);
  if (!draft.review.approvable) {
    throw new Error("Draft cannot be approved until unsupported, ambiguous, and invalid items are resolved");
  }
  if (input.previous) {
    if (input.previous.mandate_id !== draft.mandate_id) {
      throw new Error("Previous mandate ID does not match the draft");
    }
    if (draft.proposed_version !== input.previous.version + 1) {
      throw new Error("Draft version must increment the previous approved version by one");
    }
  } else if (draft.proposed_version !== 1) {
    throw new Error("A first approved mandate must start at version 1");
  }
  const withoutHash = {
    status: "approved" as const,
    mandate_id: draft.mandate_id,
    version: draft.proposed_version,
    source_text: draft.source_text,
    approved_by: input.approvedBy,
    approved_at: input.approvedAt,
    approval: { draft_id: draft.draft_id, draft_hash: draft.draft_hash },
    revoked: false,
    constraints: draft.rules.constraints,
    budgets: draft.rules.budgets
  };
  return mandateSchema.parse({
    ...withoutHash,
    mandate_hash: computeMandateHash(withoutHash as Omit<Mandate, "mandate_hash">)
  });
}

export interface MandateDiffEntry {
  operation: "ADD" | "REMOVE" | "CHANGE" | "UNCHANGED";
  rule_id: string;
  before: unknown | null;
  after: unknown | null;
}

function indexedRules(mandate: Pick<Mandate, "constraints" | "budgets">): Map<string, unknown> {
  const rules = new Map<string, unknown>();
  for (const constraint of mandate.constraints) rules.set(constraint.id, constraint);
  for (const [index, budget] of mandate.budgets.entries()) rules.set(`budget:${index}`, budget);
  return rules;
}

export function diffMandates(
  before: Pick<Mandate, "constraints" | "budgets"> | null,
  after: Pick<Mandate, "constraints" | "budgets">
): MandateDiffEntry[] {
  const left = before ? indexedRules(before) : new Map<string, unknown>();
  const right = indexedRules(after);
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
  return ids.map((ruleId) => {
    const oldRule = left.get(ruleId);
    const newRule = right.get(ruleId);
    const operation =
      oldRule === undefined
        ? "ADD"
        : newRule === undefined
          ? "REMOVE"
          : canonicalJson(oldRule) === canonicalJson(newRule)
            ? "UNCHANGED"
            : "CHANGE";
    return {
      operation,
      rule_id: ruleId,
      before: oldRule ?? null,
      after: newRule ?? null
    };
  });
}

function saveJson(path: string, value: unknown, immutable: boolean): string {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  if (immutable) {
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } else {
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  }
  return target;
}

export function saveMandateDraft(path: string, draft: MandateDraft): string {
  return saveJson(path, mandateDraftSchema.parse(draft), false);
}

export function saveApprovedMandate(path: string, mandate: Mandate): string {
  return saveJson(path, mandateSchema.parse(mandate), true);
}

export function loadMandateDraft(path: string): MandateDraft {
  return mandateDraftSchema.parse(JSON.parse(readFileSync(resolve(path), "utf8")) as unknown);
}
