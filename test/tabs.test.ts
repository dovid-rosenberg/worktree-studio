import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '../server/sessions.ts';
import type { Config, PartialDeep, SessionTab } from '../server/types.ts';
import { muxStub, session } from './helpers.ts';

/*
 * Tabs are addressed by the multiplexer's WINDOW ID, never by array position.
 *
 * tmux runs with `renumber-windows on`, so a window's index is a slot that is
 * reassigned whenever an earlier window closes. Every one of these tests fails if the
 * code goes back to treating that index as an identity — which is the shape the bug
 * had: closing the middle of [claude, api, web] renumbered web into api's old slot,
 * and the stored title followed the slot, so the strip showed a tab named "api" that
 * selected the web shell.
 */

/** A stub whose windows behave like tmux's: stable @ids, indexes that renumber. */
function windowedMux(initial: { id: string; title: string }[]) {
  let windows = initial.map((w) => ({ ...w, active: false }));
  const calls: { op: string; target: string | number }[] = [];
  let nextId = 100;
  return {
    calls,
    get windows() {
      return windows;
    },
    mux: muxStub({
      async listTabs() {
        return windows.map((w) => ({ ...w }));
      },
      async newTab(_name: string, opts?: { title?: string }) {
        const id = `@${nextId++}`;
        windows.push({ id, title: opts?.title || 'shell', active: false });
        return { ok: true, id };
      },
      async selectTab(_name: string, id: string | number) {
        calls.push({ op: 'select', target: id });
        return windows.some((w) => w.id === String(id));
      },
      async closeTab(_name: string, id: string | number) {
        calls.push({ op: 'close', target: id });
        const before = windows.length;
        windows = windows.filter((w) => w.id !== String(id));
        return windows.length < before;
      },
      async renameTab(_name: string, id: string | number, title: string) {
        calls.push({ op: 'rename', target: id });
        const w = windows.find((x) => x.id === String(id));
        if (!w) return false;
        w.title = title;
        return true;
      },
    }),
  };
}

function managerWith(mux: ReturnType<typeof windowedMux>['mux'] | ReturnType<typeof muxStub>) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-tabs-'));
  const cfg: PartialDeep<Config> = {
    _stateDir: stateDir,
    _file: path.join(stateDir, 'config.json'),
    web: { port: 0 },
    claude: { cmd: 'claude' },
    baseDirs: [],
    copyPatterns: {},
  };
  return new SessionManager(cfg, mux);
}

/** Put a session into the manager without going through the mux launch path. */
function seed(mgr: SessionManager, tabs: SessionTab[]) {
  const s = session({
    id: 's_tabs',
    repoName: 'r',
    repoPath: '/tmp/r',
    home: '/tmp/r',
    muxName: 'mux-tabs',
    tabs: tabs.map((t) => ({ ...t })),
  });
  mgr.sessions.set(s.id, s);
  return s;
}

test('closing a middle tab keeps every surviving tab on its own terminal', async () => {
  const w = windowedMux([
    { id: '@1', title: 'claude' },
    { id: '@2', title: 'api' },
    { id: '@3', title: 'web' },
  ]);
  const mgr = managerWith(w.mux);
  const s = seed(mgr, [
    { id: '@1', title: 'claude' },
    { id: '@2', title: 'api' },
    { id: '@3', title: 'web' },
  ]);

  const r = await mgr.closeTab(s.id, '@2');
  assert.equal(r.ok, true);

  // The regression: with positional matching, 'api' would land on @3 here.
  assert.deepEqual(
    s.tabs.map((t: SessionTab) => `${t.id}=${t.title}`),
    ['@1=claude', '@3=web'],
    'the surviving window must keep its own title',
  );
  assert.deepEqual(w.calls, [{ op: 'close', target: '@2' }], 'closed by id, not by index');
});

test('close targets the window id even when it differs from the array position', async () => {
  const w = windowedMux([
    { id: '@1', title: 'claude' },
    { id: '@9', title: 'shell' },
  ]);
  const mgr = managerWith(w.mux);
  const s = seed(mgr, [
    { id: '@1', title: 'claude' },
    { id: '@9', title: 'shell' },
  ]);

  await mgr.closeTab(s.id, '@9');
  assert.deepEqual(w.calls, [{ op: 'close', target: '@9' }]);
  assert.deepEqual(
    s.tabs.map((t: SessionTab) => t.id),
    ['@1'],
  );
});

