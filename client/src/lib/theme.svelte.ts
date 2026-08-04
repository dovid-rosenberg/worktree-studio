// Theme state. The rendered theme is the `data-theme` attribute on <html> — that is
// what app.css keys off, and app.html sets it before first paint. This module is the
// only writer of that attribute; `theme.current` mirrors it so components can react.
//
// Keeping the DOM attribute (rather than a Svelte class on a wrapper) is deliberate:
// the tokens have to apply to portalled things like the modal backdrop and the
// scrollbar, and it keeps the old and new UIs byte-identical in how they theme.

const STORAGE_KEY = 'wts-theme'; // unchanged from the pre-port UI so a user's choice survives the switch

export type ThemeName = 'dark' | 'light';

export interface TermPalette {
  background: string;
  foreground: string;
  cursor: string;
}

export const theme = $state<{ current: ThemeName }>({ current: 'dark' });

/** Read whatever app.html already painted so state and DOM start in agreement. */
export function initTheme(): void {
  if (typeof document === 'undefined') return;
  const attr = document.documentElement.getAttribute('data-theme');
  // No attribute means no saved choice, and app.css's bare :root block is dark — so
  // dark is what the user is actually looking at. The old toggleTheme() guessed from
  // prefers-color-scheme instead, which made the first click a no-op for anyone on a
  // light OS: it "toggled" from an assumed light to dark while the page was already dark.
  theme.current = attr === 'light' ? 'light' : 'dark';
}

export function toggleTheme(): void {
  setTheme(theme.current === 'light' ? 'dark' : 'light');
}

export function setTheme(next: ThemeName): void {
  theme.current = next;
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode — theme just won't persist */ }
}

/*
 * Last-resort palette, used only when there is no DOM to read tokens from (SSR, or a test
 * that renders a Terminal without app.css). Everything else reads app.css — see below.
 */
const FALLBACK: Record<ThemeName, TermPalette> = {
  dark: { background: '#0c0f14', foreground: '#cdd4de', cursor: '#e0733f' },
  light: { background: '#fdfcfa', foreground: '#181c24', cursor: '#c1521f' },
};

/**
 * The xterm `theme` option for the current app theme.
 *
 * xterm cannot read CSS custom properties, so this used to be a hardcoded COPY of the
 * `--term-bg` / `--term-fg` / `--term-cursor` tokens, with a comment asking whoever moved
 * the tokens to move these too. That is a promise, not a mechanism, and it was broken the
 * first time the light palette was retuned: the tokens said `#fdfcfa` while xterm was
 * still painting `#fbfaf7`. So it reads the tokens instead, and the two cannot disagree.
 *
 * Reading `theme.current` is what makes this REACTIVE — every mounted Terminal re-themes
 * on toggle. The DOM read has to happen after `setTheme` has stamped `data-theme`, which
 * it does synchronously before this is ever recomputed.
 */
export function termTheme(): TermPalette {
  const fallback = FALLBACK[theme.current] || FALLBACK.dark;
  if (typeof document === 'undefined') return fallback;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, or: string): string => cs.getPropertyValue(name).trim() || or;
  return {
    background: read('--term-bg', fallback.background),
    foreground: read('--term-fg', fallback.foreground),
    // --term-cursor is `var(--brand)` in app.css, and getPropertyValue resolves it.
    cursor: read('--term-cursor', fallback.cursor),
  };
}
