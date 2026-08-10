/*
 * Routes that answer badly for bad input.
 *
 * A cluster of five, all the same shape: the handler assumed its body, so an omitted or
 * wrong field produced a 200 that said nothing, an empty response body, or — worst —
 * silently did something OTHER than what was asked. The neighbouring routes in each family
 * all validated; these were the ones that had been added without the guard.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveEditor } from '../server/util.ts';
import { SessionManager } from '../server/sessions.ts';
import fs from 'fs';
import os from 'os';
import path from 'path';

const EDITORS = {
  WebStorm: { open: 'open -na WebStorm --args {path}' },
  Zed: { open: 'zed {path}', openGroup: 'zed {paths}' },
};

test('an UNKNOWN editor name is refused, not quietly swapped for the default', () => {
  /*
   * `editors[name] || editors[defaultEditor]` cannot tell "caller did not name one"
   * (fallback correct) from "caller named one that does not exist" (fallback wrong). So a
   * typo in a config or a shortcut opened the wrong application and answered ok:true —
   * worse than an error, because you learn about it by noticing the wrong window.
   */
  const r = resolveEditor(EDITORS, 'NoSuchEditor', 'WebStorm');
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /unknown editor: NoSuchEditor/);
});

test('naming no editor still falls back to the default — the case the fallback is FOR', () => {
  for (const nothing of [undefined, null, '', '   ']) {
    const r = resolveEditor(EDITORS, nothing, 'WebStorm');
    assert.equal(r.ok, true, `${JSON.stringify(nothing)} should fall back`);
    assert.equal(r.ok === true ? r.name : '', 'WebStorm');
  }
});

test('a named editor that EXISTS is used, and reported by name', () => {
  const r = resolveEditor(EDITORS, 'Zed', 'WebStorm');
  assert.equal(r.ok === true && r.name, 'Zed');
  assert.equal(r.ok === true && r.editor.openGroup, 'zed {paths}');
});

test('no editors configured at all is its own message', () => {
  const r = resolveEditor({}, undefined, 'WebStorm');
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : '', /no editor configured/);
});

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-rv-'));
  return new SessionManager(
    { _stateDir: dir, web: { port: 0 }, claude: { cmd: 'true' }, baseDirs: [] } as never,
    { available: async () => true } as never,
  );
}

test('renaming an unknown session blames the SESSION, not the title', async () => {
  // It answered "invalid title" for a session that does not exist — blaming the one thing
  // the caller got right, and sending them to check a field that was fine.
  const m = manager();
  const r = await m.rename('s_nope', 'a perfectly good title');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /no such session/);
});

test('a session title is CAPPED, because it rides every state frame', async () => {
  /*
   * A title has no natural ceiling and is rebroadcast on every Claude hook — once per
   * agent tool call. A million-character title was accepted, persisted, and then sent to
   * every connected client for the rest of the session's life. renameTab three methods
   * away already caps its own input at 40; the convention existed in the same file.
   */
  const m = manager();
  // Injected rather than created: create() launches a real multiplexer session, and this
  // is a test about a string.
  m.sessions.set('s1', { id: 's1', title: 'before', tabs: [], repos: [] } as never);

  const r = await m.rename('s1', 'x'.repeat(1_000_000));
  assert.equal(r.ok, true);
  assert.equal(m.get('s1')?.title.length, 200, 'a megabyte does not belong on every frame');
});
