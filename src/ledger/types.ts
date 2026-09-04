export type AuditPayload = Record<string, unknown>;

export interface AuditRow {
  seq: number;
  ts: string;
  type: string;
  payload: AuditPayload;
}

export interface ExportedAuditRecord extends AuditRow {
  prev_hash: string;
  hash: string;
}

export type WebhookRecordStatus =
  | "applied"
  | "duplicate_delivery"
  | "duplicate_effect"
  | "out_of_order";

export interface WebhookRecordInput {
  eventId: string;
  eventType: "payment.authorized" | "payment.captured" | "order.paid";
  paymentId: string;
  operation: "authorize" | "capture";
  stateRank: 2 | 3;
}

export interface WebhookRecordResult {
  status: WebhookRecordStatus;
  auditType:
    | "WEBHOOK_APPLIED"
    | "DUPLICATE_DROPPED"
    | "EFFECT_DEDUPED"
    | "OUT_OF_ORDER_IGNORED";
}
