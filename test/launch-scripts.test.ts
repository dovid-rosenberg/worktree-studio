// Launch scripts accumulate one per pane per session, forever, unless something reaps
// them. The header in tmux.ts used to say "bounded, no cleanup" — bounded PER PANE, but a
// pane name carries a session id and ids die, so 85 files had piled up on a real install.
//
// CONFIG_DIR is captured by tmux.ts at module evaluation, so the env has to be set before
// the dynamic import below — the same ordering trap config-merge.test.ts documents.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-studio-launch-'));
process.env.WT_STUDIO_CONFIG_DIR = TMP;

const { reapLaunchScripts } = await import('../server/multiplexer/tmux.ts');

const LAUNCH = path.join(TMP, 'launch');

/** Write a launch script and backdate it by `ageMs`. */
function script(name: string, ageMs: number): string {
  fs.mkdirSync(LAUNCH, { recursive: true });
  const file = path.join(LAUNCH, name);
  fs.writeFileSync(file, 'echo hi\n');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('an old launch script is removed', () => {
  const old = script('wts-gone-abc-0.sh', 3 * DAY);
  assert.equal(reapLaunchScripts(), 1);
  assert.ok(!fs.existsSync(old));
});

test('a recent one is left alone — a launch is measured in seconds, not hours', () => {
  const fresh = script('wts-live-def-0.sh', 5 * 1000);
  assert.equal(reapLaunchScripts(), 0);
  assert.ok(fs.existsSync(fresh));
  fs.unlinkSync(fresh);
});

test('only .sh files are touched', () => {
  fs.mkdirSync(LAUNCH, { recursive: true });
  const keep = path.join(LAUNCH, 'notes.txt');
  fs.writeFileSync(keep, 'x');
  const when = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(keep, when, when);

  assert.equal(reapLaunchScripts(), 0, 'a non-script is not this function\'s business');
  assert.ok(fs.existsSync(keep));
  fs.unlinkSync(keep);
});

test('the age threshold is a parameter, so the boot default is not the only behaviour', () => {
  const a = script('wts-a-1.sh', 2 * HOUR);
  assert.equal(reapLaunchScripts(DAY), 0, 'two hours old survives a one-day cutoff');
  assert.equal(reapLaunchScripts(HOUR), 1, 'and is reaped by a one-hour one');
  assert.ok(!fs.existsSync(a));
});

test('a missing launch directory is not an error — it may never have been created', () => {
  fs.rmSync(LAUNCH, { recursive: true, force: true });
  assert.equal(reapLaunchScripts(), 0);
});
