import { PlannerError, type PlannerPrompt, type PlannerProvider } from "./planner.js";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export interface GeminiPlannerOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const responseSchema = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      enum: ["create_order", "create_payment_link", "capture_payment", "no_action"]
    },
    arguments: { type: "object" },
    intent_id: { type: "string" },
    explanation: { type: "string" }
  },
  required: ["tool", "arguments", "intent_id", "explanation"]
} as const;

export class GeminiPlanner implements PlannerProvider {
  readonly providerName = "gemini";
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiPlannerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LLM_API_KEY ?? "";
    this.modelName = options.model ?? "gemini-2.5-flash";
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.apiKey.trim()) {
      throw new PlannerError("PROVIDER_ERROR", "LLM_API_KEY is required for Gemini planning");
    }
  }

  async generate(
    prompt: PlannerPrompt,
    timeoutMs: number,
    maxOutputBytes: number
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          signal: controller.signal,
          body: JSON.stringify({
            system_instruction: { parts: [{ text: prompt.system }] },
            contents: [{ role: "user", parts: [{ text: prompt.user }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: Math.min(2_048, Math.max(128, Math.ceil(maxOutputBytes / 4))),
              responseMimeType: "application/json",
              responseSchema
            }
          })
        }
      );
      if (!response.ok) {
        throw new PlannerError("PROVIDER_ERROR", `Gemini planning failed with HTTP ${response.status}`);
      }
      const envelope = await response.text();
      if (Buffer.byteLength(envelope, "utf8") > maxOutputBytes * 4 + 65_536) {
        throw new PlannerError("OUTPUT_TOO_LARGE", "Gemini response envelope exceeded the byte limit");
      }
      let body: GeminiResponse;
      try {
        body = JSON.parse(envelope) as GeminiResponse;
      } catch {
        throw new PlannerError("MALFORMED_RESPONSE", "Gemini returned a malformed response envelope");
      }
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new PlannerError("MALFORMED_RESPONSE", "Gemini response contained no structured output");
      }
      if (Buffer.byteLength(text, "utf8") > maxOutputBytes) {
        throw new PlannerError("OUTPUT_TOO_LARGE", "Gemini planner output exceeded the byte limit");
      }
      return text;
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new PlannerError("PROVIDER_TIMEOUT", "Gemini planning timed out");
      }
      throw new PlannerError("PROVIDER_ERROR", "Gemini planning failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
