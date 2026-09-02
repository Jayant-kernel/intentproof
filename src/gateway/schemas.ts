import { z } from "zod";

const paise = z.number().int().safe().min(100);
const currency = z.literal("INR");
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u).optional();
const notes = z
  .record(z.string().min(1).max(256), z.union([z.string().max(256), z.number(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 15, "notes may contain at most 15 entries");

export const createOrderSchema = z
  .object({
    amount: paise.describe("Order amount in integer paise"),
    currency,
    receipt: z.string().min(1).max(40).optional(),
    notes: notes.optional(),
    partial_payment: z.boolean().optional(),
    first_payment_min_amount: paise.optional(),
    idempotency_key: idempotencyKey
  })
  .strict()
  .superRefine((value, context) => {
    if (value.first_payment_min_amount !== undefined) {
      if (value.partial_payment !== true) {
        context.addIssue({
          code: "custom",
          path: ["first_payment_min_amount"],
          message: "first_payment_min_amount requires partial_payment=true"
        });
      }
      if (value.first_payment_min_amount > value.amount) {
        context.addIssue({
          code: "custom",
          path: ["first_payment_min_amount"],
          message: "first_payment_min_amount cannot exceed amount"
        });
      }
    }
  });

export const createPaymentLinkSchema = z
  .object({
    amount: paise.describe("Payment Link amount in integer paise"),
    currency,
    description: z.string().max(2_048).optional(),
    accept_partial: z.boolean().optional(),
    first_min_partial_amount: paise.optional(),
    expire_by: z.number().int().safe().positive().optional(),
    reference_id: z.string().min(1).max(40).optional(),
    customer_name: z.string().max(256).optional(),
    customer_email: z.string().email().max(256).optional(),
    customer_contact: z.string().min(8).max(20).optional(),
    notify_sms: z.boolean().optional(),
    notify_email: z.boolean().optional(),
    reminder_enable: z.boolean().optional(),
    notes: notes.optional(),
    callback_url: z.string().url().max(2_048).optional(),
    callback_method: z.literal("get").optional(),
    idempotency_key: idempotencyKey
  })
  .strict()
  .superRefine((value, context) => {
    if (value.first_min_partial_amount !== undefined) {
      if (value.accept_partial !== true) {
        context.addIssue({
          code: "custom",
          path: ["first_min_partial_amount"],
          message: "first_min_partial_amount requires accept_partial=true"
        });
      }
      if (value.first_min_partial_amount > value.amount) {
        context.addIssue({
          code: "custom",
          path: ["first_min_partial_amount"],
          message: "first_min_partial_amount cannot exceed amount"
        });
      }
    }
    if (value.callback_method !== undefined && value.callback_url === undefined) {
      context.addIssue({
        code: "custom",
        path: ["callback_method"],
        message: "callback_method requires callback_url"
      });
    }
  });

export const capturePaymentSchema = z
  .object({
    payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/u),
    amount: paise.describe("Full authorized amount in integer paise"),
    currency,
    idempotency_key: idempotencyKey
  })
  .strict();

export const gatewayToolSchemas = {
  create_order: createOrderSchema,
  create_payment_link: createPaymentLinkSchema,
  capture_payment: capturePaymentSchema
} as const;

export type GatewayToolName = keyof typeof gatewayToolSchemas;
export type GatewayToolArguments = z.infer<(typeof gatewayToolSchemas)[GatewayToolName]>;

export function isGatewayToolName(value: string): value is GatewayToolName {
  return Object.hasOwn(gatewayToolSchemas, value);
}

export function parseGatewayArguments(
  tool: GatewayToolName,
  arguments_: unknown
): Record<string, unknown> {
  return gatewayToolSchemas[tool].parse(arguments_) as Record<string, unknown>;
}
