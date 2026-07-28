import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

// tmux.ts resolves LAUNCH_DIR from CONFIG_DIR at module evaluation, so aim it at a
// throwaway dir BEFORE loading the module (dynamic import for the same reason).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-studio-tmux-'));
process.env.WT_STUDIO_CONFIG_DIR = TMP;
const { launchKeys } = await import('../server/multiplexer/tmux.ts');

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

test('launchKeys sanitises the pane name into the filename', () => {
  const file = launchKeys('wts-../../escape-1', 'claude').replace(/^\. '/, '').replace(/'$/, '');
  assert.strictEqual(path.dirname(file), path.join(TMP, 'launch'), `escaped LAUNCH_DIR: ${file}`);
});
