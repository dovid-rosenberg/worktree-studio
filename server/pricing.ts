// ─────────────────────────────────────────────────────────────────────────────
// MAINTAINED ARTIFACT — THIS TABLE GOES STALE.
//
// Claude Code transcripts record token counts but NO cost, so every dollar figure
// in Worktree Studio is derived here. Anthropic ships models and changes prices
// faster than this file gets touched, so treat everything it produces as an
// ESTIMATE and re-check it against https://platform.claude.com/docs/en/pricing
// (or the `claude-api` skill) whenever the numbers start looking wrong.
//
//   Last verified: 2026-07-27
//   Prices are USD per MILLION tokens, first-party Claude API rates.
//   Bedrock / Vertex are partner-priced and are NOT modelled here.
//
// A model missing from this table is not guessed at: its tokens are still counted
// and reported, but its cost comes back null and the model name is surfaced in an
// `unpriced` list so the gap is visible rather than silently wrong.
// ─────────────────────────────────────────────────────────────────────────────

import type { Usage } from './types.ts';

const PER_MILLION = 1e6;

/** USD per million tokens for one model. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * What a cost lookup answers with. `usd` is a number exactly when `priced` is
 * true, so a caller that checks the flag never has to re-check for null.
 */
export type Cost =
  | { usd: number; priced: true }
  | { usd: null; priced: false };

// model id → { input, output } USD per million tokens.
const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// Fast mode is a different SKU on the same model — transcripts record it as
// `message.usage.speed`, so we can price it exactly instead of assuming standard.
const FAST_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 10, output: 50 },
};

// Cache tokens are billed as multiples of the model's INPUT rate. Writes carry a
// premium that depends on the TTL the write asked for; reads are the cheap path.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

// Models that never carry real cost. Claude Code emits `<synthetic>` assistant
// lines for locally-generated notices (interrupts, API errors) — they have a usage
// block full of zeros and must not be reported as an unpriced model.
const UNBILLED = new Set(['<synthetic>']);

// Transcripts sometimes carry a dated snapshot id (`claude-opus-4-5-20251101`)
// where the price table keys on the alias. Strip the date suffix before lookup.
function normalizeModel(model: string | null | undefined): string {
  const m = String(model || '').trim();
  if (!m) return '';
  return m.replace(/-\d{8}$/, '');
}

function priceFor(model: string | null | undefined, speed?: string | null): ModelPrice | null {
  const key = normalizeModel(model);
  if (!key || UNBILLED.has(key)) return null;
  if (speed === 'fast' && FAST_PRICES[key]) return FAST_PRICES[key];
  return PRICES[key] || null;
}

function isBillable(model: string | null | undefined): boolean { return !UNBILLED.has(normalizeModel(model)); }

// usage: the normalized shape from transcripts.js
// ({ input, output, cacheWrite5m, cacheWrite1h, cacheRead }).
// Returns { usd, priced }. `priced:false` means we counted the tokens but have no
// rate for this model — callers must not treat usd:0 and usd:null alike.
function costOf(
  model: string | null | undefined,
  usage: Partial<Usage> | null | undefined,
  opts: { speed?: string | null } = {},
): Cost {
  const p = priceFor(model, opts.speed || (usage && usage.speed));
  if (!p || !usage) return { usd: null, priced: false };
  const inRate = p.input / PER_MILLION;
  const outRate = p.output / PER_MILLION;
  const usd =
    (usage.input || 0) * inRate +
    (usage.output || 0) * outRate +
    (usage.cacheWrite5m || 0) * inRate * CACHE_WRITE_5M +
    (usage.cacheWrite1h || 0) * inRate * CACHE_WRITE_1H +
    (usage.cacheRead || 0) * inRate * CACHE_READ;
  return { usd, priced: true };
}

// Round to a sane number of cents-ish digits for transport. Sub-cent precision
// matters here: a single cheap turn can cost $0.0003.
function round(usd: number | null | undefined): number | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  return Math.round(usd * 1e6) / 1e6;
}

// Surfaced so the API can tell a UI how old the numbers are.
export const PRICING_VERIFIED = '2026-07-27';
export const ESTIMATE_NOTE = 'Costs are estimates derived from a maintained price table (server/pricing.js); transcripts record tokens, not billing.';

export {
  PRICES, FAST_PRICES, CACHE_WRITE_5M, CACHE_WRITE_1H, CACHE_READ,
  normalizeModel, priceFor, isBillable, costOf, round,
};
