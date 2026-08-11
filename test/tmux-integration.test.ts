/*
 * The tmux driver, driven against a real tmux.
 *
 * server/multiplexer/tmux.ts is the module every session's life runs through, and until
 * this file it was covered by two pure-function tests, one end-to-end sendText test over
 * in sessions.test.ts, and a source grep (test/pins/pane-ready.test.ts) that asserts a
 * function is CALLED and would pass if it were a no-op. Everything that actually goes
 * wrong here is an argument to tmux being subtly the wrong argument — a session name where
 * a window id belongs, an exit code nobody read — and none of that is visible to a double,
 * because the seam is the tmux command line itself.
 *
 * Safe to run on a machine with live work in tmux: the driver talks to its own socket
 * (`tmux -L wt-studio`), never the default one, so nothing here can see or touch the
 * user's sessions. Every session created is named `wts-test-…` and killed in a finally.
 * Nothing in this file may ever run `kill-server`.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import tmux from '../server/multiplexer/tmux.ts';
import { CONFIG_DIR } from '../server/config.ts';
import { expectOk, present, requireTmux } from './helpers.ts';

const CWD = os.tmpdir();

let seq = 0;
/** A session name no other run, and no other test in this file, can collide with. */
function uniq(what: string): string {
  return `wts-test-${what}-${process.pid.toString(36)}-${(seq++).toString(36)}`;
}

/*
 * Kill the session AND delete the launch scripts it wrote.
 *
 * tmux.ts resolves CONFIG_DIR at module evaluation and a static import is hoisted above
 * anything this file could set, so these tests write into the user's real
 * ~/.config/worktree-studio/launch/. The boot reaper would clear them within a day; not
 * leaving them is better, and it is the same cleanup sessions.test.ts does by hand.
 */
async function cleanup(...names: string[]): Promise<void> {
  for (const name of names) {
    await tmux.kill(name);
    const dir = path.join(CONFIG_DIR, 'launch');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${name}-`)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
}

/** Poll `read` until `ok`, then return the value; returns the last read on timeout so the
 *  assertion that follows reports what the pane actually held. */
async function until(read: () => Promise<string>, ok: (v: string) => boolean, ms = 15_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = '';
  for (;;) {
    last = await read();
    if (ok(last) || Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/*
 * The regression test for the send that went to the wrong pane.
 *
 * newTab() addressed its send-keys at `-t <session>`, which tmux resolves to the session's
 * ACTIVE window at the moment the command runs — not at the moment new-window selected it.
 * Between those two moments sits waitForPaneReady, up to six seconds of it. So clicking
 * another tab while a dev-server tab is opening typed `. '/…/launch/….sh'` + Enter into
 * whatever pane had become active, and the pane that is usually active is the agent's:
 * a shell command submitted into a live claude conversation.
 *
 * Switching tabs mid-wait is exactly what this does, deliberately, at 250ms — after
 * new-window has returned and before waitForPaneReady can possibly have settled (it needs
 * two identical samples 150ms apart, so 300ms is its floor).
 */
test('a tab command lands in the window that was created, not in whichever tab is active', async (t) => {
  if (await requireTmux(t)) return;
  const name = uniq('newtab');
  try {
    const created = await tmux.ensure(name, { cwd: CWD });
    assert.equal(created.created, true, `session not created: ${created.error}`);
    const agent = present(created.id, "the agent window's id");

    const marker = `WTS_LANDED_${Date.now().toString(36)}`;
    const opening = tmux.newTab(name, { title: 'server', cwd: CWD, cmd: `echo ${marker}` });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await tmux.selectTab(name, agent), true, 'switching back to the agent tab');

    const tab = present(expectOk(await opening, 'newTab').id, "the new window's id");
    assert.notEqual(tab, agent, 'the fixture is only meaningful if these are two windows');

    const inTab = await until(
      () => tmux.capture(name, tab),
      (s) => s.includes(marker),
    );
    assert.match(inTab, new RegExp(marker), 'the command never ran in the window it was for');

    const inAgent = await tmux.capture(name, agent);
    assert.ok(!inAgent.includes(marker), `the launch was typed into the agent's pane instead:\n${inAgent}`);
  } finally {
    await cleanup(name);
  }
});

/*
 * Two tabs opening at once used to share one launch script.
 *
 * The file was named `${session}-tab`, so the second newTab overwrote the first one's
 * command before the first had sourced it, and both panes ran the second command. One
 * dev server started twice, the other never.
 */
