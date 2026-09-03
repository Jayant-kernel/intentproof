const sensitivePatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "razorpay_key", pattern: /rzp_(?:test|live)_[A-Za-z0-9]+/gu },
  { label: "google_api_key", pattern: /AIza[A-Za-z0-9_-]{20,}/gu },
  {
    label: "assigned_secret",
    pattern: /\b(?:api[_-]?key|secret|token|authorization)\s*[:=]\s*[^\s,;]+/giu
  },
  { label: "provider_entity", pattern: /\b(?:pay|order|plink)_[A-Za-z0-9]{6,}\b/gu },
  { label: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu },
  { label: "card_like_number", pattern: /\b(?:\d[ -]*?){13,19}\b/gu },
  { label: "phone_like_number", pattern: /\b\+?\d[\d -]{8,}\d\b/gu }
];

export interface RedactionResult {
  text: string;
  findings: string[];
}

export function redactCompilerInput(sourceText: string): RedactionResult {
  let text = sourceText;
  const findings: string[] = [];
  if (
    /^[\[{]/u.test(sourceText.trim()) &&
    /"(?:payment|order|entity|customer|card|contact|email)"\s*:/iu.test(sourceText)
  ) {
    text = "[REDACTED_FINANCIAL_EVENT]";
    findings.push("financial_event");
  }
  for (const { label, pattern } of sensitivePatterns) {
    if (pattern.test(text)) {
      findings.push(label);
      pattern.lastIndex = 0;
      text = text.replace(pattern, `[REDACTED_${label.toUpperCase()}]`);
    }
    pattern.lastIndex = 0;
  }
  return { text, findings: [...new Set(findings)].sort() };
}
