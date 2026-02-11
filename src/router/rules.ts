/**
 * Rule-Based Classifier (v2 — Weighted Scoring)
 *
 * Scores a request across 14 weighted dimensions and maps the aggregate
 * score to a tier using configurable boundaries. Confidence is calibrated
 * via sigmoid — low confidence triggers the fallback classifier.
 *
 * Handles 70-80% of requests in < 1ms with zero cost.
 */

import type { Tier, ScoringResult, ScoringConfig } from "./types.js";

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

// ─── Main Classifier ───

export function classifyByRules(
  prompt: string,
  systemPrompt: string | undefined,
  estimatedTokens: number,
  config: ScoringConfig,
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
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence, 0.85),
      signals,
      agenticScore,
    };
  }

  // Map weighted score to tier using boundaries
  const { simpleMedium, mediumComplex, complexReasoning } = config.tierBoundaries;
  let tier: Tier;
  let distanceFromBoundary: number;

  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(weightedScore - simpleMedium, mediumComplex - weightedScore);
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(
      weightedScore - mediumComplex,
      complexReasoning - weightedScore,
    );
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }

  // Calibrate confidence via sigmoid of distance from nearest boundary
  const confidence = calibrateConfidence(distanceFromBoundary, config.confidenceSteepness);

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
