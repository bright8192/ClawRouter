/**
 * Rule-Based Classifier
 *
 * Scores a request across multiple dimensions (token count, code presence,
 * reasoning markers, etc.) and maps the aggregate score to a tier.
 * Returns null tier for ambiguous scores — triggers LLM classifier fallback.
 *
 * Handles 70-80% of requests in < 1ms with zero cost.
 */

import type { Tier, ScoringResult, ScoringConfig } from "./types.js";

export function classifyByRules(
  prompt: string,
  systemPrompt: string | undefined,
  estimatedTokens: number,
  config: ScoringConfig,
  ambiguousZone: [number, number],
): ScoringResult {
  const text = `${systemPrompt ?? ""} ${prompt}`.toLowerCase();
  let score = 0;
  const signals: string[] = [];

  // 1. Token count
  if (estimatedTokens < config.tokenCountThresholds.simple) {
    score -= 2;
    signals.push(`short (${estimatedTokens} tokens)`);
  } else if (estimatedTokens > config.tokenCountThresholds.complex) {
    score += 2;
    signals.push(`long (${estimatedTokens} tokens)`);
  }

  // 2. Code presence
  const codeMatches = config.codeKeywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (codeMatches.length >= 2) {
    score += 2;
    signals.push(`code (${codeMatches.slice(0, 3).join(", ")})`);
  } else if (codeMatches.length === 1) {
    score += 1;
    signals.push(`possible code (${codeMatches[0]})`);
  }

  // 3. Reasoning markers — highest priority, can override to REASONING
  const reasoningMatches = config.reasoningKeywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (reasoningMatches.length > 0) {
    score += 3;
    signals.push(`reasoning (${reasoningMatches.slice(0, 3).join(", ")})`);
  }

  // 4. Technical terms
  const techMatches = config.technicalKeywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (techMatches.length >= 2) {
    score += Math.floor(techMatches.length / 2);
    signals.push(`technical (${techMatches.slice(0, 3).join(", ")})`);
  }

  // 5. Creative markers
  const creativeMatches = config.creativeKeywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (creativeMatches.length > 0) {
    score += 1;
    signals.push(`creative (${creativeMatches[0]})`);
  }

  // 6. Simple indicators
  const simpleMatches = config.simpleKeywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (simpleMatches.length > 0) {
    score -= 2;
    signals.push(`simple (${simpleMatches.slice(0, 2).join(", ")})`);
  }

  // 7. Multi-step patterns
  const multiStepPatterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  const multiStepHits = multiStepPatterns.filter((p) => p.test(text));
  if (multiStepHits.length > 0) {
    score += 1;
    signals.push("multi-step");
  }

  // 8. Question count
  const questionCount = (prompt.match(/\?/g) || []).length;
  if (questionCount > 3) {
    score += 1;
    signals.push(`${questionCount} questions`);
  }

  // --- Map score to tier ---

  let tier: Tier | null;
  let confidence: number;

  // Direct reasoning override: 2+ reasoning markers = high confidence REASONING
  if (reasoningMatches.length >= 2) {
    tier = "REASONING";
    confidence = 0.9;
  } else if (score <= 0) {
    tier = "SIMPLE";
    confidence = Math.min(0.95, 0.85 + Math.abs(score) * 0.02);
  } else if (score >= ambiguousZone[0] && score <= ambiguousZone[1]) {
    // Ambiguous zone — trigger LLM classifier
    tier = null;
    confidence = 0.5;
  } else if (score >= 3 && score <= 4) {
    tier = "MEDIUM";
    confidence = 0.75 + (score - 3) * 0.05;
  } else if (score >= 5 && score <= 6) {
    tier = "COMPLEX";
    confidence = 0.7 + (score - 5) * 0.075;
  } else if (score >= 7) {
    tier = "REASONING";
    confidence = 0.7 + Math.min(0.1, (score - 7) * 0.05);
  } else {
    tier = null;
    confidence = 0.5;
  }

  return { score, tier, confidence, signals };
}
