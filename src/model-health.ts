/**
 * Global Model Health Tracker
 *
 * Tracks model performance across all sessions to enable:
 * 1. Global health-based model selection
 * 2. Automatic cooldown for unhealthy models
 * 3. Cross-session learning
 */

import type { Tier } from "./router/types.js";

export type ModelHealthStatus = "healthy" | "degraded" | "unhealthy" | "cooldown";

export type ModelHealthRecord = {
  model: string;
  tier: Tier;
  status: ModelHealthStatus;
  // Success tracking
  totalRequests: number;
  successfulRequests: number;
  successRate: number;
  // Latency tracking (exponential moving average)
  avgLatencyMs: number;
  p95LatencyMs: number;
  // Error tracking
  consecutiveErrors: number;
  errorTypes: Map<string, number>;
  // Cooldown tracking
  cooldownUntil: number;
  cooldownReason?: string;
  // Last activity
  lastRequest: number;
  lastSuccess: number;
};

export type ModelHealthConfig = {
  /** Success rate threshold for healthy (default: 0.95) */
  healthyThreshold: number;
  /** Success rate threshold for degraded (default: 0.80) */
  degradedThreshold: number;
  /** Max consecutive errors before cooldown (default: 3) */
  maxConsecutiveErrors: number;
  /** Cooldown duration in ms (default: 5 minutes) */
  cooldownDurationMs: number;
  /** Latency threshold for degradation in ms (default: 30000) */
  latencyThresholdMs: number;
  /** Recovery success rate threshold (default: 0.90) */
  recoveryThreshold: number;
  /** Recovery request count (default: 5) */
  recoveryRequests: number;
};

export const DEFAULT_HEALTH_CONFIG: ModelHealthConfig = {
  healthyThreshold: 0.95,
  degradedThreshold: 0.8,
  maxConsecutiveErrors: 3,
  cooldownDurationMs: 5 * 60 * 1000, // 5 minutes
  latencyThresholdMs: 30000, // 30 seconds
  recoveryThreshold: 0.9,
  recoveryRequests: 5,
};

export type HealthUpdate = {
  model: string;
  success: boolean;
  latencyMs: number;
  errorType?: string;
  timestamp: number;
};

/**
 * Global model health tracker
 */
export class ModelHealthTracker {
  private healthRecords: Map<string, ModelHealthRecord> = new Map();
  private config: ModelHealthConfig;
  private latencyHistory: Map<string, number[]> = new Map();

  constructor(config: Partial<ModelHealthConfig> = {}) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  /**
   * Initialize health record for a model
   */
  private ensureRecord(model: string, tier: Tier): ModelHealthRecord {
    let record = this.healthRecords.get(model);
    if (!record) {
      record = {
        model,
        tier,
        status: "healthy",
        totalRequests: 0,
        successfulRequests: 0,
        successRate: 1.0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        consecutiveErrors: 0,
        errorTypes: new Map(),
        cooldownUntil: 0,
        lastRequest: 0,
        lastSuccess: 0,
      };
      this.healthRecords.set(model, record);
      this.latencyHistory.set(model, []);
    }
    return record;
  }

  /**
   * Update health based on request result
   */
  updateHealth(update: HealthUpdate & { tier: Tier }): void {
    const record = this.ensureRecord(update.model, update.tier);
    const now = update.timestamp;

    record.totalRequests++;
    record.lastRequest = now;

    // Update latency (exponential moving average)
    const alpha = 0.3;
    record.avgLatencyMs = (1 - alpha) * record.avgLatencyMs + alpha * update.latencyMs;

    // Update latency history for p95 calculation
    const history = this.latencyHistory.get(update.model) || [];
    history.push(update.latencyMs);
    if (history.length > 100) {
      history.shift();
    }
    this.latencyHistory.set(update.model, history);

    // Calculate p95
    if (history.length > 0) {
      const sorted = [...history].sort((a, b) => a - b);
      const p95Index = Math.floor(sorted.length * 0.95);
      record.p95LatencyMs = sorted[p95Index] || sorted[sorted.length - 1];
    }

    if (update.success) {
      record.successfulRequests++;
      record.consecutiveErrors = 0;
      record.lastSuccess = now;
    } else {
      record.consecutiveErrors++;
      if (update.errorType) {
        const count = record.errorTypes.get(update.errorType) || 0;
        record.errorTypes.set(update.errorType, count + 1);
      }
    }

    // Recalculate success rate
    record.successRate = record.successfulRequests / record.totalRequests;

    // Update status
    this.updateStatus(record, now);
  }

