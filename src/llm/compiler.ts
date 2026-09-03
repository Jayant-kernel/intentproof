import { ZodError } from "zod";

import {
  compilerOutputSchema,
  createMandateDraft,
  type CompilerOutput,
  type MandateDraft
} from "../mandate/artifacts.js";
import { redactCompilerInput } from "./redaction.js";

export interface CompilerPrompt {
  system: string;
  user: string;
}

export interface MandateCompilerProvider {
  readonly providerName: string;
  readonly modelName: string;
  generate(prompt: CompilerPrompt, timeoutMs: number): Promise<string>;
}

export type CompilerFailureCode =
  | "MALFORMED_RESPONSE"
  | "SCHEMA_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR";

export class MandateCompilerError extends Error {
  constructor(
    readonly code: CompilerFailureCode,
    message: string
  ) {
    super(message);
    this.name = "MandateCompilerError";
  }
}

export interface CompileMandateInput {
  sourceText: string;
  mandateId: string;
  proposedVersion: number;
  provider: MandateCompilerProvider;
  timeoutMs?: number;
  clock?: () => Date;
}

const SYSTEM_PROMPT = `You draft IntentProof mandate configuration. Return one JSON object only.
Allowed constraint rules: tool_allowlist, amount_ceiling, precondition, approval_gate, time_window.
Allowed tools: create_order, create_payment_link, capture_payment, fetch_order, fetch_payment.
Allowed budget shape: window=24h, tool=*, max_total_paise, max_calls, quote.
Every quote must be an exact substring of SOURCE_TEXT. Amounts are integer paise.
Do not invent a rule for an unsupported or ambiguous instruction. Put it in unsupported_instructions
or ambiguities with its exact source text and a reason. State conservative assumptions explicitly.
The output keys are constraints, budgets, unsupported_instructions, ambiguities, and
conservative_assumptions. Do not return approval, activation, verdict, credentials, or event data.`;

export function buildCompilerPrompt(sourceText: string): CompilerPrompt {
  return {
    system: SYSTEM_PROMPT,
    user: `SOURCE_TEXT_BEGIN\n${sourceText}\nSOURCE_TEXT_END`
  };
}

function parseProviderOutput(raw: string): CompilerOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MandateCompilerError(
      "MALFORMED_RESPONSE",
      "Compiler provider returned malformed JSON"
    );
  }
  try {
    return compilerOutputSchema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new MandateCompilerError(
        "SCHEMA_INVALID",
        `Compiler response failed the frozen schema: ${error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; ")}`
      );
    }
    throw error;
  }
}

export async function compileMandate(input: CompileMandateInput): Promise<MandateDraft> {
  if (!input.sourceText.trim() || input.sourceText.length > 20_000) {
    throw new Error("Mandate source text must contain between 1 and 20,000 characters");
  }
  const timeoutMs = input.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Compiler timeout must be a positive integer");
  }
  const redacted = redactCompilerInput(input.sourceText);
  const prompt = buildCompilerPrompt(redacted.text);
  let raw: string;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race([
      input.provider.generate(prompt, timeoutMs),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new MandateCompilerError("PROVIDER_TIMEOUT", "Compiler provider timed out")),
          timeoutMs
        );
      })
    ]);
  } catch (error) {
    if (error instanceof MandateCompilerError) throw error;
    const isTimeout =
      error instanceof Error &&
      (error.name === "AbortError" || /timeout|timed out/iu.test(error.message));
    throw new MandateCompilerError(
      isTimeout ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR",
      isTimeout ? "Compiler provider timed out" : "Compiler provider failed"
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const output = parseProviderOutput(raw);
  const validationErrors = redacted.findings.map(
    (finding) => `Sensitive ${finding} was redacted; the instruction must be reviewed before approval`
  );
  return createMandateDraft({
    sourceText: redacted.text,
    mandateId: input.mandateId,
    proposedVersion: input.proposedVersion,
    provider: input.provider.providerName,
    model: input.provider.modelName,
    createdAt: (input.clock ?? (() => new Date()))().toISOString(),
    output,
    validationErrors
  });
}
