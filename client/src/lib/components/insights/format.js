// Formatting + the one piece of arithmetic the insights UI does on its own.
//
// Everything here is presentation. The single exception is `billedWeight()`, which
// exists because the API prices a *model*, never a token class — see the comment on
// BILLING_MULTIPLIER below for why the UI needs its own answer to "where did the
// money go" and what makes that answer exact rather than a guess.

/** Thousands-separated exact count: 576324491 → "576,324,491". */
export function exactTokens(n) {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Readable count at a glance. Token totals in one session span six orders of
 * magnitude (982 input vs 576,324,491 cache-read), so the raw number is unreadable
 * and — worse — incomparable: nobody eyeballs which of two 9-digit numbers is bigger.
 * The exact value always stays reachable (title attribute + the table view).
 */
export function compactTokens(n) {
  if (!Number.isFinite(n)) return '—';
  const v = Math.abs(n);
  if (v < 1000) return String(Math.round(n));
  if (v < 1e6) return `${trim(n / 1e3)}K`;
  if (v < 1e9) return `${trim(n / 1e6)}M`;
  return `${trim(n / 1e9)}B`;
}

// One decimal below 100, none above — "9.4M" and "576M" both read in one beat,
// where "9.4M" and "576.3M" make the eye do arithmetic to compare them.
function trim(v) {
  const a = Math.abs(v);
  return a < 10 ? v.toFixed(2).replace(/\.?0+$/, '') : a < 100 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
}

/**
 * Dollars. Returns null for an unpriced figure so no call site can accidentally
 * render a missing price as "$0.00" — the two mean opposite things and the server
 * is careful to distinguish them (usd: null vs usd: 0).
 */
export function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n === 0) return '$0.00';
  const v = Math.abs(n);
  // A single cheap turn genuinely costs $0.0003; rounding it to $0.00 would make the
  // per-model table look broken rather than cheap.
  if (v < 0.01) return `$${n.toFixed(v < 0.001 ? 5 : 4)}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Percent for a share of a whole, with enough precision to survive 0.02% slivers. */
export function share(part, whole) {
  if (!whole) return 0;
  return (part / whole) * 100;
}

export function pct(v) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0%';
  if (v < 0.1) return `${v.toFixed(2)}%`;
  if (v < 10) return `${v.toFixed(1)}%`;
  return `${Math.round(v)}%`;
}

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;

/** "just now" / "14m ago" / "3h ago" / "6d ago" / a date past a week. */
export function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = now - ms;
  if (d < 0) return 'just now';
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function stamp(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** Elapsed wall-clock between the first and last priced turn. */
export function span(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return '';
  const d = toMs - fromMs;
  if (d < HOUR) return `${Math.round(d / MIN)}m`;
  if (d < DAY) return `${(d / HOUR).toFixed(1).replace(/\.0$/, '')}h`;
  return `${(d / DAY).toFixed(1).replace(/\.0$/, '')}d`;
}

/** `claude-opus-4-8` → `opus-4-8`; keeps `<synthetic>` legible. */
export function shortModel(model) {
  if (!model) return 'unknown';
  return String(model).replace(/^claude-/, '');
}

// ── billing weight ───────────────────────────────────────────────────────────
//
// THE PROBLEM THIS SOLVES. A session's token counts are dominated by cache reads
// (576M of a 589M total — 98%). A bar chart of raw counts therefore says "cache
// reads are everything", which is true about VOLUME and badly wrong about MONEY:
// cache reads bill at one tenth of the input rate, while a 1-hour cache write bills
// at DOUBLE it. Volume and cost differ by a factor of twenty across these classes.
//
// The API prices a *model*, not a token class, so it cannot answer "which class
// cost the money" and neither can a client that only knows dollars-per-model.
//
// What IS knowable without any price table: every class in the input family bills
// as a fixed multiple of the SAME per-model input rate (server/pricing.js). So
// scaling each class by its multiple gives a quantity exactly proportional to the
// dollars that class contributed — for every model, without knowing any model's
// rate. That is what `billedWeight` computes, and it is why the token-mix view can
// show cost shape honestly instead of implying volume is cost.
//
// The deliberate limit: OUTPUT tokens bill on a separate output rate whose ratio to
// the input rate is a per-model price, not a structural multiplier. Output is
// therefore excluded from the weighting and reported alongside it rather than
// silently folded in at an invented rate.
//
// Mirrors CACHE_WRITE_5M / CACHE_WRITE_1H / CACHE_READ in server/pricing.js. These
// are pricing *structure*, not prices, so they move far less often than the rate
// table — but they are still duplicated here, and the server does not currently
// publish them. See the note in /transcripts/status's `pricing` block.
export const BILLING_MULTIPLIER = {
  input: 1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
};

/** The four input-family classes, in fixed display order. Order is the color key. */
export const INPUT_CLASSES = [
  { key: 'input', label: 'Input', slot: 1 },
  { key: 'cacheWrite', label: 'Cache write', slot: 2 },
  { key: 'cacheRead', label: 'Cache read', slot: 3 },
];

/**
 * Input-rate-equivalent tokens for one usage record. Exactly proportional to the
 * input-family dollars, model-independent. Cache writes are split by TTL because a
 * 1h write costs 1.6x a 5m one.
 */
export function billedWeight(u) {
  if (!u) return 0;
  return (
    (u.input || 0) * BILLING_MULTIPLIER.input +
    (u.cacheWrite5m || 0) * BILLING_MULTIPLIER.cacheWrite5m +
    (u.cacheWrite1h || 0) * BILLING_MULTIPLIER.cacheWrite1h +
    (u.cacheRead || 0) * BILLING_MULTIPLIER.cacheRead
  );
}

/** Per-class weight, so a stacked bar can show the same classes on both scales. */
export function weightByClass(u) {
  if (!u) return { input: 0, cacheWrite: 0, cacheRead: 0 };
  return {
    input: (u.input || 0) * BILLING_MULTIPLIER.input,
    cacheWrite:
      (u.cacheWrite5m || 0) * BILLING_MULTIPLIER.cacheWrite5m +
      (u.cacheWrite1h || 0) * BILLING_MULTIPLIER.cacheWrite1h,
    cacheRead: (u.cacheRead || 0) * BILLING_MULTIPLIER.cacheRead,
  };
}

/** Raw volume per class, same keys as weightByClass so the two zip together. */
export function volumeByClass(u) {
  if (!u) return { input: 0, cacheWrite: 0, cacheRead: 0 };
  return {
    input: u.input || 0,
    cacheWrite: u.cacheWrite || (u.cacheWrite5m || 0) + (u.cacheWrite1h || 0),
    cacheRead: u.cacheRead || 0,
  };
}

/** Every token the session spent, output included — the honest headline count. */
export function totalTokens(u) {
  if (!u) return 0;
  const v = volumeByClass(u);
  return v.input + v.cacheWrite + v.cacheRead + (u.output || 0);
}

/**
 * The effective multiplier a class's TTL mix works out to, for the legend. A session
 * that only ever wrote 1h caches sees "2.0x"; a mixed one sees the blend.
 */
export function writeMultiplier(u) {
  const w5 = u?.cacheWrite5m || 0;
  const w1 = u?.cacheWrite1h || 0;
  if (!w5 && !w1) return BILLING_MULTIPLIER.cacheWrite1h;
  return (w5 * BILLING_MULTIPLIER.cacheWrite5m + w1 * BILLING_MULTIPLIER.cacheWrite1h) / (w5 + w1);
}
