/**
 * Default Routing Config
 *
 * All routing parameters as a TypeScript constant.
 * Operators override via openclaw.yaml plugin config.
 */

import type { RoutingConfig } from "./types.js";

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  version: "1.0",

  classifier: {
    ambiguousZone: [1, 2],
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 3_600_000, // 1 hour
  },

  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },
    codeKeywords: [
      "function", "class", "import", "def", "SELECT", "async", "await",
      "const", "let", "var", "return", "```",
    ],
    reasoningKeywords: [
      "prove", "theorem", "derive", "step by step", "chain of thought",
      "formally", "mathematical", "proof", "logically",
    ],
    simpleKeywords: [
      "what is", "define", "translate", "hello", "yes or no",
      "capital of", "how old", "who is", "when was",
    ],
    technicalKeywords: [
      "algorithm", "optimize", "architecture", "distributed",
      "kubernetes", "microservice", "database", "infrastructure",
    ],
    creativeKeywords: [
      "story", "poem", "compose", "brainstorm", "creative",
      "imagine", "write a",
    ],
  },

  tiers: {
    SIMPLE: {
      primary: "google/gemini-2.5-flash",
      fallback: ["deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    },
    MEDIUM: {
      primary: "deepseek/deepseek-chat",
      fallback: ["google/gemini-2.5-flash", "openai/gpt-4o-mini"],
    },
    COMPLEX: {
      primary: "anthropic/claude-sonnet-4",
      fallback: ["openai/gpt-4o", "google/gemini-2.5-pro"],
    },
    REASONING: {
      primary: "openai/o3",
      fallback: ["google/gemini-2.5-pro", "anthropic/claude-sonnet-4"],
    },
  },

  overrides: {
    maxTokensForceComplex: 100_000,
    structuredOutputMinTier: "MEDIUM",
  },
};
