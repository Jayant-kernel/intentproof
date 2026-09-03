import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { DispatchRecord } from "../budget/types.js";
import type { AuditStore } from "../ledger/audit-store.js";
import { parseMcpJson } from "../upstream/mcp-json.js";
import type {
  ReconciliationCapabilities,
  ReconciliationReadClient,
  ReconcileResult
} from "./types.js";

const orderEntitySchema = z
  .object({
    id: z.string().regex(/^order_[A-Za-z0-9]+$/u),
    receipt: z.string(),
    amount: z.number().int().safe().nonnegative(),
    currency: z.string()
  })
  .passthrough();
const orderCollectionSchema = z
  .object({
    count: z.number().int().safe().nonnegative(),
    items: z.array(orderEntitySchema)
  })
  .passthrough();
const paymentLinkEntitySchema = z
  .object({
    id: z.string().regex(/^plink_[A-Za-z0-9]+$/u),
    reference_id: z.string(),
    amount: z.number().int().safe().nonnegative(),
    currency: z.string()
  })
  .passthrough();
const paymentLinkItemsSchema = z
  .object({
    items: z.array(paymentLinkEntitySchema),
    count: z.number().int().safe().nonnegative().optional()
  })
  .passthrough();
const paymentLinksSchema = z
  .object({
    payment_links: z.array(paymentLinkEntitySchema),
    count: z.number().int().safe().nonnegative().optional()
  })
  .passthrough();
const paymentSchema = z
  .object({
    id: z.string().regex(/^pay_[A-Za-z0-9]+$/u),
    status: z.enum(["created", "authorized", "captured", "refunded", "failed"])
  })
  .passthrough();

type ReadDecision =
  | { kind: "COMMITTED"; reason: string; upstreamEntityId: string }
  | { kind: "RELEASED"; reason: string; upstreamEntityId: string }
  | { kind: "IN_DOUBT"; reason: string };

export interface DispatchReconcilerOptions {
  store: AuditStore;
  readClient: ReconciliationReadClient;
  capabilities: ReconciliationCapabilities;
  clock?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  owner?: string;
  immediateReadDelaysMs?: readonly number[];
  leaseMs?: number;
  retryDelayMs?: number;
}

function paymentLinks(
  value: unknown
): { items: Array<z.infer<typeof paymentLinkEntitySchema>>; count?: number } | undefined {
  const items = paymentLinkItemsSchema.safeParse(value);
  if (items.success) {
    return {
      items: items.data.items,
      ...(items.data.count === undefined ? {} : { count: items.data.count })
    };
  }
  const links = paymentLinksSchema.safeParse(value);
  return links.success
    ? {
        items: links.data.payment_links,
        ...(links.data.count === undefined ? {} : { count: links.data.count })
      }
    : undefined;
}

