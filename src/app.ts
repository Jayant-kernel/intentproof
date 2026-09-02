import express, { type Express } from "express";

import { eventIdentity } from "./intake/event.js";
import { verifyWebhookSignature } from "./intake/signature.js";
import type { AuditStore } from "./ledger/audit-store.js";

export interface AppOptions {
  auditStore: AuditStore;
  webhookSecrets: readonly string[];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createApp(options: AppOptions): Express {
  const app = express();

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post(
    "/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    (request, response) => {
      if (!Buffer.isBuffer(request.body)) {
        options.auditStore.append("SIGNATURE_REJECTED", { reason: "raw_body_missing" });
        response.status(400).json({ error: "raw_body_required" });
        return;
      }

      const rawBody = request.body;
      const signature = headerValue(request.headers["x-razorpay-signature"]);
      const eventId = headerValue(request.headers["x-razorpay-event-id"]);

      if (!verifyWebhookSignature(rawBody, signature, options.webhookSecrets)) {
        options.auditStore.append("SIGNATURE_REJECTED", {
          event_id: eventId ?? null,
          reason: "hmac_mismatch"
        });
        response.status(401).json({ error: "invalid_signature" });
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8")) as unknown;
      } catch {
        options.auditStore.append("WEBHOOK_REJECTED", {
          event_id: eventId ?? null,
          reason: "invalid_json"
        });
        response.status(400).json({ error: "invalid_json" });
        return;
      }

      if (!eventId) {
        options.auditStore.append("WEBHOOK_REJECTED", { reason: "event_id_missing" });
        response.status(400).json({ error: "event_id_required" });
        return;
      }

      const identity = eventIdentity(body);
      const result = options.auditStore.recordWebhook({
        eventId,
        eventType: identity.eventType,
        ...(identity.paymentId ? { paymentId: identity.paymentId } : {}),
        ...(identity.operation ? { operation: identity.operation } : {}),
        ...(identity.stateRank !== undefined ? { stateRank: identity.stateRank } : {})
      });

      response.status(200).json({
        received: true,
        status: result.status
      });
    }
  );

  return app;
}
