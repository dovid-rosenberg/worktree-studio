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
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/*
 * THE 16 ANSI COLOURS, per theme.
 *
 * Setting only background/foreground/cursor left xterm on its BUILT-IN palette, which is
 * tuned for a dark ground: its yellow (#cdcd00) and bright green (#00ff00) measure 1.66:1
 * and 1.34:1 against a near-white background, so in light mode anything the agent printed
 * in colour was effectively invisible. A terminal theme is not two colours.
 *
 * Unlike --term-bg / --term-fg / --term-cursor these are NOT CSS tokens: nothing in the
 * app chrome uses them, only xterm does. A token would be a value with exactly one
 * consumer, declared where that consumer cannot see it. So they live here, in the module
 * that owns terminal theming, and the three shared with the chrome keep coming from
 * app.css.
 *
 * Every light value is >= 4.5:1 against --term-bg (#fdfcfa); the dark set is xterm's
 * defaults warmed to match the app palette.
 *
 * LIMIT, worth knowing: this governs colours 0-15 only. An app that emits 256-colour
 * (`38;5;N`) or truecolor picks its own, and Claude Code's TUI does — so its palette
 * follows ITS theme, not this one. See `/theme` inside a session.
 */
const ANSI: Record<ThemeName, Omit<TermPalette, 'background' | 'foreground' | 'cursor'>> = {
  dark: {
    selectionBackground: '#2c3a4d',
    black: '#3b4252',
    red: '#ef6b73',
    green: '#71c383',
    yellow: '#e0b464',
    blue: '#6fa8f5',
    magenta: '#b48ded',
    cyan: '#5fc9d6',
    white: '#c7cedb',
    brightBlack: '#5d6673',
    brightRed: '#ff8b91',
    brightGreen: '#8fdc9f',
    brightYellow: '#f2ca7e',
    brightBlue: '#8fc0ff',
    brightMagenta: '#cba9f7',
    brightCyan: '#84dfe9',
    brightWhite: '#f0f4fa',
  },
  light: {
    selectionBackground: '#cfe0f5',
    // Deliberately dark: on a light ground the "normal" set has to carry the text, so
    // each is a saturated dark tone rather than a mid one.
    black: '#1b1f27',
    red: '#bf1d29',
    green: '#12703a',
    yellow: '#7a4c00',
    blue: '#0a4fae',
    magenta: '#7126c4',
    cyan: '#0f6b73',
    white: '#6b7280',
    // "Bright" cannot mean lighter here or it would vanish; it means MORE saturated.
    brightBlack: '#4d5563',
    brightRed: '#d92534',
    brightGreen: '#16853f',
    brightYellow: '#8f5b00',
    brightBlue: '#1263cc',
    brightMagenta: '#8a34e0',
    brightCyan: '#12808a',
    brightWhite: '#1b1f27',
  },
};

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
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode — theme just won't persist */
  }
}

/*
 * Last-resort palette, used only when there is no DOM to read tokens from (SSR, or a test
 * that renders a Terminal without app.css). Everything else reads app.css — see below.
 */
const FALLBACK: Record<ThemeName, Pick<TermPalette, 'background' | 'foreground' | 'cursor'>> = {
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
  const ansi = ANSI[theme.current] || ANSI.dark;
  if (typeof document === 'undefined') return { ...ansi, ...fallback };
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, or: string): string => cs.getPropertyValue(name).trim() || or;
  return {
    ...ansi,
    background: read('--term-bg', fallback.background),
    foreground: read('--term-fg', fallback.foreground),
    // --term-cursor is `var(--brand)` in app.css, and getPropertyValue resolves it.
    cursor: read('--term-cursor', fallback.cursor),
  };
}