test('the only tab cannot be closed', async () => {
  const w = windowedMux([{ id: '@1', title: 'claude' }]);
  const mgr = managerWith(w.mux);
  const s = seed(mgr, [{ id: '@1', title: 'claude' }]);

  const r = await mgr.closeTab(s.id, '@1');
  assert.equal(r.ok, false);
  assert.equal(w.calls.length, 0, 'the multiplexer must not be asked');
  assert.equal(s.tabs.length, 1);
});

test('a close the multiplexer refuses does not remove the tab', async () => {
  const mgr = managerWith(
    muxStub({
      async closeTab() {
        return false;
      },
      async listTabs() {
        return [
          { id: '@1', title: 'claude', active: true },
          { id: '@2', title: 'shell', active: false },
        ];
      },
    }),
  );
  const s = seed(mgr, [
    { id: '@1', title: 'claude' },
    { id: '@2', title: 'shell' },
  ]);

  const r = await mgr.closeTab(s.id, '@2');
  assert.equal(r.ok, false);
  assert.equal(s.tabs.length, 2, 'the strip must not claim a tab is gone while it is there');
});

test('addTab records the id the multiplexer assigned', async () => {
  const w = windowedMux([{ id: '@1', title: 'claude' }]);
  const mgr = managerWith(w.mux);
  const s = seed(mgr, [{ id: '@1', title: 'claude' }]);

  const r = await mgr.addTab(s.id, { title: 'api' });
  assert.equal(r.ok, true);
  assert.equal(s.tabs.length, 2);
  assert.equal(s.tabs[1].title, 'api');
  assert.match(s.tabs[1].id, /^@\d+$/, 'the tab must carry a real window id, not a position');
});

test('rename goes to the window id and is trimmed, and refuses an empty name', async () => {
  const w = windowedMux([
    { id: '@1', title: 'claude' },
    { id: '@2', title: 'shell' },
  ]);
  const mgr = managerWith(w.mux);
  const s = seed(mgr, [
    { id: '@1', title: 'claude' },
    { id: '@2', title: 'shell' },
  ]);

  const ok = await mgr.renameTab(s.id, '@2', '  api  ');
  assert.equal(ok.ok, true);
  assert.equal(s.tabs[1].title, 'api');
  assert.deepEqual(w.calls, [{ op: 'rename', target: '@2' }]);

  const bad = await mgr.renameTab(s.id, '@2', '   ');
  assert.equal(bad.ok, false);
  assert.equal(s.tabs[1].title, 'api', 'a refused rename must not change the stored title');
});

test('an unknown tab reference is refused rather than resolved to a neighbour', async () => {
  const w = windowedMux([
    { id: '@1', title: 'claude' },
    { id: '@2', title: 'shell' },
  ]);
  const mgr = managerWith(w.mux);
  const s = seed(mgr, [
    { id: '@1', title: 'claude' },
    { id: '@2', title: 'shell' },
  ]);

  assert.equal((await mgr.selectTab(s.id, '@404')).ok, false);
  assert.equal((await mgr.renameTab(s.id, '@404', 'x')).ok, false);
  assert.equal((await mgr.closeTab(s.id, '@404')).ok, false);
  assert.equal(s.tabs.length, 2);
});

test('_syncTabs keeps titles with their window across a tmux-side renumber', async () => {
  // tmux renumbered: the window formerly at index 2 is now index 1, but its id is fixed.
  const mgr = managerWith(
    muxStub({
      async listTabs() {
        return [
          { id: '@1', title: 'claude', active: true },
          { id: '@3', title: 'zsh', active: false },
        ];
      },
    }),
  );
  const s = seed(mgr, [
    { id: '@1', title: 'claude' },
    { id: '@2', title: 'api' },
    { id: '@3', title: 'web' },
  ]);

  await (mgr as any)._syncTabs(s);
  assert.deepEqual(
    s.tabs.map((t: SessionTab) => `${t.id}=${t.title}`),
    ['@1=claude', '@3=web'],
    'the custom title follows its window id; the dead window takes its title with it',
  );
});

test('a tab tmux does not know yet falls back to the live window name', async () => {
  const mgr = managerWith(
    muxStub({
      async listTabs() {
        return [{ id: '@7', title: 'claude', active: true }];
      },
    }),
  );
  // `pending` is what a freshly seeded session carries until the first sync.
  const s = seed(mgr, [{ id: 'pending', title: 'claude' }]);

  await (mgr as any)._syncTabs(s);
  assert.deepEqual(s.tabs, [{ id: '@7', title: 'claude' }], 'the placeholder is replaced by the real id');
});
