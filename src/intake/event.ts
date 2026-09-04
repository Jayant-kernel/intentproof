import { z } from "zod";

const supportedEventTypeSchema = z.enum([
  "payment.authorized",
  "payment.captured",
  "order.paid"
]);

const supportedWebhookSchema = z.object({
  event: supportedEventTypeSchema,
  payload: z.object({
    payment: z.object({
      entity: z.object({
        id: z.string().regex(/^pay_[A-Za-z0-9]+$/u)
      }).passthrough()
    }).passthrough()
  }).passthrough()
}).passthrough();

export class WebhookEventError extends Error {
  constructor(readonly code: "unsupported_event" | "invalid_event_shape") {
    super(code === "unsupported_event" ? "Unsupported webhook event" : "Invalid webhook event shape");
    this.name = "WebhookEventError";
  }
}

export interface ParsedEventIdentity {
  eventType: z.infer<typeof supportedEventTypeSchema>;
  paymentId: string;
  operation: "authorize" | "capture";
  stateRank: 2 | 3;
}

export function eventIdentity(body: unknown): ParsedEventIdentity {
  if (
    typeof body === "object" &&
    body !== null &&
    "event" in body &&
    typeof body.event === "string" &&
    !supportedEventTypeSchema.safeParse(body.event).success
  ) {
    throw new WebhookEventError("unsupported_event");
  }
  const parsed = supportedWebhookSchema.safeParse(body);
  if (!parsed.success) throw new WebhookEventError("invalid_event_shape");
  const eventType = parsed.data.event;
  const paymentId = parsed.data.payload.payment.entity.id;

  switch (eventType) {
    case "payment.authorized":
      return { eventType, paymentId, operation: "authorize", stateRank: 2 };
    case "payment.captured":
    case "order.paid":
      return { eventType, paymentId, operation: "capture", stateRank: 3 };
  }
}
