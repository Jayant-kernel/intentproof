import { z } from "zod";

export const draftRequestSchema = z
  .object({ sourceText: z.string().trim().min(1).max(20_000) })
  .strict();

export const approvalRequestSchema = z
  .object({
    draftId: z.string().min(1).max(128),
    approvedBy: z.string().trim().min(2).max(80)
  })
  .strict();

export const killSwitchRequestSchema = z
  .object({ engaged: z.boolean() })
  .strict();

export const agentRunRequestSchema = z
  .object({
    objective: z.string().trim().min(1).max(4_000),
    example: z
      .enum([
        "allowed_order",
        "over_limit",
        "capture_before_delivery",
        "approval_required",
        "prompt_injection",
        "kill_switch",
        "stale_mandate"
      ])
      .optional()
  })
  .strict();

export const labReplayRequestSchema = z
  .object({ scenarioId: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/u) })
  .strict();

export const ledgerVerifyRequestSchema = z
  .object({ simulateTamper: z.boolean().optional() })
  .strict();
