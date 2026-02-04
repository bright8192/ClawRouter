/**
 * Smart Router Types
 *
 * Four classification tiers — REASONING is distinct from COMPLEX because
 * reasoning tasks need different models (o3, gemini-pro) than general
 * complex tasks (gpt-4o, sonnet-4).
 */

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export type ScoringResult = {
  score: number;
  tier: Tier | null; // null = ambiguous, needs LLM classifier
  confidence: number;
  signals: string[];
};

export type RoutingDecision = {
  model: string;
  tier: Tier;
  confidence: number;
  method: "rules" | "llm";
  reasoning: string;
  costEstimate: number;
  baselineCost: number;
  savings: number; // 0-1 percentage
};

export type TierConfig = {
  primary: string;
  fallback: string[];
};

export type ScoringConfig = {
  tokenCountThresholds: { simple: number; complex: number };
  codeKeywords: string[];
  reasoningKeywords: string[];
  simpleKeywords: string[];
  technicalKeywords: string[];
  creativeKeywords: string[];
};

export type ClassifierConfig = {
  ambiguousZone: [number, number];
  llmModel: string;
  llmMaxTokens: number;
  llmTemperature: number;
  promptTruncationChars: number;
  cacheTtlMs: number;
};

export type OverridesConfig = {
  maxTokensForceComplex: number;
  structuredOutputMinTier: Tier;
};

export type RoutingConfig = {
  version: string;
  classifier: ClassifierConfig;
  scoring: ScoringConfig;
  tiers: Record<Tier, TierConfig>;
  overrides: OverridesConfig;
};
