import express, { type Express } from "express";

import { eventIdentity, WebhookEventError } from "./intake/event.js";
import { hashWebhookIdentifier } from "./intake/privacy.js";
import { verifyWebhookSignature } from "./intake/signature.js";
import type { AuditStore } from "./ledger/audit-store.js";
import { createControlRoomRouter } from "./control-room/routes.js";
import type { ControlRoomService } from "./control-room/service.js";

export interface AppOptions {
  auditStore: AuditStore;
  webhookSecrets: readonly string[];
  controlRoom?: ControlRoomService;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createApp(options: AppOptions): Express {
  const app = express();

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  if (options.controlRoom) {
    app.use("/api/control-room", createControlRoomRouter(options.controlRoom));
  }

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
          event_id_hash: hashWebhookIdentifier(eventId),
          event_category: "unverified",
          signature_valid: false,
          http_status: 401,
          reason: "hmac_mismatch",
          no_payment_mutation: true
        });
        response.status(401).json({ error: "invalid_signature" });
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString("utf8")) as unknown;
      } catch {
        options.auditStore.append("WEBHOOK_REJECTED", {
          event_id_hash: hashWebhookIdentifier(eventId),
          event_category: "unparseable",
          signature_valid: true,
          http_status: 400,
          reason: "invalid_json",
          no_payment_mutation: true
        });
        response.status(400).json({ error: "invalid_json" });
        return;
      }

      if (!eventId) {
        options.auditStore.append("WEBHOOK_REJECTED", {
          event_id_hash: null,
          event_category: "unvalidated",
          signature_valid: true,
          http_status: 400,
          reason: "event_id_missing",
          no_payment_mutation: true
        });
        response.status(400).json({ error: "event_id_required" });
        return;
      }

      let identity;
      try {
        identity = eventIdentity(body);
      } catch (error) {
        if (!(error instanceof WebhookEventError)) throw error;
        options.auditStore.append("WEBHOOK_REJECTED", {
          event_id_hash: hashWebhookIdentifier(eventId),
          event_category: error.code === "unsupported_event" ? "unsupported" : "invalid",
          signature_valid: true,
          http_status: 422,
          reason: error.code,
          no_payment_mutation: true
        });
        response.status(422).json({ error: error.code });
        return;
      }
      const result = options.auditStore.recordWebhook({
        eventId,
        eventType: identity.eventType,
        paymentId: identity.paymentId,
        operation: identity.operation,
        stateRank: identity.stateRank
      });

      response.status(200).json({
        received: true,
        status: result.status
      });
    }
  );

  return app;
}
