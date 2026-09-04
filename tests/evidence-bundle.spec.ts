import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSanitizedArtifact,
  buildProofBundle,
  loadVerifiedScoreboard,
  verifyProofBundle,
  type LocalVerificationSummary
} from "../src/evidence/proof-bundle.js";
import { parseProofManifest } from "../src/evidence/proof-schema.js";

const temporaryDirectories: string[] = [];
const fixedVerification: LocalVerificationSummary = {
  tests_passed: 999,
  test_files_passed: 99,
  build_passed: true,
  audit_vulnerabilities: 0,
  diff_check_passed: true
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "intentproof-proof-"));
  temporaryDirectories.push(directory);
  return directory;
}

function build(output: string): string {
  return buildProofBundle({
    rootDirectory: resolve("."),
    outputDirectory: output,
    createdAt: "2026-09-04T15:00:00.000Z",
    verification: fixedVerification,
    realWebhookEvidence: null
  });
}

function files(root: string): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else result.set(relative(root, path).replaceAll("\\", "/"), readFileSync(path));
    }
  };
  visit(root);
  return result;
}

describe("versioned evidence proof bundle", () => {
  it("builds byte-identical canonical bundles for identical inputs and supplied time", () => {
    const root = temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    build(first);
    build(second);

    const firstFiles = files(first);
    const secondFiles = files(second);
    expect([...firstFiles.keys()]).toEqual([...secondFiles.keys()]);
    for (const [path, bytes] of firstFiles) expect(secondFiles.get(path)).toEqual(bytes);
    expect(verifyProofBundle(join(first, "manifest.json"))).toMatchObject({ valid: true });
  });

  it("detects artifact tampering", () => {
    const root = temporaryRoot();
    const manifestPath = build(join(root, "bundle"));
    const manifest = parseProofManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
    const target = resolve(join(root, "bundle"), manifest.artifacts[0]!.path);
    writeFileSync(target, `${readFileSync(target, "utf8")} `, "utf8");

    expect(verifyProofBundle(manifestPath)).toMatchObject({ valid: false });
  });

  it("requires provenance and prevents synthetic evidence from being relabelled as real", () => {
    const root = temporaryRoot();
    const manifest = JSON.parse(readFileSync(build(join(root, "bundle")), "utf8")) as {
      evidence: Array<Record<string, unknown>>;
    };
    const withoutProvenance = structuredClone(manifest);
    delete withoutProvenance.evidence[0]!.provenance;
    expect(() => parseProofManifest(withoutProvenance)).toThrow();

    const relabelled = structuredClone(manifest);
    const realWebhook = relabelled.evidence.find((item) => item.id === "real_webhook")!;
    realWebhook.provenance = "SYNTHETIC_CHAOS";
    realWebhook.status = "VERIFIED";
    expect(() => parseProofManifest(relabelled)).toThrow();
  });

  it("rejects secrets, raw webhook bodies, contact data, and real-looking provider IDs", () => {
    expect(() => assertSanitizedArtifact({ value: "WEBHOOK_SECRET=hidden" })).toThrow();
    expect(() => assertSanitizedArtifact({ raw_body: "{}" })).toThrow();
    expect(() => assertSanitizedArtifact({ payload: { payment: { entity: {} } } })).toThrow();
    expect(() => assertSanitizedArtifact({ contact: "buyer@example.test" })).toThrow();
    expect(() => assertSanitizedArtifact({ payment: "pay_REALLOOKING123" })).toThrow();
    expect(() => assertSanitizedArtifact({ payment_id_hash: `sha256:${"a".repeat(64)}` })).not.toThrow();
  });

  it("keeps missing provider evidence visibly pending and scores reproducibly", () => {
    const root = temporaryRoot();
    const first = build(join(root, "first"));
    const second = build(join(root, "second"));
    const firstScore = loadVerifiedScoreboard(first);
    const secondScore = loadVerifiedScoreboard(second);

    expect(firstScore).toEqual(secondScore);
    expect(firstScore.real_webhook_status).toBe("PENDING_EXTERNAL_REPLAY");
    const manifest = parseProofManifest(JSON.parse(readFileSync(first, "utf8")) as unknown);
    expect(manifest.evidence.find((item) => item.id === "real_webhook")).toMatchObject({
      provenance: "PENDING_EXTERNAL_REPLAY",
      status: "PENDING"
    });
  });

  it("fails closed on unsupported manifest versions", () => {
    const root = temporaryRoot();
    const manifestPath = build(join(root, "bundle"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.bundle_version = 2;
    expect(() => parseProofManifest(manifest)).toThrow();
  });
});
