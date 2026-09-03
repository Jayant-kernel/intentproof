import {
  MandateCompilerError,
  type CompilerPrompt,
  type MandateCompilerProvider
} from "./compiler.js";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

export interface GeminiCompilerOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class GeminiMandateCompiler implements MandateCompilerProvider {
  readonly providerName = "gemini";
  readonly modelName: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiCompilerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LLM_API_KEY ?? "";
    this.modelName = options.model ?? "gemini-2.5-flash";
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.apiKey.trim()) {
      throw new MandateCompilerError("PROVIDER_ERROR", "LLM_API_KEY is required for Gemini compilation");
    }
  }

  async generate(prompt: CompilerPrompt, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelName)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            system_instruction: { parts: [{ text: prompt.system }] },
            contents: [{ role: "user", parts: [{ text: prompt.user }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: "application/json"
            }
          })
        }
      );
      if (!response.ok) {
        throw new MandateCompilerError("PROVIDER_ERROR", `Gemini compilation failed with HTTP ${response.status}`);
      }
      const body = (await response.json()) as GeminiResponse;
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new MandateCompilerError("MALFORMED_RESPONSE", "Gemini response contained no structured output");
      }
      return text;
    } catch (error) {
      if (error instanceof MandateCompilerError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new MandateCompilerError("PROVIDER_TIMEOUT", "Gemini compilation timed out");
      }
      throw new MandateCompilerError("PROVIDER_ERROR", "Gemini compilation failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