  /**
   * Update model status based on current metrics
   */
  private updateStatus(record: ModelHealthRecord, now: number): void {
    // Check if in cooldown
    if (record.cooldownUntil > now) {
      record.status = "cooldown";

      // Check for recovery
      const recentRequests = record.totalRequests;
      const recentSuccesses = record.successfulRequests;
      const recentRate = recentRequests > 0 ? recentSuccesses / recentRequests : 0;

      if (
        recentRate >= this.config.recoveryThreshold &&
        recentRequests >= this.config.recoveryRequests
      ) {
        // Recover from cooldown
        record.cooldownUntil = 0;
        record.consecutiveErrors = 0;
        record.status = "degraded"; // Start as degraded, not immediately healthy
      }
      return;
    }

    // Check for cooldown trigger
    if (record.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      record.status = "cooldown";
      record.cooldownUntil = now + this.config.cooldownDurationMs;
      record.cooldownReason = `${record.consecutiveErrors} consecutive errors`;
      return;
    }

    // Check latency degradation
    if (record.p95LatencyMs > this.config.latencyThresholdMs) {
      record.status = "degraded";
      return;
    }

    // Check success rate
    if (record.successRate >= this.config.healthyThreshold) {
      record.status = "healthy";
    } else if (record.successRate >= this.config.degradedThreshold) {
      record.status = "degraded";
    } else {
      record.status = "unhealthy";
      // Auto-cooldown unhealthy models
      if (record.totalRequests >= 10) {
        record.status = "cooldown";
        record.cooldownUntil = now + this.config.cooldownDurationMs;
        record.cooldownReason = `Low success rate (${(record.successRate * 100).toFixed(1)}%)`;
      }
    }
  }

  /**
   * Get health record for a model
   */
  getHealth(model: string): ModelHealthRecord | undefined {
    return this.healthRecords.get(model);
  }

  /**
   * Check if model is available for selection
   */
  isAvailable(model: string): boolean {
    const record = this.healthRecords.get(model);
    if (!record) return true; // Unknown models are assumed healthy

    if (record.status === "cooldown") {
      // Check if cooldown expired
      if (Date.now() > record.cooldownUntil) {
        record.status = "degraded";
        record.cooldownUntil = 0;
        return true;
      }
      return false;
    }

    return record.status !== "unhealthy";
  }

  /**
   * Get best available model for a tier
   * Returns the healthiest model that's not in cooldown
   */
  getBestModel(tier: Tier, candidates: string[]): string | null {
    const available = candidates
      .filter((m) => this.isAvailable(m))
      .map((m) => ({
        model: m,
        health: this.healthRecords.get(m),
      }))
      .sort((a, b) => {
        // Sort by status priority, then success rate, then latency
        const statusPriority = { healthy: 0, degraded: 1, unhealthy: 2, cooldown: 3 };
        const aPriority = statusPriority[a.health?.status || "healthy"];
        const bPriority = statusPriority[b.health?.status || "healthy"];

        if (aPriority !== bPriority) return aPriority - bPriority;

        const aRate = a.health?.successRate ?? 1.0;
        const bRate = b.health?.successRate ?? 1.0;
        if (Math.abs(aRate - bRate) > 0.05) return bRate - aRate;

        const aLatency = a.health?.avgLatencyMs ?? 0;
        const bLatency = b.health?.avgLatencyMs ?? 0;
        return aLatency - bLatency;
      });

    return available[0]?.model || null;
  }

  /**
   * Force a model into cooldown (manual override)
   */
  forceCooldown(model: string, durationMs?: number, reason?: string): void {
    const record = this.healthRecords.get(model);
    if (!record) return;

    record.status = "cooldown";
    record.cooldownUntil = Date.now() + (durationMs || this.config.cooldownDurationMs);
    record.cooldownReason = reason || "Manual cooldown";
    record.consecutiveErrors = this.config.maxConsecutiveErrors;
  }

  /**
   * Get all health records
   */
  getAllHealth(): ModelHealthRecord[] {
    return Array.from(this.healthRecords.values()).sort((a, b) => {
      const statusPriority = { healthy: 0, degraded: 1, unhealthy: 2, cooldown: 3 };
      return statusPriority[a.status] - statusPriority[b.status];
    });
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalModels: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    cooldown: number;
    overallSuccessRate: number;
    avgLatency: number;
  } {
    const records = Array.from(this.healthRecords.values());
    const healthy = records.filter((r) => r.status === "healthy").length;
    const degraded = records.filter((r) => r.status === "degraded").length;
    const unhealthy = records.filter((r) => r.status === "unhealthy").length;
    const cooldown = records.filter((r) => r.status === "cooldown").length;

    const totalSuccess = records.reduce((sum, r) => sum + r.successRate, 0);
    const totalLatency = records.reduce((sum, r) => sum + r.avgLatencyMs, 0);

    return {
      totalModels: records.length,
      healthy,
      degraded,
      unhealthy,
      cooldown,
      overallSuccessRate: records.length > 0 ? totalSuccess / records.length : 1.0,
      avgLatency: records.length > 0 ? totalLatency / records.length : 0,
    };
  }

  /**
   * Clear all health data
   */
  clear(): void {
    this.healthRecords.clear();
    this.latencyHistory.clear();
  }

  /**
   * Get cooldown information for debugging
   */
  getCooldownInfo(): Array<{
    model: string;
    status: ModelHealthStatus;
    cooldownRemaining: number;
    reason?: string;
  }> {
    const now = Date.now();
    return Array.from(this.healthRecords.values())
      .filter((r) => r.status === "cooldown" || r.cooldownUntil > now)
      .map((r) => ({
        model: r.model,
        status: r.status,
        cooldownRemaining: Math.max(0, r.cooldownUntil - now),
        reason: r.cooldownReason,
      }));
  }
}

// Global instance
let globalHealthTracker: ModelHealthTracker | null = null;

export function getModelHealthTracker(config?: Partial<ModelHealthConfig>): ModelHealthTracker {
  if (!globalHealthTracker) {
    globalHealthTracker = new ModelHealthTracker(config);
  }
  return globalHealthTracker;
}

export function resetModelHealthTracker(): void {
  globalHealthTracker = null;
}
