import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("sanitized reconciliation evidence", () => {
  it("contains aggregate outcomes without credentials, response bodies, or external identifiers", () => {
    const text = readFileSync(resolve("evidence/reconciliation.json"), "utf8");
    const evidence = JSON.parse(text) as {
      real_test_mode_mutation_made: boolean;
      saved_data: Record<string, boolean>;
    };

    expect(evidence.real_test_mode_mutation_made).toBe(false);
    expect(Object.values(evidence.saved_data).every((saved) => saved === false)).toBe(true);
    expect(text).not.toMatch(/rzp_(?:test|live)_/iu);
    expect(text).not.toMatch(/\b(?:pay|order|plink)_[A-Za-z0-9]+\b/u);
    expect(text).not.toMatch(/authorization\s*[:=]/iu);
  });
});
