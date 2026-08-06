// Finite command runs: status, exit code, output, history.
//
// Real processes, not stubs — the whole point of this module is what a command's exit
// actually reports, and a fake exit tests the fake.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Runner } from '../server/runner.ts';

function runner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-runner-'));
  return { r: new Runner(dir), dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Wait for a run to leave `running`, or give up. */
async function settled(r: Runner, id: string, ms = 10000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (r.get(id)?.status !== 'running') return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${id} never finished`);
}

test('a command that succeeds is passed, with exit 0 and its output', async () => {
  const { r, dir, cleanup } = runner();
  const run = r.start({ name: 'ok', repo: 'api', worktreePath: dir, cmd: 'echo hello' });
  assert.equal(run.status, 'running');

  await settled(r, run.id);
  const done = r.get(run.id)!;
  assert.equal(done.status, 'passed');
  assert.equal(done.exitCode, 0);
  assert.ok((done.endedAt ?? 0) >= done.startedAt);
  assert.match(r.logs(run.id).text, /hello/);
  cleanup();
});

test('a NON-ZERO exit is failed, and the code is kept — it is the whole point', async () => {
  const { r, dir, cleanup } = runner();
  const run = r.start({ name: 'nope', repo: 'api', worktreePath: dir, cmd: 'exit 3' });
  await settled(r, run.id);

  const done = r.get(run.id)!;
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 3);
  cleanup();
});

test('stderr is captured too — a failure usually says why there', async () => {
  const { r, dir, cleanup } = runner();
  const run = r.start({ name: 'err', repo: 'api', worktreePath: dir, cmd: 'echo boom >&2; exit 1' });
  await settled(r, run.id);

  assert.match(r.logs(run.id).text, /boom/);
  assert.equal(r.get(run.id)?.status, 'failed');
  cleanup();
});

test('the command runs IN the worktree, and gets the env the config declared', async () => {
  const { r, dir, cleanup } = runner();
  const run = r.start({
    name: 'ctx',
    repo: 'api',
    worktreePath: dir,
    cmd: 'pwd; echo "env=$WTS_TEST"',
    env: { WTS_TEST: 'yes' },
  });
  await settled(r, run.id);

  const text = r.logs(run.id).text;
  assert.match(text, /env=yes/);
  // macOS resolves /var → /private/var, so compare the basename rather than the path.
  assert.match(text, new RegExp(path.basename(dir)));
  cleanup();
});

test('a stopped run is `stopped`, not `failed` — it did not fail, it was interrupted', async () => {
  const { r, dir, cleanup } = runner();
  const run = r.start({ name: 'sleeper', repo: 'api', worktreePath: dir, cmd: 'sleep 30' });
  // Give the shell a moment to exec, so there is a process group to signal.
  await new Promise((res) => setTimeout(res, 300));

  assert.equal(r.stop(run.id).ok, true);
  await settled(r, run.id);
  assert.equal(r.get(run.id)?.status, 'stopped');
  cleanup();
});

test('stopping takes the whole process group, so children do not outlive the run', async () => {
  const { r, dir, cleanup } = runner();
  const marker = path.join(dir, 'child-still-alive');
  // A child that outlives its parent would go on to write the marker.
  const run = r.start({
    name: 'tree',
    repo: 'api',
    worktreePath: dir,
    cmd: `bash -c 'sleep 2; touch ${JSON.stringify(marker)}' & wait`,
  });
  await new Promise((res) => setTimeout(res, 400));
  r.stop(run.id);
  await settled(r, run.id);
  // Past when the orphan would have fired.
  await new Promise((res) => setTimeout(res, 2200));

  assert.equal(fs.existsSync(marker), false, 'the child was killed with its group');
  cleanup();
});

test('the log tail is incremental — an offset returns only what arrived after it', async () => {
  const { r, dir, cleanup } = runner();
  const run = r.start({ name: 'two', repo: 'api', worktreePath: dir, cmd: 'echo first; echo second' });
  await settled(r, run.id);

  const all = r.logs(run.id);
  assert.match(all.text, /first/);
  const after = r.logs(run.id, { offset: all.offset });
  assert.equal(after.text, '', 'nothing new since the last read');
  cleanup();
});

test('history is newest first, and scoped to a worktree', async () => {
  const { r, dir, cleanup } = runner();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wts-other-'));
  const a = r.start({ name: 'a', repo: 'api', worktreePath: dir, cmd: 'true' });
  const b = r.start({ name: 'b', repo: 'api', worktreePath: dir, cmd: 'true' });
  r.start({ name: 'elsewhere', repo: 'web', worktreePath: other, cmd: 'true' });
  await settled(r, a.id);
  await settled(r, b.id);

  const mine = r.forWorktree(dir).map((x) => x.name);
  assert.deepEqual(mine, ['b', 'a'], 'newest first');
  assert.ok(!mine.includes('elsewhere'));
  fs.rmSync(other, { recursive: true, force: true });
  cleanup();
});

test('a run left `running` by a daemon that died is marked stopped, not left in progress', async () => {
  const { r, dir, cleanup } = runner();
  const run = r.start({ name: 'orphan', repo: 'api', worktreePath: dir, cmd: 'sleep 30' });
  r.stop(run.id);
  await settled(r, run.id);

  // Rewrite the record as a crashed daemon would have left it, then reload.
  const file = path.join(dir, 'runs.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.runs[0].status = 'running';
  delete saved.runs[0].endedAt;
  fs.writeFileSync(file, JSON.stringify(saved));

  const reloaded = new Runner(dir);
  const back = reloaded.get(run.id)!;
  assert.equal(back.status, 'stopped', 'nothing is left claiming to be in progress');
  assert.ok(back.endedAt, 'and it is given an end time');
  cleanup();
});

test('a finished run can be forgotten; a running one refuses', async () => {
  const { r, dir, cleanup } = runner();
  const live = r.start({ name: 'live', repo: 'api', worktreePath: dir, cmd: 'sleep 30' });
  assert.equal(r.remove(live.id).ok, false, 'stop it first');

  r.stop(live.id);
  await settled(r, live.id);
  const log = r.get(live.id)!.log;
  assert.equal(r.remove(live.id).ok, true);
  assert.equal(r.get(live.id), undefined);
  assert.equal(fs.existsSync(log), false, 'its log goes with it');
  cleanup();
});

test('rerun repeats the recorded command, ENV included', async () => {
  /*
   * The env is the part that would go missing quietly. A mocha config carries
   * NODE_ENV=test; a rerun that dropped it would run the suite against the wrong
   * environment and pass or fail for a reason unrelated to the code.
   */
  const { r, dir, cleanup } = runner();
  const first = r.start({
    name: 'unit',
    repo: 'api',
    worktreePath: dir,
    cmd: 'echo "env=$WTS_MODE"',
    env: { WTS_MODE: 'test' },
  });
  await settled(r, first.id);

  const again = r.rerun(first.id);
  assert.equal(again.ok, true);
  await settled(r, again.run!.id);

  assert.notEqual(again.run!.id, first.id, 'a rerun is a new run, not a mutation of the old one');
  assert.equal(again.run!.name, 'unit');
  assert.equal(again.run!.cmd, first.cmd);
  assert.match(r.logs(again.run!.id).text, /env=test/, 'the env came with it');
  cleanup();
});

test('rerun works on a run whose configuration no longer exists', async () => {
  // The reason it re-executes the RECORDED command rather than re-resolving by name: a
  // history row should keep working after the config is renamed or deleted.
  const { r, dir, cleanup } = runner();
  const first = r.start({ name: 'gone-from-the-editor', repo: 'api', worktreePath: dir, cmd: 'true' });
  await settled(r, first.id);

  const again = r.rerun(first.id);
  await settled(r, again.run!.id);
  assert.equal(r.get(again.run!.id)?.status, 'passed');
  cleanup();
});

test('rerunning something unknown is refused, not guessed at', () => {
  const { r, cleanup } = runner();
  assert.equal(r.rerun('r_nope').ok, false);
  cleanup();
});
