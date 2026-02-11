/**
 * Score Cache with Fuzzy Boundaries
 *
 * Caches scoring results by fingerprint to:
 * 1. Reduce computation for similar requests
 * 2. Prevent boundary jitter through hysteresis
 * 3. Provide stability for repeated similar queries
 */

import type { ScoringResult, Tier } from "./types.js";
import { getCacheKey } from "./request-fingerprint.js";

export type CachedScore = {
  result: ScoringResult;
  timestamp: number;
  hitCount: number;
  lastTier: Tier;
  // Track boundary proximity for jitter detection
  distanceToBoundary: number;
  boundaryName: string;
};

export type ScoreCacheConfig = {
  /** Max entries in cache */
  maxSize: number;
  /** TTL in milliseconds (default: 24 hours) */
  ttlMs: number;
  /** Fuzzy boundary width (default: 0.05) */
  fuzzyBoundaryWidth: number;
  /** Jitter detection: consecutive tier switches before locking (default: 3) */
  jitterThreshold: number;
};

export const DEFAULT_CACHE_CONFIG: ScoreCacheConfig = {
  maxSize: 1000,
  ttlMs: 24 * 60 * 60 * 1000, // 24 hours
  fuzzyBoundaryWidth: 0.05,
  jitterThreshold: 3,
};

/**
 * LRU cache with TTL and fuzzy boundary support
 */
export class ScoreCache {
  private cache: Map<string, CachedScore> = new Map();
  private config: ScoreCacheConfig;
  private accessOrder: string[] = [];

  // Jitter tracking: fingerprint -> tier history
  private jitterTracker: Map<string, Tier[]> = new Map();
  private jitterLocks: Map<string, Tier> = new Map();

  constructor(config: Partial<ScoreCacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
  }

  /**
   * Get cached score if valid and not expired
   */
  get(prompt: string, systemPrompt: string | undefined): CachedScore | undefined {
    const key = getCacheKey(prompt, systemPrompt);

    // Check for jitter lock first
    const lockedTier = this.jitterLocks.get(key);

    const cached = this.cache.get(key);
    if (!cached) return undefined;

    // Check TTL
    const now = Date.now();
    if (now - cached.timestamp > this.config.ttlMs) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      return undefined;
    }

    // Update access order (LRU)
    this.updateAccessOrder(key);
    cached.hitCount++;

    // If locked due to jitter, return locked tier
    if (lockedTier && cached.result.tier !== lockedTier) {
      return {
        ...cached,
        result: {
          ...cached.result,
          tier: lockedTier,
          confidence: Math.max(cached.result.confidence, 0.7),
        },
      };
    }

    return cached;
  }

  /**
   * Store score in cache with boundary tracking
   */
  set(
    prompt: string,
    systemPrompt: string | undefined,
    result: ScoringResult,
    boundaries: { simpleMedium: number; mediumComplex: number; complexReasoning: number },
    score: number,
  ): void {
    const key = getCacheKey(prompt, systemPrompt);

    // Calculate distance to nearest boundary
    const { distance, boundaryName } = this.calculateBoundaryProximity(score, boundaries);

    // Check for jitter
    this.trackJitter(key, result.tier);

    const cached: CachedScore = {
      result,
      timestamp: Date.now(),
      hitCount: 1,
      lastTier: result.tier || "MEDIUM",
      distanceToBoundary: distance,
      boundaryName,
    };

    // Evict oldest if at capacity
    if (this.cache.size >= this.config.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, cached);
    this.updateAccessOrder(key);
  }

  /**
   * Check if we should use cached tier despite new score
   * (fuzzy boundary logic)
   */
  shouldUseCachedTier(cached: CachedScore, newScore: number, newTier: Tier | null): boolean {
    if (!newTier || !cached.result.tier) return false;
    if (cached.result.tier === newTier) return false; // Same tier, no need

    // If new score is within fuzzy boundary of the boundary, use cached for stability
    const fuzzyRange = this.config.fuzzyBoundaryWidth;
    if (cached.distanceToBoundary < fuzzyRange) {
      // We're near a boundary - stay with current tier for stability
      // even if new calculation suggests a different tier
      return true;
    }

    return false;
  }

  /**
   * Calculate how close the score is to the nearest tier boundary
   */
  private calculateBoundaryProximity(
    score: number,
    boundaries: { simpleMedium: number; mediumComplex: number; complexReasoning: number },
  ): { distance: number; boundaryName: string } {
    const { simpleMedium, mediumComplex, complexReasoning } = boundaries;

    const distances = [
      { dist: Math.abs(score - simpleMedium), name: "simple-medium" },
      { dist: Math.abs(score - mediumComplex), name: "medium-complex" },
      { dist: Math.abs(score - complexReasoning), name: "complex-reasoning" },
    ];

    const nearest = distances.reduce((min, curr) => (curr.dist < min.dist ? curr : min));

    return { distance: nearest.dist, boundaryName: nearest.name };
  }

  /**
   * Check if score crossed a tier boundary
   */
  private checkBoundaryCrossed(
    previousDistance: number,
    previousTier: Tier,
    newTier: Tier,
    newScore: number,
  ): boolean {
    // If tier changed, boundary was crossed
    if (previousTier !== newTier) return true;
    return false;
  }

  /**
   * Track tier changes to detect jitter
   */
  private trackJitter(key: string, tier: Tier | null): void {
    if (!tier) return;

    const history = this.jitterTracker.get(key) || [];
    history.push(tier);

    // Keep last 5 tier decisions
    if (history.length > 5) {
      history.shift();
    }

    this.jitterTracker.set(key, history);

    // Check for jitter pattern (alternating tiers)
    if (history.length >= this.config.jitterThreshold) {
      const recent = history.slice(-this.config.jitterThreshold);
      const uniqueTiers = [...new Set(recent)];

      // If we've switched tiers 3+ times in a row, lock to most frequent
      if (uniqueTiers.length >= 2) {
        const tierCounts = new Map<Tier, number>();
        for (const t of recent) {
          tierCounts.set(t, (tierCounts.get(t) || 0) + 1);
        }

        const mostFrequent = [...tierCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (mostFrequent) {
          this.jitterLocks.set(key, mostFrequent[0]);
        }
      }
    }
  }

  /**
   * Update LRU access order
   */
  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  /**
   * Remove from access order
   */
  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Evict least recently used entry
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;
    const oldest = this.accessOrder.shift();
    if (oldest) {
      this.cache.delete(oldest);
      this.jitterTracker.delete(oldest);
      this.jitterLocks.delete(oldest);
    }
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.jitterTracker.clear();
    this.jitterLocks.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    hitRates: number[];
    jitterLocks: number;
  } {
    const hitRates = Array.from(this.cache.values()).map((c) => c.hitCount);
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hitRates,
      jitterLocks: this.jitterLocks.size,
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, cached] of this.cache) {
      if (now - cached.timestamp > this.config.ttlMs) {
        this.cache.delete(key);
        this.removeFromAccessOrder(key);
        this.jitterTracker.delete(key);
        this.jitterLocks.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }
}

// Global cache instance
let globalCache: ScoreCache | null = null;

export function getScoreCache(config?: Partial<ScoreCacheConfig>): ScoreCache {
  if (!globalCache) {
    globalCache = new ScoreCache(config);
  }
  return globalCache;
}

export function resetScoreCache(): void {
  globalCache = null;
}
