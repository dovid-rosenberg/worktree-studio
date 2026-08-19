// Formatting for the transcript-search UI. Everything here is presentation.

/** Thousands-separated exact count: 576324491 → "576,324,491". */
export function exactTokens(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

const MIN = 60e3,
  HOUR = 3600e3,
  DAY = 86400e3;

/** "just now" / "14m ago" / "3h ago" / "6d ago" / a date past a week.
 */
export function ago(ms: number | null | undefined, now: number = Date.now()): string {
  const t = Number(ms);
  if (!Number.isFinite(t)) return '';
  const d = now - t;
  if (d < 0) return 'just now';
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function stamp(ms: number | null | undefined): string {
  const t = Number(ms);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** `claude-opus-4-8` → `opus-4-8`; keeps `<synthetic>` legible.
 */
export function shortModel(model: string | null | undefined): string {
  if (!model) return 'unknown';
  return String(model).replace(/^claude-/, '');
}
