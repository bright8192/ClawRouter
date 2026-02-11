/**
 * Request Fingerprint Generator
 *
 * Generates stable fingerprints for prompts to enable score caching
 * and reduce routing jitter. Uses content-based hashing that ignores
 * superficial variations (case, punctuation, spacing) while preserving
 * semantic structure.
 */

/**
 * Normalization patterns for fingerprint stability
 */
const NORMALIZATION_PATTERNS = {
  // Collapse multiple whitespace
  whitespace: /\s+/g,
  // Standardize quotes
  quotes: /[""''']/g,
  // Remove decorative punctuation but keep semantic ones
  decorativePunct: /[!！\.。,，;；:]+/g,
  // Normalize Chinese punctuation to ASCII equivalents for hashing
  chinesePunct: /[，。！？；：""''（）【】]/g,
};

/**
 * Extract structural features from text
 */
function extractFeatures(text: string): string[] {
  const features: string[] = [];
  const lower = text.toLowerCase();

  // Code indicators (preserve these as they're strong signals)
  const codePatterns = [
    /\bfunction\b|\bdef\s+\w+|\bclass\s+\w+/,
    /\{[\s\S]*?\}/, // Object blocks
    /\[[\s\S]*?\]/, // Array blocks
    /<[\s\S]*?>/, // HTML/XML tags
    /```[\s\S]*?```/, // Code fences
    /`[^`]+`/, // Inline code
  ];

  for (const pattern of codePatterns) {
    if (pattern.test(text)) {
      features.push('CODE');
      break;
    }
  }

  // Reasoning indicators
  const reasoningWords = ['step', 'prove', 'explain', 'why', 'how', '分析', '证明', '解释', '步骤'];
  for (const word of reasoningWords) {
    if (lower.includes(word)) {
      features.push('REASONING');
      break;
    }
  }

  // Multi-step indicators
  const multiStepPatterns = [
    /\d+\s*[.\)\uff0e]/, // 1. 2) 1．
    /\bstep\s+\d+/i,
    /第[一二三四五六七八九十\d]+步/,
    /步骤/,
  ];

  for (const pattern of multiStepPatterns) {
    if (pattern.test(text)) {
      features.push('MULTISTEP');
      break;
    }
  }

  // Question patterns
  const questionCount = (text.match(/\?|？/g) || []).length;
  if (questionCount > 0) {
    features.push(`Q${Math.min(questionCount, 3)}`);
  }

  // Length category (preserves complexity signal)
  const tokenEstimate = Math.ceil(text.length / 4);
  if (tokenEstimate < 50) features.push('SHORT');
  else if (tokenEstimate < 200) features.push('MEDIUM');
  else if (tokenEstimate < 1000) features.push('LONG');
  else features.push('XLONG');

  return features;
}

/**
 * Normalize text for fingerprinting
 */
function normalize(text: string): string {
  return text
    .replace(NORMALIZATION_PATTERNS.whitespace, ' ')
    .replace(NORMALIZATION_PATTERNS.quotes, '"')
    .replace(NORMALIZATION_PATTERNS.decorativePunct, ' ')
    .replace(NORMALIZATION_PATTERNS.chinesePunct, (match) => {
      const map: Record<string, string> = {
        '，': ',', '。': '.', '！': '!', '？': '?',
        '；': ';', '：': ':', '"': '"', '"': '"',
        ''': "'", ''': "'", '（': '(', '）': ')',
        '【': '[', '】': ']',
      };
      return map[match] || ' ';
    })
    .trim()
    .toLowerCase();
}

/**
 * Extract content hash from normalized text
 * Uses first 100 chars + last 50 chars for efficiency
 */
function contentHash(text: string): string {
  const normalized = normalize(text);
  if (normalized.length <= 150) {
    return normalized;
  }
  return normalized.slice(0, 100) + '...' + normalized.slice(-50);
}

/**
 * Generate a stable fingerprint for a request
 * Combines structural features with content hash
 */
export function generateFingerprint(
  prompt: string,
  systemPrompt: string | undefined,
): string {
  const features = extractFeatures(prompt);
  const content = contentHash(prompt);
  const sysHash = systemPrompt ? contentHash(systemPrompt).slice(0, 50) : 'none';

  // Feature prefix ensures structurally different prompts get different fingerprints
  // even if content happens to hash similarly
  return `${features.sort().join('|')}|${content}|${sysHash}`;
}

/**
 * Check if two fingerprints represent similar requests
 * Used for cache hit detection with tolerance
 */
export function fingerprintsSimilar(fp1: string, fp2: string): boolean {
  const [features1, content1] = fp1.split('|', 2);
  const [features2, content2] = fp2.split('|', 2);

  // Must have same structural features
  if (features1 !== features2) return false;

  // Content must be very similar (allow small differences)
  if (content1 === content2) return true;

  // Allow 10% character difference for minor edits
  const maxLen = Math.max(content1.length, content2.length);
  const minLen = Math.min(content1.length, content2.length);
  if (minLen / maxLen < 0.9) return false;

  // Count differing characters
  let diffCount = 0;
  const compareLen = Math.min(content1.length, content2.length);
  for (let i = 0; i < compareLen; i++) {
    if (content1[i] !== content2[i]) diffCount++;
  }
  diffCount += Math.abs(content1.length - content2.length);

  return diffCount / maxLen < 0.1;
}

/**
 * Calculate fingerprint for cache key (faster, less strict)
 */
export function getCacheKey(
  prompt: string,
  systemPrompt: string | undefined,
): string {
  return generateFingerprint(prompt, systemPrompt);
}
