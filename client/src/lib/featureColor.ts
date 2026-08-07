/*
 * A feature's colour tag, as CSS custom properties.
 *
 * The user assigns one per feature so that switching context has something pre-verbal to
 * land on — the point is peripheral recognition, not decoration, which is why the tag
 * appears on the rail card AND on the dock: the rail is what you scan, but the dock is
 * what you are looking at while you work, and a signal only in the rail would be invisible
 * exactly when the switch happens.
 *
 * Two variables rather than one. `--fc` is the accent — a 3px edge, a swatch — and has to
 * survive being that thin. `--fc-wash` tints a whole surface and must stay quiet enough to
 * read text on. One value could not do both jobs without being wrong for one of them.
 *
 * Returns '' for no tag or an unknown id, so every consumer's `var(--fc, <default>)`
 * fallback takes over and an untagged feature looks exactly as it did before.
 */
import { FEATURE_COLORS } from '../../../server/types';

export { FEATURE_COLORS };

/** Human labels for the swatch picker; the ids themselves are the wire values. */
export const COLOR_LABELS: Record<string, string> = {
  teal: 'Teal',
  sky: 'Sky',
  indigo: 'Indigo',
  violet: 'Violet',
  magenta: 'Magenta',
  rose: 'Rose',
  olive: 'Olive',
  sand: 'Sand',
};

const KNOWN: readonly string[] = FEATURE_COLORS;

export function isFeatureColor(color: string | undefined | null): boolean {
  return !!color && KNOWN.includes(color);
}

/** An inline `style` value binding `--fc`/`--fc-wash`, or '' when there is no tag. */
export function colorVars(color: string | undefined | null): string {
  return isFeatureColor(color) ? `--fc:var(--f-${color});--fc-wash:var(--f-${color}-wash)` : '';
}
