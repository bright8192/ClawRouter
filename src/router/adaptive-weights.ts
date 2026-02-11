/**
 * Adaptive Weight Adjustment System
 *
 * Tracks routing performance and dynamically adjusts dimension weights
 * based on actual latency, cost, and success feedback.
 * All data stored in-memory only (resets on restart).
 */

import type { ScoringResult, Tier } from "./types.js";

export type DimensionPerformance = {
  name: string;
  totalRequests: number;
  successfulRequests: number;
  totalLatency: number;
  totalCost: number;
  avgLatency: number;
  avgCost: number;
  successRate: number;
  // Weight adjustment tracking
  currentWeight: number;
  baseWeight: number;
  adjustmentFactor: number; // 0.8 - 1.2 range
};

export type TierPerformance = {
  tier: Tier;
  requests: number;
  successRate: number;
  avgLatency: number;
  avgCost: number;
  lastUpdated: number;
};

export type AdaptiveWeightsConfig = {
  /** Adjust weights every N requests (default: 10) */
  adjustmentInterval: number;
  /** Max weight adjustment factor (default: 1.2) */
  maxAdjustment: number;
  /** Min weight adjustment factor (default: 0.8) */
  minAdjustment: number;
  /** Weight of latency in scoring (default: 0.3) */
  latencyWeight: number;
  /** Weight of cost in scoring (default: 0.3) */
  costWeight: number;
  /** Weight of success rate in scoring (default: 0.4) */
  successWeight: number;
};

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveWeightsConfig = {
  adjustmentInterval: 10,
  maxAdjustment: 1.2,
  minAdjustment: 0.8,
  latencyWeight: 0.3,
  costWeight: 0.3,
  successWeight: 0.4,
};

/**
 * Feedback from actual request execution
 */
