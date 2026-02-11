/**
 * Router Stability System Tests
 *
 * Tests for:
 * - Request fingerprinting
 * - Score caching with fuzzy boundaries
 * - Adaptive weight adjustment
 * - Model health tracking
 * - Session degradation and recovery
 *
 * Usage:
 *   npx tsx test-router-stability.ts
 */

import { generateFingerprint, fingerprintsSimilar } from "../src/router/request-fingerprint.js";
import { ScoreCache, DEFAULT_CACHE_CONFIG } from "../src/router/score-cache.js";
import { AdaptiveWeightManager, DEFAULT_ADAPTIVE_CONFIG } from "../src/router/adaptive-weights.js";
import { ModelHealthTracker, DEFAULT_HEALTH_CONFIG } from "../src/model-health.js";
import { SessionStore, DEFAULT_SESSION_CONFIG } from "../src/session.js";
import type { Tier } from "../src/router/types.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    process.stdout.write(`  ${name} ... `);
    try {
      await fn();
      console.log("PASS");
      passed++;
    } catch (err) {
      console.log("FAIL");
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  };
  return run();
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition: boolean, msg?: string) {
  if (!condition) throw new Error(msg || "Expected true, got false");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log("\nRouter Stability System Tests\n");

// ==================== Request Fingerprinting ====================

console.log("Request Fingerprinting:");

await test("generates consistent fingerprints for identical prompts", () => {
  const prompt = "What is the capital of France?";
  const fp1 = generateFingerprint(prompt, undefined);
  const fp2 = generateFingerprint(prompt, undefined);
  assertEqual(fp1, fp2, "Fingerprints should be identical");
});

await test("generates different fingerprints for different prompts", () => {
  const fp1 = generateFingerprint("What is 2+2?", undefined);
  const fp2 = generateFingerprint("Explain quantum physics", undefined);
  assert(fp1 !== fp2, "Fingerprints should be different");
});

await test("normalizes case differences", () => {
  const fp1 = generateFingerprint("Hello World", undefined);
  const fp2 = generateFingerprint("hello world", undefined);
  const similar = fingerprintsSimilar(fp1, fp2);
  assertTrue(similar, "Fingerprints should be similar despite case difference");
});

await test("normalizes punctuation differences", () => {
  const fp1 = generateFingerprint("Hello, world!", undefined);
  const fp2 = generateFingerprint("Hello world", undefined);
  const similar = fingerprintsSimilar(fp1, fp2);
  assertTrue(similar, "Fingerprints should be similar despite punctuation");
});

await test("detects code presence in features", () => {
  const codePrompt = "function add(a, b) { return a + b; }";
  const fp = generateFingerprint(codePrompt, undefined);
  assertTrue(fp.includes("CODE"), "Fingerprint should contain CODE feature");
});

await test("detects multi-step patterns", () => {
  const multiStepPrompt = "Step 1: Do this. Step 2: Do that.";
  const fp = generateFingerprint(multiStepPrompt, undefined);
  assertTrue(fp.includes("MULTISTEP"), "Fingerprint should contain MULTISTEP feature");
});

await test("counts questions correctly", () => {
  const q1 = generateFingerprint("What is A?", undefined);
  const q3 = generateFingerprint("What is A? How about B? Where is C?", undefined);
  assertTrue(q1.includes("Q1"), "Should detect 1 question");
  assertTrue(q3.includes("Q3"), "Should detect 3 questions");
});

await test("handles Chinese text", () => {
  const chinesePrompt = "你好世界？怎么做到的？";
  const fp = generateFingerprint(chinesePrompt, undefined);
  assertTrue(fp.includes("Q2"), "Should detect 2 Chinese questions");
});

await test("includes system prompt in fingerprint", () => {
  const prompt = "Hello";
  const sys1 = "You are a helpful assistant";
  const sys2 = "You are a code expert";
  const fp1 = generateFingerprint(prompt, sys1);
  const fp2 = generateFingerprint(prompt, sys2);
  assert(fp1 !== fp2, "Different system prompts should produce different fingerprints");
});

// ==================== Score Cache ====================

console.log("\nScore Cache:");

let testCache: ScoreCache;

await test("caches and retrieves scores", () => {
  testCache = new ScoreCache();
  const result = {
    score: 0.5,
    tier: "MEDIUM" as Tier,
    confidence: 0.85,
    signals: ["test"],
  };

  testCache.set(
    "test prompt",
    undefined,
    result,
    { simpleMedium: -0.2, mediumComplex: 0.0, complexReasoning: 0.3 },
    0.5,
  );

  const cached = testCache.get("test prompt", undefined);
  assert(cached !== undefined, "Should retrieve cached result");
  assertEqual(cached?.result.tier, "MEDIUM", "Tier should match");
  assertEqual(cached?.result.confidence, 0.85, "Confidence should match");
  testCache.clear();
});

await test("returns undefined for cache miss", () => {
  testCache = new ScoreCache();
  const cached = testCache.get("nonexistent prompt", undefined);
  assert(cached === undefined, "Should return undefined for cache miss");
  testCache.clear();
});

await test("tracks hit count", () => {
  testCache = new ScoreCache();
  const result = {
    score: 0.5,
    tier: "SIMPLE" as Tier,
    confidence: 0.9,
    signals: [],
  };

  testCache.set(
    "prompt",
    undefined,
    result,
    { simpleMedium: -0.2, mediumComplex: 0.0, complexReasoning: 0.3 },
    0.5,
  );

  // Initial hitCount is 1 (set), then each get() increments it
  // get + get + get(to check) = 1 + 3 = 4
  testCache.get("prompt", undefined);
  testCache.get("prompt", undefined);

  const cached = testCache.get("prompt", undefined);
  assertEqual(cached?.hitCount, 4, "Hit count should be 4 (1 from set + 3 from get)");
  testCache.clear();
});

await test("respects TTL", async () => {
  const shortCache = new ScoreCache({ ttlMs: 1 });
  const result = {
    score: 0.5,
    tier: "SIMPLE" as Tier,
    confidence: 0.9,
    signals: [],
  };

  shortCache.set(
    "prompt",
    undefined,
    result,
    { simpleMedium: -0.2, mediumComplex: 0.0, complexReasoning: 0.3 },
    0.5,
  );

  // Wait for expiry
  await sleep(10);
  const cached = shortCache.get("prompt", undefined);
  assert(cached === undefined, "Cache entry should have expired");
});

await test("enforces max size with LRU eviction", () => {
  const smallCache = new ScoreCache({ maxSize: 2 });
  const result = {
    score: 0.5,
    tier: "SIMPLE" as Tier,
    confidence: 0.9,
    signals: [],
  };

  smallCache.set("prompt1", undefined, result, DEFAULT_CACHE_CONFIG as any, 0.5);
  smallCache.set("prompt2", undefined, result, DEFAULT_CACHE_CONFIG as any, 0.5);
  smallCache.set("prompt3", undefined, result, DEFAULT_CACHE_CONFIG as any, 0.5);

  const stats = smallCache.getStats();
  assertEqual(stats.size, 2, "Cache size should be limited to 2");
});

await test("detects jitter and locks tier", () => {
  testCache = new ScoreCache();
  const result1 = { score: 0.1, tier: "SIMPLE" as Tier, confidence: 0.8, signals: [] };
  const result2 = { score: 0.15, tier: "MEDIUM" as Tier, confidence: 0.7, signals: [] };
  const boundaries = { simpleMedium: -0.2, mediumComplex: 0.0, complexReasoning: 0.3 };

  // Simulate jitter: SIMPLE -> MEDIUM -> SIMPLE
  testCache.set("prompt", undefined, result1, boundaries, 0.1);
  testCache.set("prompt", undefined, result2, boundaries, 0.15);
  testCache.set("prompt", undefined, result1, boundaries, 0.1);

  // Check if locked
  const cached = testCache.get("prompt", undefined);
  assert(cached !== undefined, "Should have cached result");
  testCache.clear();
});

await test("uses fuzzy boundary for stability", () => {
  testCache = new ScoreCache();
  const cachedResult = {
    score: 0.05,
    tier: "SIMPLE" as Tier,
    confidence: 0.7,
    signals: ["boundary"],
  };
  const cached = {
    result: cachedResult,
    timestamp: Date.now(),
    hitCount: 1,
    distanceToBoundary: 0.03, // Within fuzzy range
    boundaryName: "simple-medium",
    lastTier: "SIMPLE",
  };

  // New score suggests MEDIUM, but we're in fuzzy region
  const shouldUseCached = testCache.shouldUseCachedTier(cached, 0.15, "MEDIUM");
  assertTrue(shouldUseCached, "Should use cached tier in fuzzy boundary");
  testCache.clear();
});

// ==================== Adaptive Weight Manager ====================

console.log("\nAdaptive Weight Manager:");

let testManager: AdaptiveWeightManager;

await test("initializes with default weights", () => {
  testManager = new AdaptiveWeightManager();
  const weight = testManager.getWeight("codePresence");
  assertEqual(weight, 1.0, "Default weight should be 1.0");
});

await test("records feedback and updates stats", () => {
  testManager = new AdaptiveWeightManager();
  testManager.recordFeedback({
    timestamp: Date.now(),
    dimensionSignals: ["code (function, class)"],
    tier: "COMPLEX",
    model: "gpt-4",
    latencyMs: 1500,
    cost: 0.05,
    success: true,
    inputTokens: 100,
    outputTokens: 200,
  });

  const stats = testManager.getStats();
  assertEqual(stats.totalRequests, 1, "Should have recorded 1 request");
});

await test("calculates success rate correctly", () => {
  testManager = new AdaptiveWeightManager();
  for (let i = 0; i < 5; i++) {
    testManager.recordFeedback({
      timestamp: Date.now(),
      dimensionSignals: ["code"],
      tier: "MEDIUM",
      model: "gpt-4",
      latencyMs: 1000,
      cost: 0.02,
      success: i < 3, // 3 success, 2 failures
      inputTokens: 100,
      outputTokens: 150,
    });
  }

  const perf = testManager.getDimensionPerformance();
  const codePerf = perf.find((p) => p.name === "codePresence");
  assert(codePerf !== undefined, "Should have code performance data");
  assert(codePerf!.successRate < 1.0, "Success rate should be less than 100%");
  assert(codePerf!.successRate > 0, "Success rate should be greater than 0");
});

await test("tracks tier performance separately", () => {
  testManager = new AdaptiveWeightManager();
  testManager.recordFeedback({
    timestamp: Date.now(),
    dimensionSignals: [],
    tier: "SIMPLE",
    model: "gpt-3.5",
    latencyMs: 500,
    cost: 0.01,
    success: true,
    inputTokens: 50,
    outputTokens: 100,
  });

  testManager.recordFeedback({
    timestamp: Date.now(),
    dimensionSignals: [],
    tier: "COMPLEX",
    model: "gpt-4",
    latencyMs: 2000,
    cost: 0.08,
    success: true,
    inputTokens: 200,
    outputTokens: 300,
  });

  const tierPerf = testManager.getTierPerformance();
  assertEqual(tierPerf.length, 4, "Should track all 4 tiers");
});

await test("adjusts weights after interval", () => {
  const config = { adjustmentInterval: 3 };
  const adjManager = new AdaptiveWeightManager(config);

  // Record successful feedback
  for (let i = 0; i < 3; i++) {
    adjManager.recordFeedback({
      timestamp: Date.now(),
      dimensionSignals: ["code"],
      tier: "MEDIUM",
      model: "gpt-4",
      latencyMs: 800,
      cost: 0.02,
      success: true,
      inputTokens: 100,
      outputTokens: 150,
    });
  }

  // Weights should have been adjusted
  const stats = adjManager.getStats();
  assertEqual(stats.lastAdjustment, 3, "Weights should be adjusted after 3 requests");
});

// ==================== Model Health Tracker ====================

console.log("\nModel Health Tracker:");

let testTracker: ModelHealthTracker;

await test("tracks model health on success", () => {
  testTracker = new ModelHealthTracker();
  testTracker.updateHealth({
    model: "gpt-4",
    success: true,
    latencyMs: 1500,
    timestamp: Date.now(),
    tier: "COMPLEX",
  });

  const health = testTracker.getHealth("gpt-4");
  assert(health !== undefined, "Should have health record");
  assertEqual(health?.successRate, 1.0, "Success rate should be 100%");
  assertEqual(health?.status, "healthy", "Status should be healthy");
});

await test("tracks consecutive errors", () => {
  testTracker = new ModelHealthTracker();
  for (let i = 0; i < 3; i++) {
    testTracker.updateHealth({
      model: "gpt-4",
      success: false,
      latencyMs: 100,
      errorType: "timeout",
      timestamp: Date.now(),
      tier: "COMPLEX",
    });
  }

  const health = testTracker.getHealth("gpt-4");
  assertEqual(health?.consecutiveErrors, 3, "Should track 3 consecutive errors");
  assertEqual(health?.status, "cooldown", "Should enter cooldown");
});

await test("enters cooldown after max consecutive errors", () => {
  const config = { maxConsecutiveErrors: 2 };
  const customTracker = new ModelHealthTracker(config);

  for (let i = 0; i < 2; i++) {
    customTracker.updateHealth({
      model: "gpt-4",
      success: false,
      latencyMs: 100,
      timestamp: Date.now(),
      tier: "COMPLEX",
    });
  }

  const health = customTracker.getHealth("gpt-4");
  assertEqual(health?.status, "cooldown", "Should enter cooldown after 2 errors");
  assert(
    health?.cooldownUntil !== undefined && health.cooldownUntil > Date.now(),
    "Cooldown should be in future",
  );
});

await test("not available when in cooldown", () => {
  const config = { maxConsecutiveErrors: 1 };
  const customTracker = new ModelHealthTracker(config);

  customTracker.updateHealth({
    model: "gpt-4",
    success: false,
    latencyMs: 100,
    timestamp: Date.now(),
    tier: "COMPLEX",
  });

  assertTrue(!customTracker.isAvailable("gpt-4"), "Should not be available in cooldown");
});

await test("selects best model from candidates", () => {
  testTracker = new ModelHealthTracker();

  // Model A: healthy
  testTracker.updateHealth({
    model: "model-a",
    success: true,
    latencyMs: 1000,
    timestamp: Date.now(),
    tier: "MEDIUM",
  });

  // Model B: degraded (higher latency)
  for (let i = 0; i < 5; i++) {
    testTracker.updateHealth({
      model: "model-b",
      success: true,
      latencyMs: 5000,
      timestamp: Date.now(),
      tier: "MEDIUM",
    });
  }

  const best = testTracker.getBestModel("MEDIUM", ["model-a", "model-b"]);
  assertEqual(best, "model-a", "Should select the healthier model");
});

await test("provides health summary", () => {
  testTracker = new ModelHealthTracker();
  testTracker.updateHealth({
    model: "gpt-4",
    success: true,
    latencyMs: 1500,
    timestamp: Date.now(),
    tier: "COMPLEX",
  });

  const summary = testTracker.getSummary();
  assertEqual(summary.totalModels, 1, "Should track 1 model");
  assertEqual(summary.healthy, 1, "Should have 1 healthy model");
  assertEqual(summary.overallSuccessRate, 1.0, "Overall success rate should be 100%");
});

// ==================== Enhanced Session Store ====================

console.log("\nEnhanced Session Store:");

let testStore: SessionStore;

await test("creates session with context", () => {
  testStore = new SessionStore({ enabled: true });
  testStore.setSession("session-1", "gpt-4", "COMPLEX", {
    topics: ["coding", "javascript"],
    intent: "code-review",
    complexityTrend: 0.7,
  });

  const entry = testStore.getSession("session-1");
  assert(entry !== undefined, "Should retrieve session");
  assertTrue(entry?.contextSnapshot.topics.includes("coding"), "Should have coding topic");
  assertEqual(entry?.contextSnapshot.intent, "code-review", "Intent should be code-review");
  testStore.close();
});

await test("tracks metrics on result", () => {
  testStore = new SessionStore({ enabled: true });
  testStore.setSession("session-1", "gpt-4", "COMPLEX");

  testStore.recordResult("session-1", {
    success: true,
    latencyMs: 1500,
    cost: 0.05,
    inputTokens: 100,
    outputTokens: 200,
  });

  const entry = testStore.getSession("session-1");
  assertEqual(entry?.metrics.totalInputTokens, 100, "Should track input tokens");
  assertEqual(entry?.metrics.totalOutputTokens, 200, "Should track output tokens");
  assertTrue(entry!.metrics.successRate > 0.9, "Success rate should be high");
  testStore.close();
});

await test("degrades after consecutive failures", () => {
  const config = { enabled: true, degradationThreshold: 2 };
  const customStore = new SessionStore(config);

  customStore.setSession("session-1", "gpt-4", "COMPLEX");

  // Two consecutive failures
  customStore.recordResult("session-1", {
    success: false,
    latencyMs: 100,
    cost: 0,
    inputTokens: 50,
    outputTokens: 0,
    error: "timeout",
  });

  customStore.recordResult("session-1", {
    success: false,
    latencyMs: 100,
    cost: 0,
    inputTokens: 50,
    outputTokens: 0,
    error: "timeout",
  });

  assertTrue(customStore.isDegraded("session-1"), "Session should be degraded after 2 failures");
  customStore.close();
});

await test("tracks recent errors", () => {
  testStore = new SessionStore({ enabled: true });
  testStore.setSession("session-1", "gpt-4", "COMPLEX");

  testStore.recordResult("session-1", {
    success: false,
    latencyMs: 100,
    cost: 0,
    inputTokens: 50,
    outputTokens: 0,
    error: "rate_limit",
  });

  const entry = testStore.getSession("session-1");
  assertEqual(entry?.recentErrors.length, 1, "Should track 1 error");
  assertEqual(entry?.recentErrors[0].error, "rate_limit", "Should record error type");
  testStore.close();
});

await test("limits recent errors to 5", () => {
  testStore = new SessionStore({ enabled: true });
  testStore.setSession("session-1", "gpt-4", "COMPLEX");

  for (let i = 0; i < 7; i++) {
    testStore.recordResult("session-1", {
      success: false,
      latencyMs: 100,
      cost: 0,
      inputTokens: 50,
      outputTokens: 0,
      error: `error-${i}`,
    });
  }

  const entry = testStore.getSession("session-1");
  assertEqual(entry?.recentErrors.length, 5, "Should keep only 5 recent errors");
  assertEqual(entry?.recentErrors[4].error, "error-6", "Should keep most recent error");
  testStore.close();
});

await test("updates context incrementally", () => {
  testStore = new SessionStore({ enabled: true });
  testStore.setSession("session-1", "gpt-4", "COMPLEX", {
    topics: ["coding"],
  });

  testStore.updateSessionContext("session-1", {
    topics: ["javascript"],
    intent: "debugging",
  });

  const entry = testStore.getSession("session-1");
  assertTrue(entry?.contextSnapshot.topics.includes("coding"), "Should keep original topic");
  assertTrue(entry?.contextSnapshot.topics.includes("javascript"), "Should add new topic");
  assertEqual(entry?.contextSnapshot.intent, "debugging", "Should update intent");
  testStore.close();
});

await test("provides degradation info", () => {
  const config = { enabled: true, degradationThreshold: 1 };
  const customStore = new SessionStore(config);

  customStore.setSession("session-1", "gpt-4", "COMPLEX");
  customStore.recordResult("session-1", {
    success: false,
    latencyMs: 100,
    cost: 0,
    inputTokens: 50,
    outputTokens: 0,
    error: "error",
  });

  const info = customStore.getDegradationInfo("session-1");
  assertTrue(info?.isDegraded, "Should be degraded");
  assertEqual(info?.originalModel, "gpt-4", "Should record original model");
  customStore.close();
});

await test("provides stats", () => {
  testStore = new SessionStore({ enabled: true });
  testStore.setSession("session-1", "gpt-4", "COMPLEX");
  testStore.setSession("session-2", "gpt-3.5", "SIMPLE");

  const stats = testStore.getStats();
  assertEqual(stats.count, 2, "Should count 2 sessions");
  assertEqual(stats.sessions.length, 2, "Should list 2 sessions");
  testStore.close();
});

await test("handles disabled state", () => {
  const disabledStore = new SessionStore({ enabled: false });

  disabledStore.setSession("session-1", "gpt-4", "COMPLEX");
  const entry = disabledStore.getSession("session-1");

  assert(entry === undefined, "Should not create session when disabled");
  disabledStore.close();
});

await test("cleans up expired sessions", async () => {
  const config = { enabled: true, timeoutMs: 1 };
  const shortStore = new SessionStore(config);

  shortStore.setSession("session-1", "gpt-4", "COMPLEX");

  // Wait for expiry
  await sleep(10);
  const entry = shortStore.getSession("session-1");
  assert(entry === undefined, "Session should have expired");
  shortStore.close();
});

// ==================== Summary ====================

console.log("\n" + "=".repeat(50));
console.log(`Total: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
console.log("=".repeat(50) + "\n");

process.exit(failed > 0 ? 1 : 0);
