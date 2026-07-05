/**
 * pricing.mjs — Anthropic per-token pricing table + cost helpers for /spec
 * cost instrumentation (spec-cost.mjs).
 *
 * Ported verbatim (rates + resolution rule) from the Observatory canonical
 * source: `heathdev-observatory/src/providers/anthropic-pricing.ts` (PRs
 * #278/#279 built on it). Rates verified 2026-05-25 (Fable 2026-06-10)
 * against platform.claude.com pricing.
 *
 * Cache multipliers vs base input: cache read = 0.10x, 5m-TTL write = 1.25x,
 * 1h-TTL write = 2.00x. The 1h rate is 2x BASE INPUT, not 2.5x — a prior
 * table got this wrong; keep the correction.
 *
 * Node built-ins only (no deps in this repo).
 */

// USD per 1M tokens, per family.
export const ANTHROPIC_PRICING = {
  FABLE:  { input: 10, output: 50, cacheRead: 1.00, cacheWrite5m: 12.50, cacheWrite1h: 20.00 },
  OPUS:   { input: 5,  output: 25, cacheRead: 0.50, cacheWrite5m: 6.25,  cacheWrite1h: 10.00 },
  SONNET: { input: 3,  output: 15, cacheRead: 0.30, cacheWrite5m: 3.75,  cacheWrite1h: 6.00 },
  HAIKU:  { input: 1,  output: 5,  cacheRead: 0.10, cacheWrite5m: 1.25,  cacheWrite1h: 2.00 },
};

/**
 * Resolve a versioned model id (e.g. "claude-opus-4-7", "claude-sonnet-5")
 * to a pricing family via lowercase substring match. Returns null when the
 * family cannot be determined — callers must distinguish "unknown family"
 * from "$0 cost" (unknown != free).
 */
export function resolveAnthropicFamily(model) {
  const lower = String(model ?? '').toLowerCase();
  if (lower.includes('fable')) return 'FABLE';
  if (lower.includes('opus')) return 'OPUS';
  if (lower.includes('sonnet')) return 'SONNET';
  if (lower.includes('haiku')) return 'HAIKU';
  return null;
}

/**
 * Compute cost in USD for a single usage block. `usage` shape:
 * { inputTokens, outputTokens, cacheReadTokens?, cacheCreation5mTokens?, cacheCreation1hTokens? }
 * Returns null when the model's family cannot be resolved (caller buckets
 * these tokens as unknown-priced, never as $0). Rounded to 6 decimals.
 */
export function computeCostUsd(model, usage) {
  const family = resolveAnthropicFamily(model);
  if (family === null) return null;

  const rates = ANTHROPIC_PRICING[family];
  const PER_M = 1_000_000;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  const cacheCreation5mTokens = usage?.cacheCreation5mTokens ?? 0;
  const cacheCreation1hTokens = usage?.cacheCreation1hTokens ?? 0;

  const total =
    (inputTokens / PER_M) * rates.input +
    (outputTokens / PER_M) * rates.output +
    (cacheReadTokens / PER_M) * rates.cacheRead +
    (cacheCreation5mTokens / PER_M) * rates.cacheWrite5m +
    (cacheCreation1hTokens / PER_M) * rates.cacheWrite1h;

  return Number(total.toFixed(6));
}
