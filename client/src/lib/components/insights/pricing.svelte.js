// The cache-billing multipliers, as the server reports them.
//
// ── why this is a store and not a constant ───────────────────────────────────
// These four numbers used to be written down twice: server/pricing.js
// (CACHE_WRITE_5M / CACHE_WRITE_1H / CACHE_READ, which every dollar figure is
// derived from) and a hardcoded copy here in the client. The server exported them
// but published them nowhere, so the client had no way to ask.
//
// The failure that made this worth fixing is silent. Change a multiplier server-side
// and the API's dollar figures move immediately, while the client's "billed weight"
// chart — the one that answers "which token class cost the money" — keeps the OLD
// ratios. The same screen then gives two different answers to the same question, with
// nothing on it to suggest either is wrong.
//
// So: `/api/v1/transcripts/status` (and every response carrying a `pricing` block)
// now ships `pricing.cacheMultipliers`, and `adoptPricing()` below installs them.
// server/pricing.js is the single source; this is a cache of its answer.

/**
 * Multiples of the model's INPUT rate that each input-family token class bills at.
 * Live state: adopting a server payload re-runs every chart derived from it.
 *
 * The initial values are a BOOTSTRAP, not a second source of truth — they are what
 * the server shipped when this file was written, and they exist only so a chart that
 * renders before the first response has something coherent to draw. The first payload
 * with a `pricing` block replaces them.
 * @type {{ input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number }}
 */
export const billingMultipliers = $state({
  input: 1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
});

/**
 * Install the multipliers from any response that carries a `pricing` block
 * (/transcripts/status, /transcripts/usage, /sessions/:id/transcript/usage).
 * Ignores a payload without them, so an older daemon degrades to the bootstrap
 * values rather than to zeros.
 * @param {{ cacheMultipliers?: Record<string, unknown> }|null|undefined} pricing
 */
export function adoptPricing(pricing) {
  const m = pricing && pricing.cacheMultipliers;
  if (!m || typeof m !== 'object') return;
  for (const key of /** @type {(keyof typeof billingMultipliers)[]} */ (Object.keys(billingMultipliers))) {
    const v = Number(m[key]);
    // A missing or non-numeric member keeps its current value: a partial block must
    // not zero out a multiplier and quietly erase a whole class from the chart.
    if (Number.isFinite(v)) billingMultipliers[key] = v;
  }
}
