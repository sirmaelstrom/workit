// pricing.test.mjs — unit tests for the Anthropic pricing table + cost helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTHROPIC_PRICING, resolveAnthropicFamily, computeCostUsd,
} from '../scripts/pricing.mjs';

// ---------------------------------------------------------------------------
// resolveAnthropicFamily
// ---------------------------------------------------------------------------

test('resolveAnthropicFamily resolves versioned opus ids', () => {
  assert.equal(resolveAnthropicFamily('claude-opus-4-8'), 'OPUS');
  assert.equal(resolveAnthropicFamily('claude-opus-4-1-20250805'), 'OPUS');
});

test('resolveAnthropicFamily resolves versioned fable ids', () => {
  assert.equal(resolveAnthropicFamily('claude-fable-5'), 'FABLE');
});

test('resolveAnthropicFamily resolves versioned sonnet ids', () => {
  assert.equal(resolveAnthropicFamily('claude-sonnet-5'), 'SONNET');
  assert.equal(resolveAnthropicFamily('claude-3-7-sonnet-20250219'), 'SONNET');
});

test('resolveAnthropicFamily resolves versioned haiku ids', () => {
  assert.equal(resolveAnthropicFamily('claude-haiku-4-5-20251001'), 'HAIKU');
});

test('resolveAnthropicFamily is case-insensitive', () => {
  assert.equal(resolveAnthropicFamily('Claude-OPUS-4-8'), 'OPUS');
});

test('resolveAnthropicFamily returns null for unknown model families', () => {
  assert.equal(resolveAnthropicFamily('gpt-5.5'), null);
  assert.equal(resolveAnthropicFamily('gemini-2.5-pro'), null);
  assert.equal(resolveAnthropicFamily(''), null);
});

// ---------------------------------------------------------------------------
// computeCostUsd — exact math
// ---------------------------------------------------------------------------

test('computeCostUsd computes exact cost for a known SONNET usage block', () => {
  // 1M input @ $3, 1M output @ $15, 1M cache-read @ $0.30 (0.10x), 1M 5m-write @ $3.75 (1.25x), 1M 1h-write @ $6.00 (2x)
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheCreation5mTokens: 1_000_000,
    cacheCreation1hTokens: 1_000_000,
  };
  const cost = computeCostUsd('claude-sonnet-5', usage);
  assert.equal(cost, 3 + 15 + 0.30 + 3.75 + 6.00);
});

test('computeCostUsd computes exact cost for a known OPUS usage block (smaller numbers)', () => {
  const usage = { inputTokens: 7814, outputTokens: 1, cacheReadTokens: 10068, cacheCreation5mTokens: 15192 };
  const cost = computeCostUsd('claude-opus-4-8', usage);
  const expected = (7814 / 1e6) * 5 + (1 / 1e6) * 25 + (10068 / 1e6) * 0.5 + (15192 / 1e6) * 6.25;
  assert.equal(cost, Number(expected.toFixed(6)));
});

test('computeCostUsd treats the 1h cache-write rate as 2x base input, not 2.5x', () => {
  assert.equal(ANTHROPIC_PRICING.SONNET.cacheWrite1h, 6.00); // 2x of $3, not 2.5x
  assert.equal(ANTHROPIC_PRICING.OPUS.cacheWrite1h, 10.00); // 2x of $5
  assert.equal(ANTHROPIC_PRICING.HAIKU.cacheWrite1h, 2.00); // 2x of $1
  assert.equal(ANTHROPIC_PRICING.FABLE.cacheWrite1h, 20.00); // 2x of $10
});

test('computeCostUsd returns null for unresolvable model families (never $0)', () => {
  assert.equal(computeCostUsd('gpt-5.5', { inputTokens: 1000, outputTokens: 1000 }), null);
});

test('computeCostUsd defaults missing usage fields to zero', () => {
  const cost = computeCostUsd('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(cost, 1); // 1M input @ $1/1M, nothing else
});

// ---------------------------------------------------------------------------
// Cache-split fallback: an aggregate cache-creation total billed at the 5m
// rate (the convention spec-cost.mjs uses when the raw usage block lacks
// the ephemeral_5m/1h split) must be priced identically to an explicit
// cacheCreation5mTokens value — no special-casing, no silent 1h upcharge.
// ---------------------------------------------------------------------------

test('computeCostUsd bills an aggregate (unsplit) cache-creation total at the 5m rate', () => {
  const aggregateTokens = 20000;
  const usage = { inputTokens: 0, outputTokens: 0, cacheCreation5mTokens: aggregateTokens };
  const cost = computeCostUsd('claude-sonnet-5', usage);
  const expected = Number(((aggregateTokens / 1e6) * ANTHROPIC_PRICING.SONNET.cacheWrite5m).toFixed(6));
  assert.equal(cost, expected);
  // and it must NOT equal what the (more expensive) 1h rate would produce
  const wrongAt1h = Number(((aggregateTokens / 1e6) * ANTHROPIC_PRICING.SONNET.cacheWrite1h).toFixed(6));
  assert.notEqual(cost, wrongAt1h);
});

// ---------------------------------------------------------------------------
// 6-decimal rounding
// ---------------------------------------------------------------------------

test('computeCostUsd rounds to 6 decimal places', () => {
  // Craft a token count that produces a long floating-point tail.
  const usage = { inputTokens: 1, outputTokens: 1 };
  const cost = computeCostUsd('claude-haiku-4-5', usage);
  const str = String(cost);
  const decimals = str.includes('.') ? str.split('.')[1].length : 0;
  assert.ok(decimals <= 6, `expected <=6 decimal places, got ${str}`);
});

test('computeCostUsd rounding matches Number(x.toFixed(6)) exactly for a fractional case', () => {
  const usage = { inputTokens: 123456, outputTokens: 78901, cacheReadTokens: 4321 };
  const cost = computeCostUsd('claude-opus-4-8', usage);
  const raw = (123456 / 1e6) * 5 + (78901 / 1e6) * 25 + (4321 / 1e6) * 0.5;
  assert.equal(cost, Number(raw.toFixed(6)));
});
