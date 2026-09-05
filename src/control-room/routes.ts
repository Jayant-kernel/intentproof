import express, { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";

import type { ControlRoomService } from "./service.js";
import {
  agentRunRequestSchema,
  approvalRequestSchema,
  draftRequestSchema,
  killSwitchRequestSchema,
  labReplayRequestSchema,
  ledgerVerifyRequestSchema
} from "./schemas.js";

export function createControlRoomRouter(service: ControlRoomService): Router {
  const router = Router();
  router.use(Router().use((request, response, next) => {
    if (request.is("application/json") || request.method === "GET") return next();
    response.status(415).json({ error: "unsupported_media_type" });
  }));
  router.use(express.json({ limit: "32kb", strict: true }));

  router.get("/overview", (_request, response) => response.json(service.overview()));
  router.get("/mandate", (_request, response) => response.json(service.mandateState()));
  router.post("/mandate/draft", async (request, response, next) => {
    try {
      const body = draftRequestSchema.parse(request.body);
      response.json(await service.createDraft(body.sourceText));
    } catch (error) {
      next(error);
    }
  });
  router.post("/mandate/approve", (request, response, next) => {
    try {
      const body = approvalRequestSchema.parse(request.body);
      response.json(service.approveDraft(body.draftId, body.approvedBy));
    } catch (error) {
      next(error);
    }
  });
  router.post("/kill-switch", (request, response, next) => {
    try {
      const body = killSwitchRequestSchema.parse(request.body);
      response.json(service.setKillSwitch(body.engaged));
    } catch (error) {
      next(error);
    }
  });
  router.post("/agent/run", async (request, response, next) => {
    try {
      const body = agentRunRequestSchema.parse(request.body);
      response.json(await service.runAgent(body.objective, body.example));
    } catch (error) {
      next(error);
    }
  });
  router.get("/audit", (_request, response) => response.json({ records: service.audit() }));
  router.post("/audit/verify", (request, response, next) => {
    try {
      const body = ledgerVerifyRequestSchema.parse(request.body);
      response.json(service.verifyLedger(body.simulateTamper));
    } catch (error) {
      next(error);
    }
  });
  router.get("/lab/scenarios", (_request, response) => response.json({ scenarios: service.scenarios() }));
  router.post("/lab/replay", (request, response, next) => {
    try {
      const body = labReplayRequestSchema.parse(request.body);
      response.json(service.replayScenario(body.scenarioId));
    } catch (error) {
      next(error);
    }
  });
  router.get("/evidence", (_request, response) => response.json(service.evidence()));

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const known = error instanceof Error && ["draft_not_found", "scenario_not_found"].includes(error.message);
    response.status(known ? 404 : 500).json({ error: known ? "not_found" : "request_failed" });
  });
  return router;
}
