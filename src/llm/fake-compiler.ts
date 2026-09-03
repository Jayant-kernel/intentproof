import type { CompilerOutput } from "../mandate/artifacts.js";
import type { CompilerPrompt, MandateCompilerProvider } from "./compiler.js";

function sentencesFromPrompt(prompt: CompilerPrompt): string[] {
  const match = /SOURCE_TEXT_BEGIN\n([\s\S]*)\nSOURCE_TEXT_END/u.exec(prompt.user);
  const source = match?.[1] ?? "";
  return (source.match(/[^.!?]+[.!?]?/gu) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
}

function rupeesToPaise(value: string): number {
  return Number(value.replaceAll(",", "")) * 100;
}

export class DeterministicFakeCompiler implements MandateCompilerProvider {
  readonly providerName = "deterministic_fake";
  readonly modelName = "frozen-rule-parser-v1";

  async generate(prompt: CompilerPrompt): Promise<string> {
    const constraints: CompilerOutput["constraints"] = [];
    const budgets: CompilerOutput["budgets"] = [];
    const unsupported: CompilerOutput["unsupported_instructions"] = [];
    const ambiguities: CompilerOutput["ambiguities"] = [];
    const assumptions: string[] = [];
    let nextId = 1;

    for (const sentence of sentencesFromPrompt(prompt)) {
      const ceiling = /^Create orders up to ([\d,]+) rupees\.?$/iu.exec(sentence);
      if (ceiling?.[1]) {
        constraints.push({
          id: `C${nextId++}`,
          rule: "tool_allowlist",
          tools: ["create_order", "create_payment_link", "capture_payment"],
          quote: sentence
        });
        constraints.push({
          id: `C${nextId++}`,
          rule: "amount_ceiling",
          tool: "create_order",
          max_paise: rupeesToPaise(ceiling[1]),
          quote: sentence
        });
        continue;
      }

      const budget = /^Keep total action value under ([\d,]+) rupees per day, with no more than ([\d,]+) actions\.?$/iu.exec(sentence);
      if (budget?.[1] && budget[2]) {
        budgets.push({
          window: "24h",
          tool: "*",
          max_total_paise: rupeesToPaise(budget[1]),
          max_calls: Number(budget[2].replaceAll(",", "")),
          quote: sentence
        });
        assumptions.push("The 24-hour budget is rolling, not calendar-day based.");
        continue;
      }

      if (/^Do not capture a payment until delivery is confirmed\.?$/iu.test(sentence)) {
        constraints.push({
          id: `C${nextId++}`,
          rule: "precondition",
          tool: "capture_payment",
          assert: "delivery_confirmed",
          on_unknown: "ABSTAIN",
          quote: sentence
        });
        assumptions.push("Missing delivery evidence returns ABSTAIN.");
        continue;
      }

      const approval = /^Ask me before capturing more than ([\d,]+) rupees\.?$/iu.exec(sentence);
      if (approval?.[1]) {
        constraints.push({
          id: `C${nextId++}`,
          rule: "approval_gate",
          tool: "capture_payment",
          above_paise: rupeesToPaise(approval[1]),
          timeout_seconds: 900,
          quote: sentence
        });
        assumptions.push("An approval expires after 900 seconds.");
        continue;
      }

      const window = /^Do not act between (\d{1,2})(am|pm) and (\d{1,2})(am|pm)\.?$/iu.exec(sentence);
      if (window?.[1] && window[2] && window[3] && window[4]) {
        const hour = (raw: string, period: string): number => {
          const value = Number(raw) % 12;
          return period.toLowerCase() === "pm" ? value + 12 : value;
        };
        const blockedStart = hour(window[1], window[2]);
        const blockedEnd = hour(window[3], window[4]);
        constraints.push({
          id: `C${nextId++}`,
          rule: "time_window",
          allowed: `${String(blockedEnd).padStart(2, "0")}:00-${String(blockedStart).padStart(2, "0")}:00`,
          timezone: "Asia/Kolkata",
          quote: sentence
        });
        assumptions.push("The allowed time-window end is exclusive and uses Asia/Kolkata.");
        continue;
      }

      if (/\b(?:small|reasonable|large|soon|sometimes|normally)\b/iu.test(sentence)) {
        ambiguities.push({ source_text: sentence, reason: "The instruction has no measurable boundary" });
      } else {
        unsupported.push({ source_text: sentence, reason: "No frozen IntentProof rule represents this instruction" });
      }
    }

    return JSON.stringify({
      constraints,
      budgets,
      unsupported_instructions: unsupported,
      ambiguities,
      conservative_assumptions: [...new Set(assumptions)]
    });
  }
}

export class StaticFakeCompiler implements MandateCompilerProvider {
  readonly providerName = "static_fake";
  readonly modelName = "test-response-v1";

  constructor(
    private readonly response: string | Error,
    readonly onPrompt?: (prompt: CompilerPrompt) => void
  ) {}

  async generate(prompt: CompilerPrompt): Promise<string> {
    this.onPrompt?.(prompt);
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
}
