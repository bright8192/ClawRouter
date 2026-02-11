/**
 * Rule-Based Classifier (v2 — Weighted Scoring with Hysteresis)
 *
 * Scores a request across 14 weighted dimensions and maps the aggregate
 * score to a tier using configurable boundaries with hysteresis to prevent
 * jitter. Confidence is calibrated via sigmoid — low confidence triggers
 * the fallback classifier.
 *
 * Features:
 * - Hysteresis boundaries to prevent tier oscillation
 * - Fuzzy boundary regions for stability
 * - Score history tracking for consistent decisions
 *
 * Handles 70-80% of requests in < 1ms with zero cost.
 */

import type { Tier, ScoringResult, ScoringConfig } from "./types.js";

// ─── Hysteresis State ───
// Track last decisions to enable hysteresis (stateful tier transitions)

type ScoreHistory = {
  lastScore: number;
  lastTier: Tier | null;
  consecutiveSameTier: number;
  lastBoundary: string;
};

const scoreHistory: Map<string, ScoreHistory> = new Map();
const HISTORY_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get or create score history for a request fingerprint
 */
function getScoreHistory(fingerprint: string): ScoreHistory {
  return (
    scoreHistory.get(fingerprint) ?? {
      lastScore: 0,
      lastTier: null,
      consecutiveSameTier: 0,
      lastBoundary: "",
    }
  );
}

/**
 * Update score history after decision
 */
function updateScoreHistory(
  fingerprint: string,
  score: number,
  tier: Tier | null,
  boundary: string,
): void {
  const existing = scoreHistory.get(fingerprint);
  const consecutive = existing?.lastTier === tier ? (existing?.consecutiveSameTier ?? 0) + 1 : 1;

  scoreHistory.set(fingerprint, {
    lastScore: score,
    lastTier: tier,
    consecutiveSameTier: consecutive,
    lastBoundary: boundary,
  });

  // Cleanup old entries periodically
  if (Math.random() < 0.01) {
    // 1% chance per call
    cleanupScoreHistory();
  }
}

/**
 * Remove expired history entries
 */
function cleanupScoreHistory(): void {
  const now = Date.now();
  // Note: We don't have timestamps in ScoreHistory, rely on LRU in practice
  // or implement proper TTL if needed
  if (scoreHistory.size > 1000) {
    // Simple eviction when too large
    const entriesToDelete = Array.from(scoreHistory.keys()).slice(0, scoreHistory.size - 1000);
    for (const key of entriesToDelete) {
      scoreHistory.delete(key);
    }
  }
}

type DimensionScore = { name: string; score: number; signal: string | null };

// ─── Dimension Scorers ───
// Each returns a score in [-1, 1] and an optional signal string.

function scoreTokenCount(
  estimatedTokens: number,
  thresholds: { simple: number; complex: number },
): DimensionScore {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1.0, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1.0, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}

function scoreKeywordMatch(
  text: string,
  keywords: string[],
  name: string,
  signalLabel: string,
  thresholds: { low: number; high: number },
  scores: { none: number; low: number; high: number },
): DimensionScore {
  const matches = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return {
      name,
      score: scores.high,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`,
    };
  }
  if (matches.length >= thresholds.low) {
    return {
      name,
      score: scores.low,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`,
    };
  }
  return { name, score: scores.none, signal: null };
}

/**
 * Multi-step pattern detection (English + Chinese).
 * Conservative patterns to avoid false positives.
 */
const MULTI_STEP_PATTERNS: RegExp[] = [
  // English
  /first.*then/i,
  /step\s+\d+/i,
  /\d+[\.．]\s+/, // 1. 2. 1．2．
  // Chinese: 第一步、第二步、第1步
  /第[一二三四五六七八九十\d]+步/,
  // Chinese: 步骤1、步骤一、步骤 1
  /步骤\s*[一二三四五六七八九十\d]+/,
  // Chinese: 首先...然后（限制中间长度≤80 避免跨段匹配）
  /首先[\s\S]{1,80}然后/,
  // Chinese: 第一、第二、第一，第二，
  /第[一二三四五六七八九十\d]+[、,]\s*第[一二三四五六七八九十\d]+/,
];

