import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  approveMandateDraft,
  diffMandates,
  loadMandateDraft,
  saveApprovedMandate,
  saveMandateDraft,
  type MandateDiffEntry,
  type MandateDraft
} from "../mandate/artifacts.js";
import { loadMandate } from "../mandate/load.js";
import { compileMandate } from "../llm/compiler.js";
import { DeterministicFakeCompiler } from "../llm/fake-compiler.js";
import { GeminiMandateCompiler } from "../llm/gemini-compiler.js";

function usage(): never {
  throw new Error([
    "Usage:",
    "  npm run mandate -- draft --input <text-file> [--provider fake|gemini] [--output <json>] [--mandate-id <id>] [--version <n>]",
    "  npm run mandate -- review <draft-file>",
    "  npm run mandate -- approve <draft-file> --approved-by <identity> [--previous <approved-file>] [--output <json>]",
    "  npm run mandate -- diff <old-approved-file> <new-approved-file>"
  ].join("\n"));
}

function parseOptions(args: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) usage();
    options.set(name, value);
  }
  return options;
}

function only(options: Map<string, string>, allowed: readonly string[]): void {
  for (const name of options.keys()) if (!allowed.includes(name)) usage();
}

function required(options: Map<string, string>, name: string): string {
  return options.get(name) ?? usage();
}

function positiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function printReview(draft: MandateDraft): void {
  process.stdout.write(`Draft: ${draft.draft_id}\n`);
  process.stdout.write(`Mandate: ${draft.mandate_id} version ${draft.proposed_version}\n`);
  process.stdout.write(`Approvable: ${draft.review.approvable ? "yes" : "no"}\n`);
  for (const reference of draft.review.source_references) {
    process.stdout.write(
      `RULE ${reference.rule_id} source[${reference.start}:${reference.end}] ${JSON.stringify(reference.quote)}\n`
    );
  }
  for (const item of draft.review.unsupported_instructions) {
    process.stdout.write(`UNSUPPORTED ${JSON.stringify(item.source_text)} - ${item.reason}\n`);
  }
  for (const item of draft.review.ambiguities) {
    process.stdout.write(`AMBIGUOUS ${JSON.stringify(item.source_text)} - ${item.reason}\n`);
  }
  for (const assumption of draft.review.conservative_assumptions) {
    process.stdout.write(`ASSUMPTION ${assumption}\n`);
  }
  for (const error of draft.review.validation_errors) {
    process.stdout.write(`INVALID ${error}\n`);
  }
}

function printDiff(entries: readonly MandateDiffEntry[]): void {
  for (const entry of entries) {
    if (entry.operation === "CHANGE") {
      process.stdout.write(
        `CHANGE ${entry.rule_id}\n  before: ${JSON.stringify(entry.before)}\n  after:  ${JSON.stringify(entry.after)}\n`
      );
    } else if (entry.operation === "ADD") {
      process.stdout.write(`ADD ${entry.rule_id} ${JSON.stringify(entry.after)}\n`);
    } else if (entry.operation === "REMOVE") {
      process.stdout.write(`REMOVE ${entry.rule_id} ${JSON.stringify(entry.before)}\n`);
    } else {
      process.stdout.write(`UNCHANGED ${entry.rule_id}\n`);
    }
  }
}

async function draftCommand(args: readonly string[]): Promise<void> {
  const options = parseOptions(args);
  only(options, ["--input", "--provider", "--output", "--mandate-id", "--version", "--created-at"]);
  const inputPath = resolve(required(options, "--input"));
  const providerName = options.get("--provider") ?? "gemini";
  const provider =
    providerName === "fake"
      ? new DeterministicFakeCompiler()
      : providerName === "gemini"
        ? new GeminiMandateCompiler()
        : usage();
  const version = positiveInteger(options.get("--version") ?? "1", "--version");
  const inferredName = basename(inputPath).replace(/\.[^.]+$/u, "").replace(/[^A-Za-z0-9_-]+/gu, "-");
  const draft = await compileMandate({
    sourceText: readFileSync(inputPath, "utf8").trim(),
    mandateId: options.get("--mandate-id") ?? `mnd_${inferredName}`,
    proposedVersion: version,
    provider,
    ...(options.has("--created-at")
      ? { clock: () => new Date(required(options, "--created-at")) }
      : {})
  });
  const output = options.get("--output") ?? `mandates/drafts/${draft.draft_id}.json`;
  saveMandateDraft(output, draft);
  process.stdout.write(`Saved draft: ${resolve(output)}\n`);
  printReview(draft);
  if (!draft.review.approvable) process.exitCode = 2;
}

function reviewCommand(path: string, rest: readonly string[]): void {
  if (rest.length !== 0) usage();
  printReview(loadMandateDraft(resolve(path)));
}

function approveCommand(path: string, args: readonly string[]): void {
  const options = parseOptions(args);
  only(options, ["--approved-by", "--approved-at", "--previous", "--output"]);
  const draft = loadMandateDraft(resolve(path));
  const previousPath = options.get("--previous");
  const previous = previousPath ? loadMandate(resolve(previousPath)) : undefined;
  printReview(draft);
  process.stdout.write("Rule diff before approval:\n");
  printDiff(diffMandates(previous ?? null, draft.rules));
  const mandate = approveMandateDraft({
    draft,
    approvedBy: required(options, "--approved-by"),
    approvedAt: options.get("--approved-at") ?? new Date().toISOString(),
    ...(previous ? { previous } : {})
  });
  const output = options.get("--output") ??
    `mandates/approved/${mandate.mandate_id}.v${mandate.version}.json`;
  saveApprovedMandate(output, mandate);
  process.stdout.write(`Approved immutable mandate: ${resolve(output)}\n`);
  process.stdout.write(`Version: ${mandate.version}\nHash: ${mandate.mandate_hash}\n`);
}

function diffCommand(oldPath: string, newPath: string, rest: readonly string[]): void {
  if (rest.length !== 0) usage();
  const before = loadMandate(resolve(oldPath));
  const after = loadMandate(resolve(newPath));
  if (before.mandate_id !== after.mandate_id) {
    throw new Error("Cannot diff approved versions with different mandate IDs");
  }
  process.stdout.write(`${before.mandate_id} v${before.version} -> v${after.version}\n`);
  printDiff(diffMandates(before, after));
}

async function main(): Promise<void> {
  const [command, first, second, ...rest] = process.argv.slice(2);
  if (command === "draft") return draftCommand([first, second, ...rest].filter((value): value is string => value !== undefined));
  if (command === "review" && first) return reviewCommand(first, [second, ...rest].filter((value): value is string => value !== undefined));
  if (command === "approve" && first) return approveCommand(first, [second, ...rest].filter((value): value is string => value !== undefined));
  if (command === "diff" && first && second) return diffCommand(first, second, rest);
  usage();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
