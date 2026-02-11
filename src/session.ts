/**
 * Session Persistence Store with Enhanced Context Tracking
 *
 * Tracks model selections per session with:
 * - Context snapshots for conversation continuity
 * - Performance metrics and success tracking
 * - Intelligent degradation on consecutive failures
 * - Tool chain state preservation
 */

import type { Tier } from "./router/types.js";
import { getModelHealthTracker } from "./model-health.js";

export type SessionContextSnapshot = {
  /** Topics/themes detected in conversation */
  topics: string[];
  /** Detected intent category */
  intent: string;
  /** Estimated complexity trend (0-1) */
  complexityTrend: number;
  /** Whether tools have been used */
  hasUsedTools: boolean;
  /** Last tool sequence */
  lastToolSequence: string[];
  /** Average response length */
  avgResponseLength: number;
};

export type SessionPerformanceMetrics = {
  /** Success rate for this session (0-1) */
  successRate: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Average cost per request */
  avgCost: number;
  /** Consecutive failures count */
  consecutiveFailures: number;
  /** Total input tokens */
  totalInputTokens: number;
  /** Total output tokens */
  totalOutputTokens: number;
  /** Request timestamps for rate tracking */
  requestTimestamps: number[];
};

export type SessionDegradationState = {
  /** Whether session has been degraded */
  isDegraded: boolean;
  /** Original model before degradation */
  originalModel?: string;
  /** Original tier before degradation */
  originalTier?: Tier;
  /** Degradation reason */
  reason?: string;
  /** Timestamp of degradation */
  degradedAt?: number;
  /** Number of successful requests since degradation */
  recoveryRequests: number;
};

export type SessionEntry = {
  model: string;
  tier: Tier;
  createdAt: number;
  lastUsedAt: number;
  requestCount: number;
  /** Enhanced context tracking */
  contextSnapshot: SessionContextSnapshot;
  /** Performance metrics */
  metrics: SessionPerformanceMetrics;
  /** Degradation state */
  degradation: SessionDegradationState;
  /** Recent error log (last 5) */
  recentErrors: Array<{ timestamp: number; error: string; model: string }>;
};

export type SessionConfig = {
  /** Enable session persistence (default: false) */
  enabled: boolean;
  /** Session timeout in ms (default: 30 minutes) */
  timeoutMs: number;
  /** Header name for session ID (default: X-Session-ID) */
  headerName: string;
  /** Consecutive failures before degradation (default: 2) */
  degradationThreshold: number;
  /** Recovery requests needed to restore original model (default: 3) */
  recoveryThreshold: number;
  /** Max requests to track timestamps (default: 50) */
  maxRequestHistory: number;
};

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  enabled: false,
  timeoutMs: 30 * 60 * 1000, // 30 minutes
  headerName: "x-session-id",
  degradationThreshold: 2,
  recoveryThreshold: 3,
  maxRequestHistory: 50,
};

/**
 * Session persistence store with enhanced tracking
 */