function scoreMultiStep(text: string): DimensionScore {
  const hits = MULTI_STEP_PATTERNS.filter((p) => p.test(text));
  if (hits.length > 0) {
    return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" };
  }
  return { name: "multiStepPatterns", score: 0, signal: null };
}

/**
 * Question complexity: count explicit question marks + Chinese multi-question phrases.
 * - 半角 ? + 全角 ？
 * - 无语符中文：2+ 个（怎么|如何|怎样）视为多问句
 */
const CHINESE_QUESTION_PHRASE = /怎么|如何|怎样/g;

function scoreQuestionComplexity(prompt: string): DimensionScore {
  const halfWidth = (prompt.match(/\?/g) || []).length;
  const fullWidth = (prompt.match(/？/g) || []).length;
  const questionCount = halfWidth + fullWidth;

  if (questionCount > 3) {
    return { name: "questionComplexity", score: 0.5, signal: `${questionCount} questions` };
  }

  // 中文无语符多问：如「怎么X，又怎么Y」「如何A？如何B？」已由 ?/？ 覆盖；
  // 仅当无显式问号且出现 2+ 次（怎么|如何|怎样）时补充计为多问
  if (questionCount === 0) {
    const phraseMatches = prompt.match(CHINESE_QUESTION_PHRASE) || [];
    if (phraseMatches.length >= 2) {
      return {
        name: "questionComplexity",
        score: 0.5,
        signal: `multi-question (${phraseMatches.length} 怎么/如何/怎样)`,
      };
    }
  }

  return { name: "questionComplexity", score: 0, signal: null };
}

/**
 * Score agentic task indicators.
 * Returns agenticScore (0-1) based on keyword matches:
 * - 4+ matches = 1.0 (high agentic)
 * - 3 matches = 0.6 (moderate agentic, triggers auto-agentic mode)
 * - 1-2 matches = 0.2 (low agentic)
 *
 * Thresholds raised because common keywords were pruned from the list.
 */
function scoreAgenticTask(
  text: string,
  keywords: string[],
): { dimensionScore: DimensionScore; agenticScore: number } {
  let matchCount = 0;
  const signals: string[] = [];

  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      matchCount++;
      if (signals.length < 3) {
        signals.push(keyword);
      }
    }
  }

  // Threshold-based scoring (raised thresholds after keyword pruning)
  if (matchCount >= 4) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 1.0,
        signal: `agentic (${signals.join(", ")})`,
      },
      agenticScore: 1.0,
    };
  } else if (matchCount >= 3) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.6,
        signal: `agentic (${signals.join(", ")})`,
      },
      agenticScore: 0.6,
    };
  } else if (matchCount >= 1) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.2,
        signal: `agentic-light (${signals.join(", ")})`,
      },
      agenticScore: 0.2,
    };
  }

  return {
    dimensionScore: { name: "agenticTask", score: 0, signal: null },
    agenticScore: 0,
  };
}

// ─── Fuzzy Boundaries with Hysteresis ───

/**
 * Calculate tier using hysteresis to prevent oscillation.
 *
 * Standard boundaries: simpleMedium, mediumComplex, complexReasoning
 * With hysteresis:
 *   - Moving up (score increasing): use higher boundary
 *   - Moving down (score decreasing): use lower boundary
 *   - Fuzzy region (±0.05): stick with current tier
 */
