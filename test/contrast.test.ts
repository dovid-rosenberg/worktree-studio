/*
 * The palette, measured rather than eyeballed.
 *
 * The light theme was retuned once without re-measuring, and the result shipped: the
 * waiting pill — the ONE label the whole rail is optimised to make findable — was the
 * least legible text on the card at 3.16:1. Separately, `--muted` and `--faint` were the
 * same colour in dark mode (1.08:1), collapsing a deliberate three-tier readout to two.
 *
 * Neither is catchable by eye, and neither is catchable by any other test. So the numbers
 * are asserted here, parsed out of app.css itself so the test cannot drift from the file
 * it is about.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';

const css = fs.readFileSync(new URL('../client/src/app.css', import.meta.url), 'utf8');

/** The two theme blocks, as the browser resolves them. */
function tokens(theme: 'dark' | 'light'): Record<string, string> {
  // Dark is the bare `:root`; light is the `[data-theme="light"]` block. Slicing on the
  // light marker is what keeps a later block from overwriting the earlier one's values.
  const cut = css.indexOf('[data-theme="light"]');
  const block = theme === 'dark' ? css.slice(0, cut) : css.slice(cut);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    if (!(m[1] in out)) out[m[1]] = m[2].toLowerCase();
  }
  return out;
}

function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = v.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const AA = 4.5;

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: every status pill meets WCAG AA against its own wash`, () => {
    const t = tokens(theme);
    // Each pill is `color:var(--x); background:var(--x-bg)` — the pairing is the contract.
    for (const state of ['working', 'waiting', 'done']) {
      const fg = t[`--${state}`];
      const bg = t[`--${state}-bg`];
      assert.ok(fg && bg, `${theme} is missing --${state} / --${state}-bg`);
      const r = contrast(fg, bg);
      assert.ok(r >= AA, `${theme} .pill.${state}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${AA}`);
    }
  });

  test(`${theme}: the muted and faint tiers are actually distinguishable`, () => {
    // Components render a three-level readout — --ink, --muted, --faint. In dark mode
    // these two were 1.08:1 apart, so the rail card rendered as two levels, not three.
    const t = tokens(theme);
    const r = contrast(t['--muted'], t['--faint']);
    assert.ok(r >= 1.35, `${theme}: --muted vs --faint is ${r.toFixed(2)}:1 — one colour, not two`);
  });

  test(`${theme}: secondary and tertiary text are legible on the panel`, () => {
    const t = tokens(theme);
    for (const name of ['--muted', '--faint']) {
      const r = contrast(t[name], t['--panel']);
      assert.ok(r >= AA, `${theme} ${name} on --panel is ${r.toFixed(2)}:1, needs ${AA}`);
    }
  });

  test(`${theme}: white on the destructive FILL is legible`, () => {
    // --del is tuned to be read as TEXT on the page; white on it measured 3.35:1 in dark,
    // which is why a filled button needs its own value rather than reusing that one.
    const t = tokens(theme);
    const r = contrast('#ffffff', t['--danger-fill']);
    assert.ok(r >= AA, `${theme} .btn.danger: white on ${t['--danger-fill']} is ${r.toFixed(2)}:1`);
  });
}

test('no component hardcodes a red that bypasses the tokens', () => {
  // Three literal #e5484d values had drifted from --del and each other, and none of them
  // was measured. A hex literal is how a palette silently grows a fourth red.
  const files = fs.globSync
    ? fs.globSync('client/src/lib/**/*.svelte', { cwd: new URL('..', import.meta.url).pathname })
    : [];
  const offenders: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    if (/#e5484d/i.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'use var(--del) / var(--danger-fill) instead of a literal');
});
