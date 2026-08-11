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
import { realpath } from '../server/util.ts';
import { present } from './helpers.ts';

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

/*
 * offSlot: a dev server that is up, but not on the ports this feature's slot expects.
 *
 * Discovery has always found these — discoverRunning() maps any listening socket to its
 * worktree, so a server an agent started with a bare `npm run dev` shows as running like
 * any other. What it could not say is that it is on the WRONG ports: it never read the
 * slot env, so it bound the repo's hardcoded default, and the next feature to start will
 * collide with it. start() already answers this question for launches Studio made
 * (`boundElsewhere`); this answers it for ones it merely discovered.
 */
function slottedServers() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-slot-'));
  return new Servers({
    _stateDir: stateDir,
    web: { port: 0 },
    start: { fe: { cmd: ':', ports: [] } },
    concurrency: {
      enabled: true,
      offsetStep: 100,
      maxSlots: 3,
      repos: { fe: { portEnv: { WTS_FE_PORT: 3000 } } },
    },
  });
}

test('a server on its slot ports is not flagged', () => {
  const s = slottedServers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-onslot-'));
  s.slots.set(s.featureFor(dir), 1); // slot 1 → 3100
  const d = s.decorate({ path: dir, repo: 'fe' }, new Map([[realpath(dir), { pid: 1, ports: [3100] }]]));
  assert.equal(d.running, true);
  assert.deepEqual(d.offSlot, [], 'exactly where it was supposed to be');
});

test('a server on none of its slot ports reports the ports it is actually on', () => {
  const s = slottedServers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-offslot-'));
  s.slots.set(s.featureFor(dir), 1); // slot 1 expects 3100
  // What a bare `npm run dev` produces: the repo's hardcoded default, slot ignored.
  const d = s.decorate({ path: dir, repo: 'fe' }, new Map([[realpath(dir), { pid: 1, ports: [3000] }]]));
  assert.deepEqual(d.offSlot, [3000]);
});

/*
 * Deliberately "none of them", not "any port that is not expected". A dev server
 * legitimately opens more than it was asked to — HMR and inspector sockets — and
 * flagging those would make the signal fire on every healthy server. Being on the slot
 * AT ALL is the thing that means the env was read.
 */
test('extra ports alongside the right one are not a mismatch', () => {
  const s = slottedServers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-hmr-'));
  s.slots.set(s.featureFor(dir), 1);
  const d = s.decorate(
    { path: dir, repo: 'fe' },
    new Map([[realpath(dir), { pid: 1, ports: [3100, 24678] }]]),
  );
  assert.deepEqual(d.offSlot, [], 'the HMR socket is not evidence of anything');
});

test('a repo with no concurrency mapping is never flagged — there is no slot to miss', () => {
  const s = slottedServers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-unslotted-'));
  const d = s.decorate({ path: dir, repo: 'api' }, new Map([[realpath(dir), { pid: 1, ports: [9999] }]]));
  assert.deepEqual(d.offSlot, []);
});

test('a worktree that is not running has nothing to be off-slot about', () => {
  const s = slottedServers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-down-'));
  assert.deepEqual(s.decorate({ path: dir, repo: 'fe' }, new Map()).offSlot, []);
});

/*
 * sharedModules: node_modules is a symlink OUT of the worktree.
 *
 * The cheap way to give a worktree its dependencies — the directory is gitignored, so
 * `git worktree add` cannot bring it across — and it silently un-isolates the worktree.
 * Every tool that caches inside node_modules then writes to one shared directory: two
 * Vite servers fight over `node_modules/.vite/deps`, each re-optimising what the other
 * just wrote and full-reloading the browser to recover. `npm install` on this branch
 * mutates the tree every other worktree of the repo is running against.
 *
 * Nothing looked wrong: deps resolve, the server starts, `depsMissing` is correctly
 * false. Only lstat on the directory says so, which is why this is reported and not
 * inferred.
 */
