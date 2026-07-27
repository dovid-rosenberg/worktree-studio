// Theme state. The rendered theme is the `data-theme` attribute on <html> — that is
// what app.css keys off, and app.html sets it before first paint. This module is the
// only writer of that attribute; `theme.current` mirrors it so components can react.
//
// Keeping the DOM attribute (rather than a Svelte class on a wrapper) is deliberate:
// the tokens have to apply to portalled things like the modal backdrop and the
// scrollbar, and it keeps the old and new UIs byte-identical in how they theme.

const STORAGE_KEY = 'wts-theme'; // unchanged from the pre-port UI so a user's choice survives the switch

export const theme = $state({ current: /** @type {'dark'|'light'} */ ('dark') });

/** Read whatever app.html already painted so state and DOM start in agreement. */
export function initTheme() {
  if (typeof document === 'undefined') return;
  const attr = document.documentElement.getAttribute('data-theme');
  // No attribute means no saved choice, and app.css's bare :root block is dark — so
  // dark is what the user is actually looking at. The old toggleTheme() guessed from
  // prefers-color-scheme instead, which made the first click a no-op for anyone on a
  // light OS: it "toggled" from an assumed light to dark while the page was already dark.
  theme.current = attr === 'light' ? 'light' : 'dark';
}

export function toggleTheme() {
  setTheme(theme.current === 'light' ? 'dark' : 'light');
}

/** @param {'dark'|'light'} next */
export function setTheme(next) {
  theme.current = next;
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode — theme just won't persist */ }
}

// xterm can't read CSS custom properties, so the terminal palette is duplicated here as
// literals. These are the same values style.css used for --term-bg / --brand; if the
// tokens in app.css move, move these with them.
const TERM_THEMES = {
  dark: { background: '#0c0f14', foreground: '#cdd4de', cursor: '#e0733f' },
  light: { background: '#12151b', foreground: '#cdd4de', cursor: '#d05f30' },
};

/**
 * The xterm `theme` option for the current app theme. Reading `theme.current` (not the
 * DOM) is what makes this reactive — every mounted Terminal re-themes on toggle. The old
 * code re-themed only the primary terminal, leaving a split pane on the previous palette.
 */
export function termTheme() {
  return TERM_THEMES[theme.current] || TERM_THEMES.dark;
}