export type RoutingFeedback = {
  timestamp: number;
  dimensionSignals: string[];
  tier: Tier;
  model: string;
  latencyMs: number;
  cost: number;
  success: boolean;
  errorType?: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Manages adaptive weight adjustments based on performance feedback
 */
export class AdaptiveWeightManager {
  private config: AdaptiveWeightsConfig;
  private dimensionStats: Map<string, DimensionPerformance> = new Map();
  private tierStats: Map<Tier, TierPerformance> = new Map();
  private recentFeedback: RoutingFeedback[] = [];
  private requestCount = 0;
  private lastAdjustment = 0;

  constructor(config: Partial<AdaptiveWeightsConfig> = {}) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
    this.initializeDimensionStats();
    this.initializeTierStats();
  }

  /**
   * Initialize dimension tracking with default weights
   */
  private initializeDimensionStats(): void {
    const dimensions = [
      "tokenCount",
      "codePresence",
      "reasoningMarkers",
      "technicalTerms",
      "creativeMarkers",
      "simpleIndicators",
      "multiStepPatterns",
      "questionComplexity",
      "imperativeVerbs",
      "constraintCount",
      "outputFormat",
      "referenceComplexity",
      "negationComplexity",
      "domainSpecificity",
      "agenticTask",
    ];

    for (const dim of dimensions) {
      this.dimensionStats.set(dim, {
        name: dim,
        totalRequests: 0,
        successfulRequests: 0,
        totalLatency: 0,
        totalCost: 0,
        avgLatency: 0,
        avgCost: 0,
        successRate: 1.0,
        currentWeight: 1.0,
        baseWeight: 1.0,
        adjustmentFactor: 1.0,
      });
    }
  }

  /**
   * Initialize tier performance tracking
   */
  private initializeTierStats(): void {
    const tiers: Tier[] = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
    for (const tier of tiers) {
      this.tierStats.set(tier, {
        tier,
        requests: 0,
        successRate: 1.0,
        avgLatency: 0,
        avgCost: 0,
        lastUpdated: Date.now(),
      });
    }
  }

  /**
   * Record feedback from a completed request
   */
  recordFeedback(feedback: RoutingFeedback): void {
    this.recentFeedback.push(feedback);
    this.requestCount++;

    // Update dimension stats based on signals
    for (const signal of feedback.dimensionSignals) {
      // Extract dimension name from signal (e.g., "code (function, class)" -> "codePresence")
      const dimName = this.signalToDimension(signal);
      if (dimName) {
        this.updateDimensionStats(dimName, feedback);
      }
    }

    // Update tier stats
    this.updateTierStats(feedback.tier, feedback);

    // Trigger adjustment if needed
    if (this.requestCount - this.lastAdjustment >= this.config.adjustmentInterval) {
      this.adjustWeights();
    }

    // Keep only recent feedback (last 100)
    if (this.recentFeedback.length > 100) {
      this.recentFeedback = this.recentFeedback.slice(-100);
    }
  }

  /**
   * Map a signal string to its dimension name
   */
  private signalToDimension(signal: string): string | null {
    const mappings: Record<string, string> = {
      code: "codePresence",
      reasoning: "reasoningMarkers",
      technical: "technicalTerms",
      creative: "creativeMarkers",
      simple: "simpleIndicators",
      "multi-step": "multiStepPatterns",
      questions: "questionComplexity",
      imperative: "imperativeVerbs",
      constraints: "constraintCount",
      format: "outputFormat",
      references: "referenceComplexity",
      negation: "negationComplexity",
      "domain-specific": "domainSpecificity",
      agentic: "agenticTask",
    };

    const key = signal.split(" ")[0].toLowerCase();
    return mappings[key] || null;
  }

  /**
   * Update statistics for a dimension
   */
  private updateDimensionStats(dimension: string, feedback: RoutingFeedback): void {
    const stats = this.dimensionStats.get(dimension);
    if (!stats) return;

    stats.totalRequests++;
    if (feedback.success) {
      stats.successfulRequests++;
    }
    stats.totalLatency += feedback.latencyMs;
    stats.totalCost += feedback.cost;

    // Recalculate averages
    stats.avgLatency = stats.totalLatency / stats.totalRequests;
    stats.avgCost = stats.totalCost / stats.totalRequests;
    stats.successRate = stats.successfulRequests / stats.totalRequests;
  }

  /**
   * Update tier statistics
   */
  private updateTierStats(tier: Tier, feedback: RoutingFeedback): void {
    const stats = this.tierStats.get(tier);
    if (!stats) return;

    const oldRequests = stats.requests;
    stats.requests++;

    // Exponential moving average
    const alpha = 0.3;
    stats.successRate = (1 - alpha) * stats.successRate + alpha * (feedback.success ? 1 : 0);
    stats.avgLatency = (1 - alpha) * stats.avgLatency + alpha * feedback.latencyMs;
    stats.avgCost = (1 - alpha) * stats.avgCost + alpha * feedback.cost;
    stats.lastUpdated = Date.now();
  }

  /**
   * Adjust weights based on performance
   */
  private adjustWeights(): void {
    this.lastAdjustment = this.requestCount;

    // Calculate tier efficiency scores
    const tierEfficiency = this.calculateTierEfficiency();

    // Adjust dimension weights based on their contribution to efficient tiers
    for (const [name, stats] of this.dimensionStats) {
      if (stats.totalRequests < 5) continue; // Need enough data

      // Calculate performance score (0-1, higher is better)
      const latencyScore = this.normalizeLatency(stats.avgLatency);
      const costScore = this.normalizeCost(stats.avgCost);
      const successScore = stats.successRate;

      const performanceScore =
        this.config.latencyWeight * latencyScore +
        this.config.costWeight * costScore +
        this.config.successWeight * successScore;

      // Adjust factor based on performance
      const targetFactor =
        this.config.minAdjustment +
        performanceScore * (this.config.maxAdjustment - this.config.minAdjustment);

      // Smooth transition
      stats.adjustmentFactor = 0.7 * stats.adjustmentFactor + 0.3 * targetFactor;
      stats.currentWeight = stats.baseWeight * stats.adjustmentFactor;
    }
  }

  /**
   * Calculate efficiency score for each tier
   */
  private calculateTierEfficiency(): Map<Tier, number> {
    const efficiencies = new Map<Tier, number>();

    for (const [tier, stats] of this.tierStats) {
      if (stats.requests < 5) {
        efficiencies.set(tier, 0.5);
        continue;
      }

      const latencyScore = this.normalizeLatency(stats.avgLatency);
      const costScore = this.normalizeCost(stats.avgCost);
      const successScore = stats.successRate;

      const efficiency =
        this.config.latencyWeight * latencyScore +
        this.config.costWeight * costScore +
        this.config.successWeight * successScore;

      efficiencies.set(tier, efficiency);
    }

    return efficiencies;
  }

  /**
   * Normalize latency to 0-1 score (lower is better)
   */
  private normalizeLatency(latency: number): number {
    // Assume 0-10s range
    return Math.max(0, 1 - latency / 10000);
  }

  /**
   * Normalize cost to 0-1 score (lower is better)
   */
  private normalizeCost(cost: number): number {
    // Assume 0-0.1 range
    return Math.max(0, 1 - cost / 0.1);
  }

  /**
   * Get adjusted weight for a dimension
   */
  getWeight(dimension: string): number {
    const stats = this.dimensionStats.get(dimension);
    return stats?.currentWeight ?? 1.0;
  }

  /**
   * Get all adjusted weights
   */
  getAllWeights(): Record<string, number> {
    const weights: Record<string, number> = {};
    for (const [name, stats] of this.dimensionStats) {
      weights[name] = stats.currentWeight;
    }
    return weights;
  }

  /**
   * Get tier performance summary
   */
  getTierPerformance(): Array<TierPerformance & { efficiency: number }> {
    const result = [];
    const efficiencies = this.calculateTierEfficiency();

    for (const [tier, stats] of this.tierStats) {
      result.push({
        ...stats,
        efficiency: efficiencies.get(tier) ?? 0.5,
      });
    }

    return result.sort((a, b) => b.efficiency - a.efficiency);
  }

  /**
   * Get dimension performance summary
   */
  getDimensionPerformance(): DimensionPerformance[] {
    return Array.from(this.dimensionStats.values()).sort((a, b) => b.successRate - a.successRate);
  }

  /**
   * Reset all adaptive data
   */
  reset(): void {
    this.dimensionStats.clear();
    this.tierStats.clear();
    this.recentFeedback = [];
    this.requestCount = 0;
    this.lastAdjustment = 0;
    this.initializeDimensionStats();
    this.initializeTierStats();
  }

  /**
   * Get summary statistics
   */
  getStats(): {
    totalRequests: number;
    dimensionsTracked: number;
    lastAdjustment: number;
    avgSuccessRate: number;
  } {
    const totalSuccess = Array.from(this.dimensionStats.values()).reduce(
      (sum, d) => sum + d.successRate,
      0,
    );

    return {
      totalRequests: this.requestCount,
      dimensionsTracked: this.dimensionStats.size,
      lastAdjustment: this.lastAdjustment,
      avgSuccessRate: totalSuccess / this.dimensionStats.size,
    };
  }
}

// Global instance
let globalManager: AdaptiveWeightManager | null = null;

export function getAdaptiveWeightManager(
  config?: Partial<AdaptiveWeightsConfig>,
): AdaptiveWeightManager {
  if (!globalManager) {
    globalManager = new AdaptiveWeightManager(config);
  }
  return globalManager;
}

export function resetAdaptiveWeightManager(): void {
  globalManager = null;
}