export class SessionStore {
  private sessions: Map<string, SessionEntry> = new Map();
  private config: SessionConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<SessionConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };

    // Start cleanup interval (every 5 minutes)
    if (this.config.enabled) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    }
  }

  /**
   * Get the pinned model for a session, if any.
   * Returns degraded model if session is in degraded state.
   */
  getSession(sessionId: string): SessionEntry | undefined {
    if (!this.config.enabled || !sessionId) {
      return undefined;
    }

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return undefined;
    }

    // Check if session has expired
    const now = Date.now();
    if (now - entry.lastUsedAt > this.config.timeoutMs) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    // Update last used
    entry.lastUsedAt = now;

    return entry;
  }

  /**
   * Pin a model to a session with initial context.
   */
  setSession(
    sessionId: string,
    model: string,
    tier: Tier,
    context?: Partial<SessionContextSnapshot>,
  ): void {
    if (!this.config.enabled || !sessionId) {
      return;
    }

    const existing = this.sessions.get(sessionId);
    const now = Date.now();

    if (existing) {
      existing.lastUsedAt = now;
      existing.requestCount++;

      // Update model if different (e.g., fallback or degradation)
      if (existing.model !== model) {
        // If degrading, save original
        if (!existing.degradation.isDegraded) {
          existing.degradation.originalModel = existing.model;
          existing.degradation.originalTier = existing.tier;
        }
        existing.model = model;
        existing.tier = tier;
      }

      // Update context
      if (context) {
        this.updateContext(existing, context);
      }

      // Track request timestamp
      existing.metrics.requestTimestamps.push(now);
      if (existing.metrics.requestTimestamps.length > this.config.maxRequestHistory) {
        existing.metrics.requestTimestamps.shift();
      }
    } else {
      // Create new session
      this.sessions.set(sessionId, {
        model,
        tier,
        createdAt: now,
        lastUsedAt: now,
        requestCount: 1,
        contextSnapshot: {
          topics: context?.topics || [],
          intent: context?.intent || "general",
          complexityTrend: context?.complexityTrend || 0.5,
          hasUsedTools: context?.hasUsedTools || false,
          lastToolSequence: context?.lastToolSequence || [],
          avgResponseLength: context?.avgResponseLength || 0,
        },
        metrics: {
          successRate: 1.0,
          avgLatencyMs: 0,
          avgCost: 0,
          consecutiveFailures: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          requestTimestamps: [now],
        },
        degradation: {
          isDegraded: false,
          recoveryRequests: 0,
        },
        recentErrors: [],
      });
    }
  }

  /**
   * Record request result and update metrics.
   * Triggers degradation if needed.
   */
  recordResult(
    sessionId: string,
    result: {
      success: boolean;
      latencyMs: number;
      cost: number;
      inputTokens: number;
      outputTokens: number;
      error?: string;
    },
  ): void {
    if (!this.config.enabled || !sessionId) {
      return;
    }

    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    const metrics = entry.metrics;

    // Update token counts
    metrics.totalInputTokens += result.inputTokens;
    metrics.totalOutputTokens += result.outputTokens;

    // Update moving averages
    const alpha = 0.3;
    metrics.avgLatencyMs = (1 - alpha) * metrics.avgLatencyMs + alpha * result.latencyMs;
    metrics.avgCost = (1 - alpha) * metrics.avgCost + alpha * result.cost;

    if (result.success) {
      metrics.consecutiveFailures = 0;
      metrics.successRate = (1 - alpha) * metrics.successRate + alpha * 1.0;

      // Check for recovery
      if (entry.degradation.isDegraded) {
        entry.degradation.recoveryRequests++;
        if (entry.degradation.recoveryRequests >= this.config.recoveryThreshold) {
          this.restoreOriginalModel(sessionId);
        }
      }
    } else {
      metrics.consecutiveFailures++;
      metrics.successRate = (1 - alpha) * metrics.successRate + alpha * 0.0;

      // Log error
      if (result.error) {
        entry.recentErrors.push({
          timestamp: Date.now(),
          error: result.error,
          model: entry.model,
        });
        if (entry.recentErrors.length > 5) {
          entry.recentErrors.shift();
        }
      }

      // Trigger degradation if threshold reached
      if (metrics.consecutiveFailures >= this.config.degradationThreshold) {
        this.degradeSession(sessionId, `${metrics.consecutiveFailures} consecutive failures`);
      }
    }
  }

  /**
   * Degrade session to a more stable model.
   */
  private degradeSession(sessionId: string, reason: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.degradation.isDegraded) return;

    const healthTracker = getModelHealthTracker();
    const currentModel = entry.model;
    const currentTier = entry.tier;

    // Find fallback model in same tier
    const tierModels = this.getTierModels(currentTier);
    const stableModel = healthTracker.getBestModel(currentTier, tierModels);

    if (stableModel && stableModel !== currentModel) {
      // Save original
      entry.degradation = {
        isDegraded: true,
        originalModel: currentModel,
        originalTier: currentTier,
        reason,
        degradedAt: Date.now(),
        recoveryRequests: 0,
      };

      // Switch to stable model
      entry.model = stableModel;
      entry.metrics.consecutiveFailures = 0;
    }
  }

  /**
   * Restore original model after recovery.
   */
  private restoreOriginalModel(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.degradation.isDegraded) return;

    const { originalModel, originalTier } = entry.degradation;
    if (!originalModel || !originalTier) return;

    // Check if original model is healthy
    const healthTracker = getModelHealthTracker();
    if (healthTracker.isAvailable(originalModel)) {
      entry.model = originalModel;
      entry.tier = originalTier;
      entry.degradation = {
        isDegraded: false,
        recoveryRequests: 0,
      };
    }
  }

  /**
   * Get models for a tier (placeholder - should query config)
   */
  private getTierModels(tier: Tier): string[] {
    // This would ideally query the routing config
    // For now, return empty array to trigger fallback logic elsewhere
    return [];
  }

  /**
   * Update context snapshot incrementally.
   */
  private updateContext(entry: SessionEntry, context: Partial<SessionContextSnapshot>): void {
    const snapshot = entry.contextSnapshot;

    if (context.topics) {
      // Merge topics, keep unique
      snapshot.topics = [...new Set([...snapshot.topics, ...context.topics])].slice(0, 10);
    }
    if (context.intent) {
      snapshot.intent = context.intent;
    }
    if (context.complexityTrend !== undefined) {
      // Moving average of complexity
      snapshot.complexityTrend = 0.7 * snapshot.complexityTrend + 0.3 * context.complexityTrend;
    }
    if (context.hasUsedTools !== undefined) {
      snapshot.hasUsedTools = snapshot.hasUsedTools || context.hasUsedTools;
    }
    if (context.lastToolSequence) {
      snapshot.lastToolSequence = context.lastToolSequence;
    }
    if (context.avgResponseLength !== undefined) {
      snapshot.avgResponseLength =
        0.7 * snapshot.avgResponseLength + 0.3 * context.avgResponseLength;
    }
  }

  /**
   * Update context for an existing session.
   */
  updateContext(sessionId: string, context: Partial<SessionContextSnapshot>): void {
    if (!this.config.enabled || !sessionId) return;

    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.updateContext(entry, context);
    }
  }

  /**
   * Check if session is degraded.
   */
  isDegraded(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    return entry?.degradation.isDegraded ?? false;
  }

  /**
   * Get degradation info.
   */
  getDegradationInfo(
    sessionId: string,
  ):
    | { isDegraded: boolean; currentModel: string; originalModel?: string; reason?: string }
    | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    return {
      isDegraded: entry.degradation.isDegraded,
      currentModel: entry.model,
      originalModel: entry.degradation.originalModel,
      reason: entry.degradation.reason,
    };
  }

  /**
   * Touch a session to extend its timeout.
   */
  touchSession(sessionId: string): void {
    if (!this.config.enabled || !sessionId) {
      return;
    }

    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      entry.requestCount++;
    }
  }

  /**
   * Clear a specific session.
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Clear all sessions.
   */
  clearAll(): void {
    this.sessions.clear();
  }

  /**
   * Get session stats for debugging.
   */
  getStats(): {
    count: number;
    degraded: number;
    sessions: Array<{
      id: string;
      model: string;
      tier: string;
      requests: number;
      successRate: number;
      degraded: boolean;
      age: number;
    }>;
  } {
    const now = Date.now();
    const sessions = Array.from(this.sessions.entries()).map(([id, entry]) => ({
      id: id.slice(0, 8) + "...",
      model: entry.model,
      tier: entry.tier,
      requests: entry.requestCount,
      successRate: entry.metrics.successRate,
      degraded: entry.degradation.isDegraded,
      age: Math.round((now - entry.createdAt) / 1000),
    }));

    return {
      count: this.sessions.size,
      degraded: sessions.filter((s) => s.degraded).length,
      sessions: sessions.sort((a, b) => b.requests - a.requests),
    };
  }

  /**
   * Get detailed session info.
   */
  getSessionDetails(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Clean up expired sessions.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > this.config.timeoutMs) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Stop the cleanup interval.
   */
  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Generate a session ID from request headers or create a default.
 */
export function getSessionId(
  headers: Record<string, string | string[] | undefined>,
  headerName: string = DEFAULT_SESSION_CONFIG.headerName,
): string | undefined {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return undefined;
}

// Global instance
let globalSessionStore: SessionStore | null = null;

export function getSessionStore(config?: Partial<SessionConfig>): SessionStore {
  if (!globalSessionStore) {
    globalSessionStore = new SessionStore(config);
  }
  return globalSessionStore;
}

export function resetSessionStore(): void {
  globalSessionStore = null;
}