export class DispatchReconciler {
  private readonly clock: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly owner: string;
  private readonly immediateReadDelaysMs: readonly number[];
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: DispatchReconcilerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.owner = options.owner ?? `reconciler_${randomUUID()}`;
    this.immediateReadDelaysMs = options.immediateReadDelaysMs ?? [250, 500, 1_000];
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 5 * 60 * 1_000;
  }

  async reconcile(idempotencyKey: string): Promise<ReconcileResult> {
    const started = this.clock();
    const lease = this.options.store.acquireReconcileLease({
      idempotencyKey,
      owner: this.owner,
      now: started.toISOString(),
      leaseUntil: new Date(started.getTime() + this.leaseMs).toISOString()
    });
    if (lease.status !== "acquired") {
      return {
        status: lease.status === "not_found" ? "IN_DOUBT" : lease.dispatch.state,
        disposition: lease.status,
        reads: 0
      };
    }

    const unsupportedReason = this.unsupportedReason(lease.dispatch);
    if (unsupportedReason) {
      return this.defer(lease.dispatch, unsupportedReason, 0);
    }

    let reads = 0;
    let lastReason = "read_result_ambiguous";
    for (const delay of this.immediateReadDelaysMs) {
      await this.sleep(delay);
      const decision = await this.readOnce(lease.dispatch);
      reads += 1;
      if (decision.kind !== "IN_DOUBT") {
        const settled = this.options.store.settleReconciledDispatch({
          idempotencyKey,
          owner: this.owner,
          state: decision.kind,
          upstreamStatus: decision.reason,
          now: this.clock().toISOString(),
          upstreamEntityId: decision.upstreamEntityId
        });
        return { status: settled.state, disposition: "settled", reads };
      }
      lastReason = decision.reason;
    }
    return this.defer(lease.dispatch, lastReason, reads);
  }

  async reconcileDue(limit = 25): Promise<ReconcileResult[]> {
    const keys = this.options.store.listDueReconciliationKeys(this.clock().toISOString(), limit);
    const results: ReconcileResult[] = [];
    for (const key of keys) results.push(await this.reconcile(key));
    return results;
  }

  private unsupportedReason(dispatch: DispatchRecord): string | undefined {
    if (dispatch.correlationType === null || dispatch.correlationValue === null) {
      return "missing_durable_correlation";
    }
    if (dispatch.tool === "create_order" && !this.options.capabilities.orderReceiptFilter) {
      return "order_receipt_filter_unavailable";
    }
    if (
      dispatch.tool === "create_payment_link" &&
      !this.options.capabilities.paymentLinkReferenceFilter
    ) {
      return "payment_link_reference_filter_unavailable";
    }
    if (dispatch.tool === "capture_payment" && !this.options.capabilities.fetchPayment) {
      return "fetch_payment_unavailable";
    }
    if (!new Set(["create_order", "create_payment_link", "capture_payment"]).has(dispatch.tool)) {
      return "unsupported_mutation_tool";
    }
    return undefined;
  }

  private defer(dispatch: DispatchRecord, reason: string, reads: number): ReconcileResult {
    const now = this.clock();
    const deferred = this.options.store.deferReconciliation({
      idempotencyKey: dispatch.idempotencyKey,
      owner: this.owner,
      reason,
      now: now.toISOString(),
      nextReconcileAt: new Date(now.getTime() + this.retryDelayMs).toISOString(),
      escalate: true
    });
    return { status: deferred.state, disposition: "deferred", reads };
  }

  private async readOnce(dispatch: DispatchRecord): Promise<ReadDecision> {
    try {
      switch (dispatch.tool) {
        case "create_order":
          return await this.readOrder(dispatch);
        case "create_payment_link":
          return await this.readPaymentLink(dispatch);
        case "capture_payment":
          return await this.readPayment(dispatch);
        default:
          return { kind: "IN_DOUBT", reason: "unsupported_mutation_tool" };
      }
    } catch {
      return { kind: "IN_DOUBT", reason: "read_error" };
    }
  }

  private async readOrder(dispatch: DispatchRecord): Promise<ReadDecision> {
    const result = await this.options.readClient.callReadTool("fetch_all_orders", {
      receipt: dispatch.correlationValue,
      count: 100
    });
    const parsed = orderCollectionSchema.safeParse(parseMcpJson(result));
    if (!parsed.success) return { kind: "IN_DOUBT", reason: "order_read_malformed" };
    if (parsed.data.count !== parsed.data.items.length || parsed.data.items.length >= 100) {
      return { kind: "IN_DOUBT", reason: "order_pagination_ambiguous" };
    }
    if (parsed.data.items.length !== 1) {
      return { kind: "IN_DOUBT", reason: "order_match_ambiguous" };
    }
    const entity = parsed.data.items[0]!;
    if (
      entity.receipt !== dispatch.correlationValue ||
      entity.amount !== dispatch.amountPaise ||
      entity.currency !== "INR"
    ) {
      return { kind: "IN_DOUBT", reason: "order_fields_mismatch" };
    }
    return { kind: "COMMITTED", reason: "order_match_confirmed", upstreamEntityId: entity.id };
  }

  private async readPaymentLink(dispatch: DispatchRecord): Promise<ReadDecision> {
    const result = await this.options.readClient.callReadTool("fetch_all_payment_links", {
      reference_id: dispatch.correlationValue
    });
    const collection = paymentLinks(parseMcpJson(result));
    if (!collection) return { kind: "IN_DOUBT", reason: "payment_link_read_malformed" };
    if (collection.count !== undefined && collection.count !== collection.items.length) {
      return { kind: "IN_DOUBT", reason: "payment_link_pagination_ambiguous" };
    }
    if (collection.items.length !== 1) {
      return { kind: "IN_DOUBT", reason: "payment_link_match_ambiguous" };
    }
    const entity = collection.items[0]!;
    if (
      entity.reference_id !== dispatch.correlationValue ||
      entity.amount !== dispatch.amountPaise ||
      entity.currency !== "INR"
    ) {
      return { kind: "IN_DOUBT", reason: "payment_link_fields_mismatch" };
    }
    return {
      kind: "COMMITTED",
      reason: "payment_link_match_confirmed",
      upstreamEntityId: entity.id
    };
  }

  private async readPayment(dispatch: DispatchRecord): Promise<ReadDecision> {
    const result = await this.options.readClient.callReadTool("fetch_payment", {
      payment_id: dispatch.correlationValue
    });
    const parsed = paymentSchema.safeParse(parseMcpJson(result));
    if (!parsed.success || parsed.data.id !== dispatch.correlationValue) {
      return { kind: "IN_DOUBT", reason: "payment_read_unverified" };
    }
    if (parsed.data.status === "captured" || parsed.data.status === "refunded") {
      return {
        kind: "COMMITTED",
        reason: `capture_${parsed.data.status}_confirmed`,
        upstreamEntityId: parsed.data.id
      };
    }
    if (parsed.data.status === "failed") {
      return {
        kind: "RELEASED",
        reason: "capture_failed_confirmed",
        upstreamEntityId: parsed.data.id
      };
    }
    return { kind: "IN_DOUBT", reason: `capture_${parsed.data.status}_not_terminal` };
  }
}
