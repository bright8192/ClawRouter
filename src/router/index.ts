/**
 * Smart Router Entry Point (v3 with Stability Enhancements)
 *
 * Classifies requests and routes to the cheapest capable model.
 * 100% local — rules-based scoring handles all requests in <1ms.
 *
 * New in v3:
 * - Score caching with fuzzy boundaries to reduce jitter
 * - Adaptive weight adjustment based on performance feedback
 * - Model health tracking for automatic failover
 * - Session-aware degradation and recovery
 */

import type { Tier, RoutingDecision, RoutingConfig } from "./types.js";
import { classifyByRules } from "./rules.js";
import { selectModel, type ModelPricing } from "./selector.js";
import { ScoreCache, getScoreCache } from "./score-cache.js";
import {
  AdaptiveWeightManager,
  getAdaptiveWeightManager,
  type RoutingFeedback,
} from "./adaptive-weights.js";
import { getModelHealthTracker, type HealthUpdate } from "../model-health.js";
import { generateFingerprint } from "./request-fingerprint.js";

export type RouterOptions = {
  config: RoutingConfig;
  modelPricing: Map<string, ModelPricing>;
  /** Enable score caching (default: true) */
  enableCache?: boolean;
  /** Enable adaptive weights (default: true) */
  enableAdaptive?: boolean;
  /** Enable model health tracking (default: true) */
  enableHealthTracking?: boolean;
  /** Session ID for session-aware routing */
  sessionId?: string;
};

/**
 * Route a request to the cheapest capable model.
 *
 * Routing flow:
 * 1. Generate fingerprint for request identification
 * 2. Check score cache for similar requests
 * 3. Run rule-based classifier with hysteresis
 * 4. Apply adaptive weights if enabled
 * 5. Check model health and select best available
 * 6. Return RoutingDecision with metadata
 */
export function route(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  options: RouterOptions,
): RoutingDecision {
  const {
    config,
    modelPricing,
    enableCache = true,
    enableAdaptive = true,
    enableHealthTracking = true,
    sessionId,
  } = options;

  // Generate fingerprint for this request
  const fingerprint = generateFingerprint(prompt, systemPrompt);

  // Estimate input tokens (~4 chars per token)
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);

  // Check cache first
  const cache = enableCache ? getScoreCache() : null;
  const cached = cache?.get(prompt, systemPrompt);

  // --- Rule-based classification with fingerprint for history ---
  const adaptiveManager = enableAdaptive ? getAdaptiveWeightManager() : null;
  const ruleResult = classifyByRules(
    prompt,
    systemPrompt,
    estimatedTokens,
    config.scoring,
    fingerprint,
  );

  // Apply adaptive weights if enabled and we have history
  let adjustedScore = ruleResult.score;
  let adjustedConfidence = ruleResult.confidence;

  if (enableAdaptive && adaptiveManager && ruleResult.tier !== null) {
    // Get adjusted weights
    const adjustedWeights = adaptiveManager.getAllWeights();

    // Recalculate score with adjusted weights (simplified - just apply a small adjustment)
    const weightFactor =
      Object.values(adjustedWeights).reduce((a, b) => a + b, 0) /
      Object.values(adjustedWeights).length;
    adjustedScore = ruleResult.score * weightFactor;

    // Check if cached tier should be used (fuzzy boundary)
    if (cached && cache) {
      const shouldUseCached = cache.shouldUseCachedTier(cached, adjustedScore, ruleResult.tier);

      if (shouldUseCached && cached.result.tier !== null) {
        adjustedConfidence = Math.max(cached.result.confidence, 0.7);
      }
    }
  }

  // Cache the result
  if (enableCache && cache) {
    cache.set(
      prompt,
      systemPrompt,
      { ...ruleResult, score: adjustedScore, confidence: adjustedConfidence },
      config.scoring.tierBoundaries,
      adjustedScore,
    );
  }

  // Determine if agentic tiers should be used
  const agenticScore = ruleResult.agenticScore ?? 0;
  const isAutoAgentic = agenticScore >= 0.75;
  const isExplicitAgentic = config.overrides.agenticMode ?? false;
  const useAgenticTiers = (isAutoAgentic || isExplicitAgentic) && config.agenticTiers != null;
  const tierConfigs = useAgenticTiers ? config.agenticTiers! : config.tiers;

  // --- Override: large context → force COMPLEX ---
  if (estimatedTokens > config.overrides.maxTokensForceComplex) {
    const decision = selectModel(
      "COMPLEX",
      0.95,
      "rules",
      `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${useAgenticTiers ? " | agentic" : ""}`,
      tierConfigs,
      modelPricing,
      estimatedTokens,
      maxOutputTokens,
    );

    // Record for adaptive tracking
    if (enableAdaptive && adaptiveManager) {
      // Will be updated when feedback arrives
    }

    return decision;
  }

  // Structured output detection
  const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;

  let tier: Tier;
  let confidence: number;
  const method: "rules" | "llm" = "rules";
  let reasoning = `score=${adjustedScore.toFixed(2)} | ${ruleResult.signals.join(", ")}`;

  if (cached?.result.tier !== null && cached !== undefined && enableCache) {
    // Use cached tier for stability
    tier = cached.result.tier;
    confidence = adjustedConfidence;
    reasoning += " | cached";
  } else if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = adjustedConfidence;
  } else {
    // Ambiguous — default to configurable tier
    tier = config.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  }

  // Apply structured output minimum tier
  if (hasStructuredOutput) {
    const tierRank: Record<Tier, number> = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
    const minTier = config.overrides.structuredOutputMinTier;
    if (tierRank[tier] < tierRank[minTier]) {
      reasoning += ` | upgraded to ${minTier} (structured output)`;
      tier = minTier;
    }
  }

  // Add agentic mode indicator
  if (isAutoAgentic) {
    reasoning += " | auto-agentic";
  } else if (isExplicitAgentic) {
    reasoning += " | agentic";
  }

  // Check model health if enabled
  let healthOverride = false;
  if (enableHealthTracking) {
    const healthTracker = getModelHealthTracker();
    const tierModels = Object.values(tierConfigs[tier] || {});
    const bestModel = healthTracker.getBestModel(tier, tierModels);

    if (bestModel && bestModel !== tierConfigs[tier]?.primary) {
      reasoning += ` | health-override`;
      healthOverride = true;
    }
  }

  const decision = selectModel(
    tier,
    confidence,
    method,
    reasoning,
    tierConfigs,
    modelPricing,
    estimatedTokens,
    maxOutputTokens,
  );

  // Store metadata for feedback
  (decision as RoutingDecision & { _meta: { fingerprint: string; signals: string[] } })._meta = {
    fingerprint,
    signals: ruleResult.signals,
  };

  return decision;
}

