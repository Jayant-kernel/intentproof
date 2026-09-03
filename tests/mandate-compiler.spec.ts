import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { compilerOutputSchema } from "../src/mandate/artifacts.js";
import {
  compileMandate,
  MandateCompilerError,
  type CompilerPrompt
} from "../src/llm/compiler.js";
import {
  DeterministicFakeCompiler,
  StaticFakeCompiler
} from "../src/llm/fake-compiler.js";
import { GeminiMandateCompiler } from "../src/llm/gemini-compiler.js";

const validSource = readFileSync(resolve("examples/mandates/shop-owner.txt"), "utf8").trim();
const fixedClock = () => new Date("2026-09-01T03:30:00.000Z");

function validOutput(sourceText = "Create orders up to 3,000 rupees.") {
  return compilerOutputSchema.parse({
    constraints: [
      {
        id: "C1",
        rule: "tool_allowlist",
        tools: ["create_order"],
        quote: sourceText
      }
    ],
    budgets: [],
    unsupported_instructions: [],
    ambiguities: [],
    conservative_assumptions: []
  });
}

async function compileWith(provider: StaticFakeCompiler, sourceText = "Create orders up to 3,000 rupees.") {
  return compileMandate({
    sourceText,
    mandateId: "mnd_test",
    proposedVersion: 1,
    provider,
    clock: fixedClock
  });
}

describe("natural-language mandate compiler", () => {
  it("compiles the supported example into validated rules with exact source references", async () => {
    const draft = await compileMandate({
      sourceText: validSource,
      mandateId: "mnd_demo_001",
      proposedVersion: 1,
      provider: new DeterministicFakeCompiler(),
      clock: fixedClock
    });

    expect(draft.review.approvable).toBe(true);
    expect(draft.rules.constraints).toHaveLength(5);
    expect(draft.rules.budgets).toHaveLength(1);
    for (const reference of draft.review.source_references) {
      expect(draft.source_text.slice(reference.start, reference.end)).toBe(reference.quote);
    }
  });

  it("records unsupported instructions instead of inventing a rule", async () => {
    const source = "Create orders up to 3,000 rupees. Send refunds automatically.";
    const draft = await compileMandate({
      sourceText: source,
      mandateId: "mnd_unsupported",
      proposedVersion: 1,
      provider: new DeterministicFakeCompiler(),
      clock: fixedClock
    });

    expect(draft.review.approvable).toBe(false);
    expect(draft.review.unsupported_instructions).toEqual([
      {
        source_text: "Send refunds automatically.",
        reason: "No frozen IntentProof rule represents this instruction"
      }
    ]);
    expect(JSON.stringify(draft.rules)).not.toContain("create_refund");
  });

  it("preserves ambiguous language as a blocking review item", async () => {
    const draft = await compileMandate({
      sourceText: "Create orders up to 3,000 rupees. Keep purchases reasonably small.",
      mandateId: "mnd_ambiguous",
      proposedVersion: 1,
      provider: new DeterministicFakeCompiler(),
      clock: fixedClock
    });

    expect(draft.review.approvable).toBe(false);
    expect(draft.review.ambiguities[0]).toMatchObject({
      source_text: "Keep purchases reasonably small."
    });
  });

  it("detects a source instruction the provider silently omitted", async () => {
    const source = "Create orders up to 3,000 rupees. Send refunds automatically.";
    const draft = await compileWith(
      new StaticFakeCompiler(JSON.stringify(validOutput())),
      source
    );

    expect(draft.review.approvable).toBe(false);
    expect(draft.review.validation_errors).toContain(
      "Instruction was not represented or flagged: Send refunds automatically."
    );
  });

  it("fails closed on malformed provider JSON", async () => {
    await expect(compileWith(new StaticFakeCompiler("not-json"))).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE"
    });
  });

  it("fails closed when the provider times out", async () => {
    await expect(compileWith(new StaticFakeCompiler(new Error("provider timed out")))).rejects.toMatchObject({
      code: "PROVIDER_TIMEOUT"
    });
  });

  it("enforces the timeout even when a provider never settles", async () => {
    await expect(
      compileMandate({
        sourceText: "Create orders up to 3,000 rupees.",
        mandateId: "mnd_timeout",
        proposedVersion: 1,
        timeoutMs: 5,
        provider: {
          providerName: "hanging_fake",
          modelName: "test",
          generate: () => new Promise<string>(() => undefined)
        }
      })
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  it("rejects schema-invalid structured output", async () => {
    const response = JSON.stringify({ ...validOutput(), invented_policy: true });
    await expect(compileWith(new StaticFakeCompiler(response))).rejects.toMatchObject({
      code: "SCHEMA_INVALID"
    });
  });

  it("returns deterministic validation errors for a rule with an invented quote", async () => {
    const output = validOutput("The merchant never wrote this sentence.");
    const draft = await compileWith(new StaticFakeCompiler(JSON.stringify(output)));

    expect(draft.review.approvable).toBe(false);
    expect(draft.review.validation_errors).toContain(
      "Rule quote is not an exact substring of source_text"
    );
    expect(draft.review.source_references).toEqual([]);
  });

  it("redacts credentials before prompting or writing a draft artifact", async () => {
    const marker = "unit-redaction-marker";
    let capturedPrompt: CompilerPrompt | undefined;
    const response = JSON.stringify(validOutput());
    const draft = await compileWith(
      new StaticFakeCompiler(response, (prompt) => {
        capturedPrompt = prompt;
      }),
      `Create orders up to 3,000 rupees. API_KEY=${marker}`
    );

    expect(JSON.stringify(capturedPrompt)).not.toContain(marker);
    expect(JSON.stringify(draft)).not.toContain(marker);
    expect(draft.source_text).toContain("[REDACTED_");
    expect(draft.review.approvable).toBe(false);
  });

  it("does not send a financial event payload to the compiler", async () => {
    const payload = '{"payment":{"id":"pay_synthetic123","email":"buyer@example.test"}}';
    const safeSource = "[REDACTED_FINANCIAL_EVENT]";
    let promptText = "";
    const draft = await compileWith(
      new StaticFakeCompiler(JSON.stringify(validOutput(safeSource)), (prompt) => {
        promptText = prompt.user;
      }),
      payload
    );

    expect(promptText).not.toContain("pay_synthetic123");
    expect(promptText).not.toContain("buyer@example.test");
    expect(JSON.stringify(draft)).not.toContain("pay_synthetic123");
    expect(draft.review.approvable).toBe(false);
  });

  it("does not copy provider response text into operational errors", async () => {
    const hidden = "hidden-provider-value";
    try {
      await compileWith(new StaticFakeCompiler(`{${hidden}`));
      throw new Error("expected compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MandateCompilerError);
      expect((error as Error).message).not.toContain(hidden);
    }
  });

  it("uses Gemini structured JSON mode without placing its key in the prompt body", async () => {
    const marker = "unit-gemini-marker";
    let requestBody = "";
    const compiler = new GeminiMandateCompiler({
      apiKey: marker,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify(validOutput()) }] } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch
    });

    const draft = await compileMandate({
      sourceText: "Create orders up to 3,000 rupees.",
      mandateId: "mnd_gemini_test",
      proposedVersion: 1,
      provider: compiler,
      clock: fixedClock
    });

    expect(draft.review.approvable).toBe(true);
    expect(requestBody).toContain('"responseMimeType":"application/json"');
    expect(requestBody).not.toContain(marker);
  });
});