function calculateTierWithHysteresis(
  score: number,
  boundaries: { simpleMedium: number; mediumComplex: number; complexReasoning: number },
  history: ScoreHistory,
  fuzzyWidth: number = 0.05,
): { tier: Tier | null; distance: number; boundary: string; usedHysteresis: boolean } {
  const { simpleMedium, mediumComplex, complexReasoning } = boundaries;

  // Define all boundaries with their fuzzy regions
  const tiers = [
    { name: "SIMPLE" as Tier, upper: simpleMedium },
    { name: "MEDIUM" as Tier, upper: mediumComplex },
    { name: "COMPLEX" as Tier, upper: complexReasoning },
    { name: "REASONING" as Tier, upper: Infinity },
  ];

  // Find current tier without hysteresis
  let currentTier: Tier | null = null;
  let currentDistance = 0;
  let nearestBoundary = "";

  if (score < simpleMedium) {
    currentTier = "SIMPLE";
    currentDistance = simpleMedium - score;
    nearestBoundary = "simple-medium";
  } else if (score < mediumComplex) {
    currentTier = "MEDIUM";
    currentDistance = Math.min(score - simpleMedium, mediumComplex - score);
    nearestBoundary =
      score < (simpleMedium + mediumComplex) / 2 ? "simple-medium" : "medium-complex";
  } else if (score < complexReasoning) {
    currentTier = "COMPLEX";
    currentDistance = Math.min(score - mediumComplex, complexReasoning - score);
    nearestBoundary =
      score < (mediumComplex + complexReasoning) / 2 ? "medium-complex" : "complex-reasoning";
  } else {
    currentTier = "REASONING";
    currentDistance = score - complexReasoning;
    nearestBoundary = "complex-reasoning";
  }

  // Apply hysteresis if we have history
  if (history.lastTier !== null && currentTier !== history.lastTier) {
    const tierIndex = tiers.findIndex((t) => t.name === currentTier);
    const lastTierIndex = tiers.findIndex((t) => t.name === history.lastTier);

    // Check if in fuzzy boundary region
    const isInFuzzyRegion = currentDistance < fuzzyWidth;

    if (isInFuzzyRegion) {
      // In fuzzy region: stick with previous tier for stability
      return {
        tier: history.lastTier,
        distance: 0.05, // Minimum distance for confidence
        boundary: nearestBoundary,
        usedHysteresis: true,
      };
    }

    // Direction matters for hysteresis
    const movingUp = tierIndex > lastTierIndex;

    if (movingUp) {
      // Moving to higher tier: need to exceed boundary + fuzzy margin
      const requiredDistance = fuzzyWidth;
      if (currentDistance < requiredDistance) {
        return {
          tier: history.lastTier,
          distance: currentDistance,
          boundary: nearestBoundary,
          usedHysteresis: true,
        };
      }
    } else {
      // Moving to lower tier: need to be below boundary - fuzzy margin
      const requiredDistance = fuzzyWidth;
      if (currentDistance < requiredDistance) {
        return {
          tier: history.lastTier,
          distance: currentDistance,
          boundary: nearestBoundary,
          usedHysteresis: true,
        };
      }
    }
  }

  return {
    tier: currentTier,
    distance: currentDistance,
    boundary: nearestBoundary,
    usedHysteresis: false,
  };
}

// ─── Main Classifier ───

