import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadMandate } from "../src/mandate/load.js";
import { deriveQuoteSpan, mandateSchema } from "../src/mandate/schema.js";

describe("mandate approval boundary", () => {
  it("loads the frozen demo mandate and derives every quote span in code", () => {
    const mandate = loadMandate(resolve("mandates/default.yaml"));
    const quotes = [
      ...mandate.constraints.map((constraint) => constraint.quote),
      ...mandate.budgets.map((budget) => budget.quote)
    ];

    for (const quote of quotes) {
      const span = deriveQuoteSpan(mandate.source_text, quote);
      expect(mandate.source_text.slice(span.start, span.end)).toBe(quote);
    }
  });

  it("rejects a model-supplied quote that is absent from the merchant text", () => {
    const mandate = loadMandate(resolve("mandates/default.yaml"));
    const modified = structuredClone(mandate);
    modified.constraints[0]!.quote = "The model invented this sentence.";
    expect(mandateSchema.safeParse(modified).success).toBe(false);
  });
});