test('two tabs opened at once each run their own command', async (t) => {
  if (await requireTmux(t)) return;
  const name = uniq('twotabs');
  try {
    assert.equal((await tmux.ensure(name, { cwd: CWD })).created, true);
    const stamp = Date.now().toString(36);
    const [a, b] = await Promise.all([
      tmux.newTab(name, { title: 'a', cwd: CWD, cmd: `echo WTS_A_${stamp}` }),
      tmux.newTab(name, { title: 'b', cwd: CWD, cmd: `echo WTS_B_${stamp}` }),
    ]);
    const idA = present(expectOk(a, 'newTab a').id, 'window a');
    const idB = present(expectOk(b, 'newTab b').id, 'window b');

    const paneA = await until(
      () => tmux.capture(name, idA),
      (s) => s.includes(`WTS_A_${stamp}`) || s.includes(`WTS_B_${stamp}`),
    );
    const paneB = await until(
      () => tmux.capture(name, idB),
      (s) => s.includes(`WTS_A_${stamp}`) || s.includes(`WTS_B_${stamp}`),
    );
    assert.ok(paneA.includes(`WTS_A_${stamp}`), `tab a ran the wrong command:\n${paneA}`);
    assert.ok(paneB.includes(`WTS_B_${stamp}`), `tab b ran the wrong command:\n${paneB}`);
  } finally {
    await cleanup(name);
  }
});

test('kill() removes the session and the pop-out and split that hang off its name', async (t) => {
  if (await requireTmux(t)) return;
  const name = uniq('kill');
  const variants = [name, `${name}-popout`, `${name}-split`];
  try {
    for (const s of variants) {
      assert.equal((await tmux.ensure(s, { cwd: CWD })).created, true, `could not create ${s}`);
    }
    assert.equal(await tmux.kill(name), true, 'killing a session that exists');
    for (const s of variants) {
      assert.equal(await tmux.hasSession(s), false, `${s} survived the kill`);
    }
    /*
     * And a second kill is still `true`. kill-session exits non-zero on a session it
     * cannot find, but "already gone" is the outcome deactivate() asked for — the answer
     * is the state, not the exit code. The case this change really buys, tmux unreachable
     * so the kill silently did nothing, cannot be staged here without a fake tmux on the
     * PATH; what is checkable is that the honest reading of a live tmux is unchanged.
     */
    assert.equal(await tmux.kill(name), true, 'a session that was already gone is not a failed kill');
  } finally {
    await cleanup(...variants);
  }
});

test('closeTab() reports failure for a window that is not there', async (t) => {
  if (await requireTmux(t)) return;
  const name = uniq('closetab');
  try {
    assert.equal((await tmux.ensure(name, { cwd: CWD })).created, true);
    // A stale index is the realistic shape: `renumber-windows on` means the client can
    // hold an index that has since been reassigned or dropped off the end.
    assert.equal(await tmux.closeTab(name, 99), false, 'a missing index must not read as closed');
    assert.equal(await tmux.closeTab(name, '@99999'), false, 'nor a window id from a dead session');

    const opened = expectOk(await tmux.newTab(name, { title: 'scratch', cwd: CWD }), 'newTab');
    const id = present(opened.id, 'window id');
    assert.equal(await tmux.closeTab(name, id), true, 'closing a window that is there');
    assert.equal(await tmux.closeTab(name, id), false, 'closing the same window twice');
    assert.deepEqual(
      (await tmux.listTabs(name)).map((w) => w.title),
      ['claude'],
      'only the agent window is left',
    );
  } finally {
    await cleanup(name);
  }
});

/*
 * ensure() is create-if-missing, and restore()/reconcile() call it on every pass over
 * every session. If a second call did anything at all it would do it hundreds of times a
 * day: a duplicate window, or — worse — a second `claude --resume` typed into the pane
 * where the first one is still talking.
 */
test('ensure() is idempotent: a second call creates nothing and launches nothing', async (t) => {
  if (await requireTmux(t)) return;
  const name = uniq('ensure');
  try {
    const first = await tmux.ensure(name, { cwd: CWD });
    assert.equal(first.created, true, `session not created: ${first.error}`);
    present(first.id, 'the agent window id the first call reports');

    const marker = `WTS_SECOND_${Date.now().toString(36)}`;
    const second = await tmux.ensure(name, { cwd: CWD, cmd: `echo ${marker}` });
    assert.equal(second.created, false, 'the session was already there');
    assert.equal(second.id, undefined, 'nothing was created, so there is no id to report');

    assert.deepEqual(
      (await tmux.listTabs(name)).map((w) => w.title),
      ['claude'],
      'a second ensure must not add a window',
    );
    const pane = await tmux.capture(name, '0');
    assert.ok(!pane.includes(marker), `the second ensure typed its command into the pane:\n${pane}`);
  } finally {
    await cleanup(name);
  }
});
