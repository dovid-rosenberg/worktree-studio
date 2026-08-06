/*
 * Saving settings must not DELETE configuration it merely failed to understand.
 *
 * `POST /settings` is a FULL REPLACE for `start`, `editors`, `groups` and `runConfigs`:
 * whatever the body carries becomes the whole map. That is the intended contract — a row
 * deleted in the modal is deleted on disk — and it is what makes these coercions
 * load-bearing, because anything they drop is DESTROYED rather than merely ignored.
 *
 * The bug: `start` accepts two shapes on disk, and this understood one. `"repo": "npm
 * start"` is the documented shorthand that `servers.startCfg()` reads everywhere else,
 * but the coercion tested `isRecord(v)` first, so a string produced an empty command and
 * the entry vanished. Opening the settings modal and pressing Save silently un-configured
 * every repo written that way. The only symptom appeared later, somewhere else:
 * "Restarted 1/2. Skipped ab-iso-fe — no start command configured for this repo".
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  coerceEditors,
  coerceGroups,
  coerceRunConfigs,
  coercePorts,
  coerceStart,
} from '../server/settings.ts';

test('the bare-string form of `start` SURVIVES — the regression that lost two repos', () => {
  const out = coerceStart({
    'accept-blue': { cmd: 'node app.js', ports: [1231, 1999] },
    'ab-iso-fe': 'npm start',
    'ab-su': 'npm start',
  });
  assert.deepEqual(Object.keys(out).sort(), ['ab-iso-fe', 'ab-su', 'accept-blue']);
  assert.equal(out['ab-iso-fe'].cmd, 'npm start');
});

test('a string entry is normalised to the object form, so it round-trips from then on', () => {
  assert.deepEqual(coerceStart({ 'ab-iso-fe': 'npm start' })['ab-iso-fe'], {
    cmd: 'npm start',
    ports: [],
  });
  // And the normalised form survives the next save unchanged.
  const twice = coerceStart(coerceStart({ 'ab-iso-fe': 'npm start' }));
  assert.deepEqual(twice['ab-iso-fe'], { cmd: 'npm start', ports: [] });
});

test('an entry with no command is still dropped — that is the intended replace', () => {
  // The coercion must keep refusing junk; the bug was that it counted a VALID shape as junk.
  const out = coerceStart({ good: 'npm start', blank: { cmd: '   ' }, empty: '', nul: null });
  assert.deepEqual(Object.keys(out), ['good']);
});

test('ports come through as numbers however they were written', () => {
  assert.deepEqual(coercePorts([1231, 1999]), [1231, 1999]);
  assert.deepEqual(coercePorts('1231 1999'), [1231, 1999]);
  assert.deepEqual(coercePorts('1231,1999'), [1231, 1999]);
  assert.deepEqual(coercePorts(undefined), []);
  assert.deepEqual(coercePorts('nope'), [], 'a non-port is not silently turned into NaN');
  assert.deepEqual(coerceStart({ api: { cmd: 'node app.js', ports: '1231 1999' } }).api.ports, [1231, 1999]);
});

test('an editor with no open command is dropped; openGroup is optional', () => {
  const out = coerceEditors({
    WebStorm: { open: 'open -na WebStorm --args {path}' },
    Zed: { open: 'zed {path}', openGroup: 'zed {paths}' },
    Broken: { open: '  ' },
  });
  assert.deepEqual(Object.keys(out).sort(), ['WebStorm', 'Zed']);
  assert.equal(out.Zed.openGroup, 'zed {paths}');
  assert.equal('openGroup' in out.WebStorm, false, 'not invented for an editor that has none');
});

test('a group with no members groups nothing, and is dropped', () => {
  const out = coerceGroups([
    { name: 'mfa', members: ['api/fix-mfa', 'web/mfa-cleanup'] },
    { name: 'empty', members: [] },
    { name: '', members: ['api/x'] },
  ]);
  assert.deepEqual(out, [{ name: 'mfa', members: ['api/fix-mfa', 'web/mfa-cleanup'] }]);
});

test('run configurations keep their kind, defaulting to task', () => {
  const out = coerceRunConfigs({
    api: [
      { name: 'unit', cmd: 'npm run test:unit' },
      { name: 'serve', cmd: 'npm start', kind: 'server' },
      { name: 'no command', cmd: '' },
    ],
  });
  assert.equal(out.api.length, 2);
  assert.equal(out.api[0].kind, 'task', 'anything not explicitly a server is finite');
  assert.equal(out.api[1].kind, 'server');
});

test('a body that is not an object leaves nothing behind rather than throwing', () => {
  // The route only calls these behind an isRecord check, but a coercion that throws on
  // junk would turn a malformed save into a 500 instead of a no-op.
  assert.deepEqual(coerceStart(null), {});
  assert.deepEqual(coerceStart('nope'), {});
  assert.deepEqual(coerceEditors([]), {});
  assert.deepEqual(coerceGroups({}), []);
  assert.deepEqual(coerceRunConfigs(7), {});
});
