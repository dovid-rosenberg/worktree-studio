// server/servers.ts's own resources: the descriptor it hands a launched dev
// server, and the log file it keeps appending to for the worktree's life.
//
// Both are things the daemon holds for as long as it runs, so they are asserted
// against the process's real descriptor table rather than against a mock.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Servers, trimLog, LOG_LIMITS } from '../server/servers.ts';

function servers(extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-servers-'));
  const cfg = { _stateDir: stateDir, web: { port: 0 }, start: { api: { cmd: ':', ports: [] } }, ...extra };
  return new Servers(cfg);
}

function tempWorktree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wts-wt-'));
}

// Descriptors open in THIS process. /dev/fd is the calling process's own
// descriptor table on macOS and Linux alike, so this counts exactly what a
// long-lived daemon would be accumulating.
function openFds() {
  return fs.readdirSync('/dev/fd').length;
}

test('start() does not leak the log descriptor it hands the child', async () => {
  const s = servers();
  const wt = tempWorktree();
  await s.start('api', wt); // warm-up: creates the log, the lock dir, the state file
  const before = openFds();
  for (let i = 0; i < 6; i++) await s.start('api', wt); // eslint-disable-line no-await-in-loop
  const after = openFds();
  assert.ok(after - before <= 1, `6 launches leaked ${after - before} descriptor(s)`);
  fs.rmSync(wt, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// log size + read ceilings
// ---------------------------------------------------------------------------

// Write `bytes` of numbered lines, fast (one big buffer, appended in chunks).
function growLog(file: string, bytes: number): void {
  const line = `${'x'.repeat(99)}\n`;
  const chunk = Buffer.from(line.repeat(Math.ceil((1 << 20) / line.length)));
  const fd = fs.openSync(file, 'a');
  try {
    for (let w = 0; w < bytes; w += chunk.length) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }
}

// A Servers with one tracked worktree pointing at a log we control.
function tracking(logName = 'big.log') {
  const s = servers();
  const wt = tempWorktree();
  const log = path.join(s.logDir, logName);
  s.tracked[wt] = { pid: 1, repo: 'api', log, startedAt: Date.now() };
  return { s, wt, log };
}

test('the tail of a huge log is read backwards, not whole', async () => {
  const { s, wt, log } = tracking();
  growLog(log, 64 * 1024 * 1024);
  fs.appendFileSync(log, 'LAST LINE\n');
  const started = process.hrtime.bigint();
  const out = s.logs(wt, { lines: 20 });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(out.text.endsWith('LAST LINE\n'), 'the tail is still the end of the file');
  assert.equal(out.size, fs.statSync(log).size, 'size is still the real file size');
  // slice(-lines) on a text ending in a newline yields `lines` elements, the last
  // of them empty — the same shape the whole-file read produced.
  assert.equal(out.text.split('\n').length, 20, 'exactly the lines asked for');
  // Reading 64 MB and splitting it costs seconds on the loop that also serves the
  // terminal WebSockets; a bounded backward read is a couple of milliseconds.
  assert.ok(ms < 300, `tailing a 64 MB log took ${ms.toFixed(0)}ms — it is being read whole`);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('an incremental read is capped rather than allocating the whole gap', () => {
  const { s, wt, log } = tracking('gap.log');
  growLog(log, 8 * 1024 * 1024);
  const out = s.logs(wt, { offset: 0 });
  assert.ok(Buffer.byteLength(out.text) <= LOG_LIMITS.TAIL_MAX_BYTES, 'read is capped');
  assert.ok(out.skipped > 0, 'and says how many bytes it had to skip');
  assert.equal(out.offset, out.size, 'the caller is still moved to the end of the file');
  // Caught up: the next read costs nothing and skips nothing.
  fs.appendFileSync(log, 'tail\n');
  const next = s.logs(wt, { offset: out.offset });
  assert.equal(next.text, 'tail\n');
  assert.equal(next.skipped, 0);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('trimLogs() brings an oversized log back under the ceiling, keeping the tail', () => {
  const { s, wt, log } = tracking('trim.log');
  growLog(log, LOG_LIMITS.MAX_LOG_BYTES + (2 << 20));
  fs.appendFileSync(log, 'KEEP ME\n');
  assert.equal(s.trimLogs(), 1);
  const size = fs.statSync(log).size;
  assert.ok(size <= LOG_LIMITS.KEEP_LOG_BYTES, `trimmed to ${size} bytes`);
  assert.ok(fs.readFileSync(log, 'utf8').endsWith('KEEP ME\n'), 'the newest output survives');
  assert.equal(s.trimLogs(), 0, 'a log already under the ceiling is left alone');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('trimming is safe under a live O_APPEND writer — no sparse hole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-trim-'));
  const log = path.join(dir, 'live.log');
  growLog(log, 3 << 20);
  // The dev server's inherited descriptor: opened 'a', held across the trim.
  const child = fs.openSync(log, 'a');
  try {
    assert.equal(trimLog(log, 1 << 20, 256 * 1024), true);
    const afterTrim = fs.statSync(log).size;
    fs.writeSync(child, 'still writing\n');
    assert.equal(
      fs.statSync(log).size,
      afterTrim + 'still writing\n'.length,
      'O_APPEND resumes at the new end — the file does not jump back to its old size',
    );
    assert.ok(fs.readFileSync(log, 'utf8').endsWith('still writing\n'));
  } finally {
    fs.closeSync(child);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('start() trims a log the previous run left oversized', async () => {
  const s = servers();
  const wt = tempWorktree();
  const log = path.join(s.logDir, `api__${path.basename(wt)}.log`);
  growLog(log, LOG_LIMITS.MAX_LOG_BYTES + (1 << 20));
  await s.start('api', wt);
  assert.ok(fs.statSync(log).size < LOG_LIMITS.MAX_LOG_BYTES, 'the relaunch did not inherit it');
  fs.rmSync(wt, { recursive: true, force: true });
});

// ---- deps-aware canStart ----------------------------------------------------
//
// `canStart` used to mean "a start command is configured", which stayed true for a
// worktree that could not possibly start: `git worktree add` does not bring
// node_modules across, so the start command dies the moment it is invoked. For a
// multi-repo feature that meant one half came up and the other did not, with nothing
// on screen saying why. It now means "starting this will work".

test('depsMissing is true only for a package.json with no node_modules', () => {
  const s = servers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-deps-'));

  // no package.json at all — not a node project, so not our problem to flag
  assert.equal(s.depsMissing(dir), false);

  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  assert.equal(s.depsMissing(dir), true, 'package.json without node_modules');

  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.equal(s.depsMissing(dir), false, 'once installed it is startable again');
});

test('canStart is false when the deps a start command needs are absent', () => {
  const s = servers({ start: { demo: { cmd: 'npm run dev' } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-deps2-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');

  const bare = s.decorate({ path: dir, repo: 'demo' }, new Map());
  assert.equal(bare.depsMissing, true);
  assert.equal(bare.canStart, false, 'a configured command is not enough to be startable');

  fs.mkdirSync(path.join(dir, 'node_modules'));
  const ready = s.decorate({ path: dir, repo: 'demo' }, new Map());
  assert.equal(ready.depsMissing, false);
  assert.equal(ready.canStart, true);
});

test('says which half of canStart is false — deps, or no start command at all', () => {
  /*
   * canStart is `!!startCfg && !depsMissing`, and only the deps half could explain
   * itself on screen. A repo simply absent from `config.start` produced no button and
   * no reason; the natural guess was stale deps, and only an API query said otherwise.
   * Both halves now report, so an absent button can carry a reason.
   */
  const s = servers({ start: { demo: { cmd: 'npm run dev' } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-nostart-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  fs.mkdirSync(path.join(dir, 'node_modules'));

  const configured = s.decorate({ path: dir, repo: 'demo' }, new Map());
  assert.equal(configured.canStart, true);
  assert.equal(configured.noStartCmd, false, 'this repo has a command');

  // Same worktree, a repo nobody configured: startable is false for a different reason.
  const unconfigured = s.decorate({ path: dir, repo: 'ab-su' }, new Map());
  assert.equal(unconfigured.canStart, false);
  assert.equal(unconfigured.noStartCmd, true, 'and it must be able to say so');
  assert.equal(unconfigured.depsMissing, false, 'blaming deps here is what misled');
});

// ---- pruneTracked ----------------------------------------------------------
//
// A tracked record says "this worktree has a dev server, pid N". When that process
// dies on its own — crashed, or killed from a terminal — nothing tells the daemon.
// Pruning used to run at boot ONLY, so the record survived for the rest of the
// daemon's lifetime and the UI kept claiming the server was up. It runs on the
// discovery sweep now, which is what these pin.

test('pruneTracked drops a record whose process is gone, and keeps a live one', async () => {
  const s = servers();
  const dead = tempWorktree();
  const live = tempWorktree();

  // A record only counts as ours when its startedAt MATCHES the process's real start
  // time — that is the recycled-pid guard, and a fabricated timestamp is exactly what
  // it is built to reject. So ask for the real one.
  const mine = await s._psInfo(process.pid);
  assert.ok(mine, 'this process must be visible to ps for the test to mean anything');

  // A pid that cannot exist: 2^22 is above every platform's pid_max.
  s.tracked[dead] = { pid: 4194304, startedAt: Date.now() };
  s.tracked[live] = { pid: process.pid, startedAt: mine.startedAt };

  const dropped = await s.pruneTracked();

  assert.deepEqual(
    dropped.map((d) => d.worktreePath),
    [dead],
  );
  assert.equal(dropped[0].pid, 4194304, 'the dropped record reports the pid it named');
  assert.ok(!(dead in s.tracked), 'the dead record is gone');
  assert.ok(live in s.tracked, 'the live one is untouched');
});

test('pruneTracked is a no-op when everything it tracks is alive', async () => {
  const s = servers();
  const live = tempWorktree();
  const mine = await s._psInfo(process.pid);
  s.tracked[live] = { pid: process.pid, startedAt: mine!.startedAt };

  assert.deepEqual(await s.pruneTracked(), []);
  assert.ok(live in s.tracked);
});

test('pruneTracked is safe to call repeatedly — the sweep runs it every few seconds', async () => {
  const s = servers();
  const dead = tempWorktree();
  s.tracked[dead] = { pid: 4194304, startedAt: Date.now() };

  assert.equal((await s.pruneTracked()).length, 1);
  // Second pass has nothing left to drop, so it must not report or write again.
  assert.deepEqual(await s.pruneTracked(), []);
  assert.deepEqual(await s.pruneTracked(), []);
});
