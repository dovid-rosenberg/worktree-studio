/*
 * A feature's colour tag.
 *
 * The tag is stored per FEATURE NAME and written through its own narrow route rather
 * than POST /settings, which is a full replace for the maps it carries — the last thing
 * that wrote a single value through that path deleted two repos' start commands on the
 * way past (see settings-roundtrip.test.ts). These pin the two properties that keep the
 * colour cheap: an unknown id is refused, and clearing removes the key rather than
 * storing a blank.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { FEATURE_COLORS } from '../server/types.ts';

test('the palette is a closed set, and it avoids every hue that already MEANS something', () => {
  // Green is merged/running, amber is waiting, purple is working, red is destructive.
  // A tag that could be mistaken for one of those is worse than no tag.
  assert.ok(FEATURE_COLORS.length >= 6, 'enough to tell a working set of features apart');
  assert.equal(new Set(FEATURE_COLORS).size, FEATURE_COLORS.length, 'no duplicates');
  for (const banned of ['green', 'amber', 'red', 'purple', 'yellow']) {
    assert.ok(!(FEATURE_COLORS as readonly string[]).includes(banned), `${banned} is a status hue`);
  }
});

test('every colour has both tokens defined in BOTH themes', async () => {
  // The reason ids exist instead of hex values: a colour picked in dark mode must not
  // become unreadable in light. That only holds if both blocks define all of them.
  const fs = await import('fs');
  const css = fs.readFileSync(new URL('../client/src/app.css', import.meta.url), 'utf8');
  const dark = css.slice(0, css.indexOf('[data-theme="light"]'));
  const light = css.slice(css.indexOf('[data-theme="light"]'));
  for (const c of FEATURE_COLORS) {
    for (const [name, block] of [
      ['dark', dark],
      ['light', light],
    ] as const) {
      assert.ok(block.includes(`--f-${c}:`), `--f-${c} missing from the ${name} theme`);
      assert.ok(block.includes(`--f-${c}-wash:`), `--f-${c}-wash missing from the ${name} theme`);
    }
  }
});