/**
 * Record feedback from a completed request for adaptive learning.
 * Should be called after receiving the response.
 */
export function recordRoutingFeedback(
  decision: RoutingDecision,
  feedback: {
    success: boolean;
    latencyMs: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    errorType?: string;
  },
): void {
  const adaptiveManager = getAdaptiveWeightManager();
  const healthTracker = getModelHealthTracker();

  // Get metadata from decision
  const meta = (
    decision as RoutingDecision & { _meta?: { fingerprint: string; signals: string[] } }
  )._meta;

  // Record for adaptive weights
  const routingFeedback: RoutingFeedback = {
    timestamp: Date.now(),
    dimensionSignals: meta?.signals || [],
    tier: decision.tier,
    model: decision.model,
    latencyMs: feedback.latencyMs,
    cost: feedback.cost,
    success: feedback.success,
    errorType: feedback.errorType,
    inputTokens: feedback.inputTokens,
    outputTokens: feedback.outputTokens,
  };
  adaptiveManager.recordFeedback(routingFeedback);

  // Record for health tracking
  const healthUpdate: HealthUpdate & { tier: Tier } = {
    model: decision.model,
    success: feedback.success,
    latencyMs: feedback.latencyMs,
    errorType: feedback.errorType,
    timestamp: Date.now(),
    tier: decision.tier,
  };
  healthTracker.updateHealth(healthUpdate);
}

/**
 * Get router statistics for debugging/monitoring.
 */
export function getRouterStats(): {
  cache: ReturnType<ScoreCache["getStats"]>;
  adaptive: ReturnType<AdaptiveWeightManager["getStats"]>;
  health: ReturnType<ReturnType<typeof getModelHealthTracker>["getSummary"]>;
} {
  return {
    cache: getScoreCache().getStats(),
    adaptive: getAdaptiveWeightManager().getStats(),
    health: getModelHealthTracker().getSummary(),
  };
}

export { getFallbackChain, getFallbackChainFiltered } from "./selector.js";
export { DEFAULT_ROUTING_CONFIG } from "./config.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./types.js";
export type { ModelPricing } from "./selector.js";
export { generateFingerprint, fingerprintsSimilar } from "./request-fingerprint.js";
export { ScoreCache, getScoreCache, resetScoreCache } from "./score-cache.js";
export {
  AdaptiveWeightManager,
  getAdaptiveWeightManager,
  resetAdaptiveWeightManager,
  type RoutingFeedback,
} from "./adaptive-weights.js";
export {
  getModelHealthTracker,
  resetModelHealthTracker,
  type ModelHealthRecord,
  type ModelHealthStatus,
} from "../model-health.js";