test('a worktree with its own node_modules is not flagged', () => {
  const s = servers();
  const dir = tempWorktree();
  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.equal(s.sharedModules(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('node_modules symlinked to another checkout reports the directory it really uses', () => {
  const s = servers();
  const main = tempWorktree();
  const wt = tempWorktree();
  fs.mkdirSync(path.join(main, 'node_modules'));
  fs.symlinkSync(path.join(main, 'node_modules'), path.join(wt, 'node_modules'));
  assert.equal(s.sharedModules(wt), realpath(path.join(main, 'node_modules')));
  // and it rides on the same decoration the rail already reads
  assert.equal(
    s.decorate({ path: wt, repo: 'api' }, new Map()).sharedModules,
    realpath(path.join(main, 'node_modules')),
  );
  fs.rmSync(main, { recursive: true, force: true });
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * A relative link is the form a hand-rolled worktree script actually writes
 * (`ln -s ../../node_modules`), so resolving before comparing is the whole job.
 */
test('a relative symlink out of the worktree is still shared', () => {
  const s = servers();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-rel-'));
  const wt = path.join(root, '.worktrees', 'feature');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync('../../node_modules', path.join(wt, 'node_modules'));
  assert.equal(s.sharedModules(wt), realpath(path.join(root, 'node_modules')));
  fs.rmSync(root, { recursive: true, force: true });
});

/*
 * Not every symlink is sharing. One that lands back inside the worktree isolates
 * exactly as well as a real directory, and flagging it would be a false alarm on a
 * layout that is doing nothing wrong.
 */
test('a symlink that stays inside the worktree is not sharing anything', () => {
  const s = servers();
  const wt = tempWorktree();
  fs.mkdirSync(path.join(wt, 'vendor'));
  fs.symlinkSync(path.join(wt, 'vendor'), path.join(wt, 'node_modules'));
  assert.equal(s.sharedModules(wt), null);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('no node_modules at all is depsMissing, not sharing', () => {
  const s = servers();
  const wt = tempWorktree();
  assert.equal(s.sharedModules(wt), null);
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * A dangling link resolves to nothing, and the worktree cannot run either way. It is
 * still not this signal's story to tell — reporting a target that is not there would
 * put a path on screen that explains nothing.
 */
test('a broken symlink is not reported as a shared directory', () => {
  const s = servers();
  const wt = tempWorktree();
  fs.symlinkSync(path.join(wt, 'nowhere'), path.join(wt, 'node_modules'));
  assert.equal(s.sharedModules(wt), null);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('depsMissing is true only for a package.json with no node_modules', () => {
  const s = servers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-deps-'));

  // no package.json at all — not a node project, so not our problem to flag
  assert.equal(s.depsMissing(dir), false);

  // A package that DECLARES dependencies. The fixture used to be `{"name":"x"}` — no
  // dependencies at all — which encoded the bug: npm creates no node_modules for such a
  // package, so "install your dependencies" was an instruction that could never be
  // satisfied, and the worktree was unstartable forever.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","dependencies":{"express":"^4"}}');
  assert.equal(s.depsMissing(dir), true, 'declared dependencies, no node_modules');

  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.equal(s.depsMissing(dir), false, 'once installed it is startable again');
});

test('canStart is false when the deps a start command needs are absent', () => {
  const s = servers({ start: { demo: { cmd: 'npm run dev' } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-deps2-'));
  // Declares a dependency, so npm installing it would genuinely change something.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","dependencies":{"express":"^4"}}');

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

/*
 * A spawn that never happens must be REPORTED, not thrown into the void.
 *
 * Node delivers a failed spawn — including an ENOENT for a `cwd` that no longer exists —
 * asynchronously as an 'error' event. Unhandled, that becomes an uncaughtException, and
 * crash.ts treats anything outside the connection-error codes as fatal and exits. So
 * pressing Run on a feature whose worktree had been deleted behind Studio's back took the
 * whole daemon down: every PTY, the SSE fan-out, the HTTP server.
 *
 * This was the only spawn site missing the guard that runner.ts, installDeps and hunks.ts
 * all have — the same one-rule-implemented-in-several-places drift this codebase keeps
 * producing.
 */
test('a spawn into a MISSING cwd is reported, and does not kill the process', async () => {
  const s = servers();
  const gone = tempWorktree();
  fs.rmSync(gone, { recursive: true, force: true }); // deleted behind Studio's back

  // The assertion is as much that this line RETURNS at all: before the fix the 'error'
  // event escaped as an uncaughtException and took the test runner with it.
  const r = await s.start('api', gone);

  assert.equal(r.ok, false);
  // Narrowed via `ok`: StartResult is a union, and only the failure arm carries `error`.
  assert.match(r.ok === false ? r.error || '' : '', /could not start api/);
  assert.equal(s.tracked[gone], undefined, 'a process that never existed is not tracked');
});

/*
 * Stopping one feature must never signal another feature's dev servers.
 *
 * `launchOpts` resolves `slots.get(feature) ?? 0`, conflating "has no slot" with "is at
 * slot 0". Harmless while launching (startAll allocates first), destructive while
 * stopping: a slot-less feature derived slot 0's BASE ports, and stop()'s port sweep
 * SIGTERMed whatever held them — the dev servers of whichever other feature actually had
 * slot 0 — then answered `killed: true` for stopping nothing of its own.
 */
test('a feature with NO slot claims no ports, so it cannot sweep another feature away', () => {
  const s = servers({
    concurrency: {
      enabled: true,
      offsetStep: 10,
      maxSlots: 3,
      repos: { api: { portEnv: { APP_PORT: 4100 } } },
    },
  });
  const held = tempWorktree(); // this one is running, on slot 0
  const slotless = tempWorktree(); // this one never started

  s.slots.set(s.featureFor(held), 0);
  assert.deepEqual(s._portsFor('api', held), [4100], 'the slot holder knows its own port');
  assert.deepEqual(
    s._portsFor('api', slotless),
    [],
    'no slot means no ports — guessing yields slot 0s, which belong to someone else',
  );

  for (const d of [held, slotless]) fs.rmSync(d, { recursive: true, force: true });
});

test('without concurrency, a repo still reports its configured ports', () => {
  // The non-concurrent design is unchanged: the guard above is scoped to repos that
  // concurrency actually governs, so a plain single-feature setup still stops itself.
  const s = servers({ start: { api: { cmd: ':', ports: [3000] } } });
  const wt = tempWorktree();
  assert.deepEqual(s._portsFor('api', wt), [3000]);
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * A worktree that is no longer on disk cannot start anything.
 *
 * git's `worktree list` keeps reporting a directory somebody deleted until the repo is
 * pruned, and nothing in the topology build checked for existence. depsMissing() made it
 * worse by design — its first line returns `false` when there is no package.json, which
 * for a VANISHED directory reads as "dependencies are fine". So the row rendered with
 * canStart:true and a live Run button, and pressing it spawned into a cwd that does not
 * exist: exactly the path that killed the whole daemon.
 */
test('a DELETED worktree reports gone, and cannot be started', () => {
  const s = servers();
  const wt = tempWorktree();
  fs.rmSync(wt, { recursive: true, force: true });

  const d = s.decorate({ repo: 'api', path: wt }, new Map());
  assert.equal(d.gone, true);
  assert.equal(d.canStart, false, 'a live Run button here spawns into a nonexistent cwd');
});

test('a worktree that IS on disk is unaffected', () => {
  const s = servers();
  const wt = tempWorktree();
  const d = s.decorate({ repo: 'api', path: wt }, new Map());
  assert.equal(d.gone, false);
  assert.equal(d.canStart, true, 'a configured repo with no package.json still starts');
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * "Install dependencies" must be a SATISFIABLE instruction.
 *
 * depsMissing() was exactly "package.json exists && node_modules does not" — but npm only
 * creates node_modules when there is something to install. A repo whose package.json is
 * just a name and a `start` script was therefore permanently unstartable: the stack
 * refused with "dependencies not installed", the Install button ran npm, npm reported
 * "up to date" and created nothing, and the predicate stayed true. Forever.
 */
function pkgWorktree(pkg: Record<string, unknown>): string {
  const dir = tempWorktree();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

test('a package with NO dependencies is not missing any', () => {
  const s = servers();
  const wt = pkgWorktree({ name: 'backend', scripts: { start: 'node server.js' } });
  assert.equal(s.depsMissing(wt), false, 'npm would create nothing — the ask is unsatisfiable');
  assert.equal(s.decorate({ repo: 'api', path: wt }, new Map()).canStart, true);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('a package that DECLARES dependencies still reports them missing', () => {
  const s = servers();
  const wt = pkgWorktree({ name: 'backend', dependencies: { express: '^4' } });
  assert.equal(s.depsMissing(wt), true, 'this one npm really can fix');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('devDependencies count too — a build step is a dependency', () => {
  const s = servers();
  const wt = pkgWorktree({ name: 'fe', devDependencies: { vite: '^5' } });
  assert.equal(s.depsMissing(wt), true);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('an installed worktree is satisfied whatever it declares', () => {
  const s = servers();
  const wt = pkgWorktree({ name: 'backend', dependencies: { express: '^4' } });
  fs.mkdirSync(path.join(wt, 'node_modules'));
  assert.equal(s.depsMissing(wt), false);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('an unparseable package.json does not block the start', () => {
  // Refusing to launch over a JSON syntax error would be a confusing place to learn it.
  const s = servers();
  const wt = tempWorktree();
  fs.writeFileSync(path.join(wt, 'package.json'), '{ not json');
  assert.equal(s.depsMissing(wt), false);
  fs.rmSync(wt, { recursive: true, force: true });
});

/*
 * Two worktrees of one feature share a basename — that is what makes them one feature.
 *
 * The install log was named `install__${basename}`, so installing both halves of a
 * multi-repo stack (one click per member, and the UI offers them together) pointed two
 * concurrent npm runs at the SAME file. Their output interleaved, and either one's
 * trimLog could truncate the other's. The log is the only place a failed install says
 * why it failed, and it was the one thing being scrambled.
 */
test('two worktrees with the same name install into separate logs', async () => {
  const s = servers();
  const feature = 'checkout-v2';
  const dirs = ['api', 'fe'].map((repo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `wts-${repo}-`));
    const wt = path.join(root, '.worktrees', feature);
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'package.json'), JSON.stringify({ name: repo, version: '1.0.0' }));
    return { root, wt };
  });

  // Concurrently, because that is how the two halves of a stack are installed.
  const [a, b] = await Promise.all(dirs.map((d) => s.installDeps(d.wt)));
  const logA = present(a.log, "the first install's log");
  const logB = present(b.log, "the second install's log");
  assert.notEqual(logA, logB, 'one file per worktree, not one per worktree NAME');

  // Each log is about its own install and nothing else — the header start() writes names
  // the worktree, so a shared file shows up as both paths in one of them.
  assert.ok(fs.readFileSync(logA, 'utf8').includes(dirs[0].wt));
  assert.ok(!fs.readFileSync(logA, 'utf8').includes(dirs[1].wt), 'no output from the other install');
  assert.ok(fs.readFileSync(logB, 'utf8').includes(dirs[1].wt));

  for (const d of dirs) fs.rmSync(d.root, { recursive: true, force: true });
});