export function classifyByRules(
  prompt: string,
  systemPrompt: string | undefined,
  estimatedTokens: number,
  config: ScoringConfig,
  fingerprint?: string, // Optional fingerprint for history tracking
): ScoringResult {
  const text = `${systemPrompt ?? ""} ${prompt}`.toLowerCase();
  // User prompt only — used for reasoning markers (system prompt shouldn't influence complexity)
  const userText = prompt.toLowerCase();

  // Score all 14 dimensions
  const dimensions: DimensionScore[] = [
    // Original 8 dimensions
    scoreTokenCount(estimatedTokens, config.tokenCountThresholds),
    scoreKeywordMatch(
      text,
      config.codeKeywords,
      "codePresence",
      "code",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 1.0 },
    ),
    // Reasoning markers use USER prompt only — system prompt "step by step" shouldn't trigger reasoning
    scoreKeywordMatch(
      userText,
      config.reasoningKeywords,
      "reasoningMarkers",
      "reasoning",
      { low: 1, high: 2 },
      { none: 0, low: 0.7, high: 1.0 },
    ),
    scoreKeywordMatch(
      text,
      config.technicalKeywords,
      "technicalTerms",
      "technical",
      { low: 2, high: 4 },
      { none: 0, low: 0.5, high: 1.0 },
    ),
    scoreKeywordMatch(
      text,
      config.creativeKeywords,
      "creativeMarkers",
      "creative",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.7 },
    ),
    scoreKeywordMatch(
      text,
      config.simpleKeywords,
      "simpleIndicators",
      "simple",
      { low: 1, high: 2 },
      { none: 0, low: -1.0, high: -1.0 },
    ),
    scoreMultiStep(text),
    scoreQuestionComplexity(prompt),

    // 6 new dimensions
    scoreKeywordMatch(
      text,
      config.imperativeVerbs,
      "imperativeVerbs",
      "imperative",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 },
    ),
    scoreKeywordMatch(
      text,
      config.constraintIndicators,
      "constraintCount",
      "constraints",
      { low: 1, high: 3 },
      { none: 0, low: 0.3, high: 0.7 },
    ),
    scoreKeywordMatch(
      text,
      config.outputFormatKeywords,
      "outputFormat",
      "format",
      { low: 1, high: 2 },
      { none: 0, low: 0.4, high: 0.7 },
    ),
    scoreKeywordMatch(
      text,
      config.referenceKeywords,
      "referenceComplexity",
      "references",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 },
    ),
    scoreKeywordMatch(
      text,
      config.negationKeywords,
      "negationComplexity",
      "negation",
      { low: 2, high: 3 },
      { none: 0, low: 0.3, high: 0.5 },
    ),
    scoreKeywordMatch(
      text,
      config.domainSpecificKeywords,
      "domainSpecificity",
      "domain-specific",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.8 },
    ),
  ];

  // Score agentic task indicators
  const agenticResult = scoreAgenticTask(text, config.agenticTaskKeywords);
  dimensions.push(agenticResult.dimensionScore);
  const agenticScore = agenticResult.agenticScore;

  // Collect signals
  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal!);

  // Compute weighted score
  const weights = config.dimensionWeights;
  let weightedScore = 0;
  for (const d of dimensions) {
    const w = weights[d.name] ?? 0;
    weightedScore += d.score * w;
  }

  // Count reasoning markers for override — only check USER prompt, not system prompt
  // This prevents system prompts with "step by step" from triggering REASONING for simple queries
  const reasoningMatches = config.reasoningKeywords.filter((kw) =>
    userText.includes(kw.toLowerCase()),
  );

  // Direct reasoning override: 2+ reasoning markers = high confidence REASONING
  if (reasoningMatches.length >= 2) {
    const confidence = calibrateConfidence(
      Math.max(weightedScore, 0.3), // ensure positive for confidence calc
      config.confidenceSteepness,
    );

    // Update history if fingerprint provided
    if (fingerprint) {
      updateScoreHistory(fingerprint, weightedScore, "REASONING", "reasoning-override");
    }

    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence, 0.85),
      signals: [...signals, "reasoning-override"],
      agenticScore,
    };
  }

  // Calculate tier using hysteresis to prevent oscillation
  const history = fingerprint
    ? getScoreHistory(fingerprint)
    : { lastTier: null, lastScore: 0, consecutiveSameTier: 0, lastBoundary: "" };
  const {
    tier,
    distance: distanceFromBoundary,
    boundary,
    usedHysteresis,
  } = calculateTierWithHysteresis(
    weightedScore,
    config.tierBoundaries,
    history,
    0.05, // fuzzy width
  );

  // Add hysteresis signal if applied
  if (usedHysteresis) {
    signals.push(`hysteresis (${history.lastTier} → stable)`);
  }

  // Calibrate confidence via sigmoid of distance from nearest boundary
  const confidence = calibrateConfidence(distanceFromBoundary, config.confidenceSteepness);

  // Update history
  if (fingerprint) {
    updateScoreHistory(fingerprint, weightedScore, tier, boundary);
  }

  // If confidence is below threshold → ambiguous
  if (confidence < config.confidenceThreshold) {
    return { score: weightedScore, tier: null, confidence, signals, agenticScore };
  }

  return { score: weightedScore, tier, confidence, signals, agenticScore };
}

/**
 * Sigmoid confidence calibration.
 * Maps distance from tier boundary to [0.5, 1.0] confidence range.
 */
function calibrateConfidence(distance: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * distance));
}
