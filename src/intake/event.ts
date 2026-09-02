interface RazorpayWebhook {
  event?: unknown;
  payload?: {
    payment?: {
      entity?: {
        id?: unknown;
      };
    };
  };
}

export interface ParsedEventIdentity {
  eventType: string;
  paymentId?: string;
  operation?: string;
  stateRank?: number;
}

export function eventIdentity(body: unknown): ParsedEventIdentity {
  const webhook = body as RazorpayWebhook;
  const eventType = typeof webhook.event === "string" ? webhook.event : "unknown";
  const rawPaymentId = webhook.payload?.payment?.entity?.id;
  const paymentId = typeof rawPaymentId === "string" ? rawPaymentId : undefined;

  switch (eventType) {
    case "payment.authorized":
      return { eventType, paymentId, operation: "authorize", stateRank: 2 };
    case "payment.captured":
    case "order.paid":
      return { eventType, paymentId, operation: "capture", stateRank: 3 };
    default:
      return { eventType, paymentId };
  }
}
