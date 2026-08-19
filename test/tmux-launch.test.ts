import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// tmux.ts resolves LAUNCH_DIR from CONFIG_DIR at module evaluation, so aim it at a
// throwaway dir BEFORE loading the module (dynamic import for the same reason).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-studio-tmux-'));
process.env.WT_STUDIO_CONFIG_DIR = TMP;
const { launchKeys, isIdleShell } = await import('../server/multiplexer/tmux.ts');

// A shell that has not finished starting still has its tty in canonical mode, where
// the kernel drops everything past MAX_INPUT (1024 bytes on macOS) of an unterminated
// line. Launch commands carry the session seed inline and cross that easily; the cut
// lands mid-quote and the shell hangs at `quote>` instead of ever running claude.
const MAX_INPUT = 1024;

function longCmd(n: number): string {
  // shape of a real launch command: quoted args, apostrophes escaped POSIX-style
  return `env -u X claude --append-system-prompt 'You'\\''re here' '${'seed '.repeat(n)}'`;
}

test('launchKeys keeps the typed line far under the tty canonical-mode input limit', () => {
  const keys = launchKeys('wts-feature-abc123', longCmd(500));
  assert.ok(longCmd(500).length > MAX_INPUT, 'fixture must exceed the limit to be meaningful');
  assert.ok(keys.length < MAX_INPUT, `typed line was ${keys.length} bytes, must stay under ${MAX_INPUT}`);
});

test('launchKeys writes the full command to a sourceable file, unaltered', () => {
  const cmd = longCmd(500);
  const keys = launchKeys('wts-feature-abc123', cmd);
  const file = keys.replace(/^\. '/, '').replace(/'$/, '');
  assert.ok(fs.existsSync(file), `expected ${file} to exist`);
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(body.startsWith(cmd), 'the command must reach the file untruncated');
  assert.match(body, /; exec .* -l\n$/, 'pane must drop to a login shell when the command exits');
});

test('launchKeys sources with `.`, not `source` — the pane shell may be dash/sh', () => {
  assert.match(launchKeys('wts-x-1', 'claude'), /^\. '/);
});

test('launchKeys gives each pane its own file and rewrites it in place', () => {
  const a = launchKeys('wts-one-1', 'claude --resume A');
  const b = launchKeys('wts-two-2', 'claude --resume B');
  assert.notStrictEqual(a, b, 'two panes must not share one launch file');
  const again = launchKeys('wts-one-1', 'claude --resume C');
  assert.strictEqual(again, a, 'the same pane must reuse its file rather than leaking a new one');
  const file = a.replace(/^\. '/, '').replace(/'$/, '');
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('claude --resume C'), 'rewritten in place');
});

/*
 * isIdleShell decides Resume. `true` means the agent exited and left its shell, so relaunch;
 * `false` means something is alive in that pane and must be adopted, not doubled.
 *
 * The direction that shipped broken is `false` for a shell: the session is then marked
 * adopted, nothing is launched, and the button reports success forever. That is what a
 * hardcoded list of POSIX shell names did to anyone whose $SHELL is fish or nushell —
 * persistCmd execs $SHELL, so their idle pane says `fish`, which was not in the list.
 */
test("an idle pane running the user's own $SHELL is recognised as a shell, whatever it is", () => {
  assert.equal(isIdleShell('fish', '/opt/homebrew/bin/fish'), true);
  assert.equal(isIdleShell('nu', '/usr/local/bin/nu'), true);
  assert.equal(isIdleShell('-fish', '/opt/homebrew/bin/fish'), true, 'a login shell carries a leading -');
});

test('the known-shell list still covers panes we did not start from $SHELL', () => {
  for (const cmd of ['zsh', '-zsh', 'bash', 'sh', 'dash', 'tcsh', 'login', 'fish', 'pwsh']) {
    assert.equal(isIdleShell(cmd, '/bin/zsh'), true, `${cmd} is a shell sitting at a prompt`);
  }
});

test('a live agent is never mistaken for an idle shell', () => {
  // claude reports itself as `node`, and reports its Bash tool's child while a tool runs —
  // adopting is right for both, which is why anything unrecognised must answer false.
  for (const cmd of ['node', 'claude', 'vim', 'npm', 'ssh', 'shell-thing', 'bashful']) {
    assert.equal(isIdleShell(cmd, '/bin/zsh'), false, `${cmd} is something worth adopting`);
  }
  assert.equal(isIdleShell('', '/bin/zsh'), false, 'an unreadable pane command claims nothing');
});

test('an unset $SHELL falls back to the list rather than matching everything', () => {
  // path.basename('') is '', and an empty pane command is already excluded — but a pane
  // command must never match by accident just because the env is bare.
  assert.equal(isIdleShell('zsh', ''), true);
  assert.equal(isIdleShell('node', ''), false);
});

test('launchKeys sanitises the pane name into the filename', () => {
  const file = launchKeys('wts-../../escape-1', 'claude').replace(/^\. '/, '').replace(/'$/, '');
  assert.strictEqual(path.dirname(file), path.join(TMP, 'launch'), `escaped LAUNCH_DIR: ${file}`);
});
