import { z } from "zod";

const amountPaise = z.number().int().safe().min(100);
const currency = z.literal("INR");
const intentId = z.string().min(8).max(120).regex(/^int_[A-Za-z0-9._-]+$/u);
const explanation = z.string().trim().min(1).max(500);

const createOrderProposal = z.object({
  tool: z.literal("create_order"),
  arguments: z.object({ amount: amountPaise, currency }).strict(),
  intent_id: intentId,
  explanation
}).strict();

const createPaymentLinkProposal = z.object({
  tool: z.literal("create_payment_link"),
  arguments: z.object({
    amount: amountPaise,
    currency,
    description: z.string().trim().min(1).max(500).optional()
  }).strict(),
  intent_id: intentId,
  explanation
}).strict();

const capturePaymentProposal = z.object({
  tool: z.literal("capture_payment"),
  arguments: z.object({
    payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/u),
    amount: amountPaise,
    currency
  }).strict(),
  intent_id: intentId,
  explanation
}).strict();

const noActionProposal = z.object({
  tool: z.literal("no_action"),
  arguments: z.object({}).strict(),
  intent_id: intentId,
  explanation
}).strict();

export const plannerProposalSchema = z.discriminatedUnion("tool", [
  createOrderProposal,
  createPaymentLinkProposal,
  capturePaymentProposal,
  noActionProposal
]);

export type PlannerProposal = z.infer<typeof plannerProposalSchema>;
export type ActionProposal = Exclude<PlannerProposal, { tool: "no_action" }>;
