/*
 * Finite commands — tests, builds, lints — with their output, exit code and history.
 *
 * A task used to open a tmux tab. That works, but it makes you read raw ANSI in a pane
 * competing with your agent's tabs, and it answers none of the questions you actually
 * have about a test run: did it pass, how long did it take, what did the last one do.
 * tmux is the right substrate for a CONVERSATION; it is the wrong surface for a job.
 *
 * So a run is a tracked thing: it has a status, a duration, an exit code, a log, and it
 * outlives itself as history.
 *
 * DELIBERATELY NOT server/servers.ts. A dev server and a test run look alike for exactly
 * one moment — the spawn — and differ in every way after it. A server is a singleton per
 * worktree that should stay up, whose absence is a problem and whose exit is a crash; a
 * run is one of many, is expected to end, and its exit code is the whole point. Sharing
 * the module would mean every field meaning two things.
 */
import { type ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { CHILD_ENV, makeId, readJsonState, slug, writeJson } from './util.ts';
import { tailFile } from './log-tail.ts';
import type { LogTail } from './log-tail.ts';

const ENV = CHILD_ENV;

/** How many finished runs to keep. History is for "what did the last one say", not an archive. */
const KEEP_RUNS = 60;

export type RunStatus = 'running' | 'passed' | 'failed' | 'stopped';

export interface Run {
  id: string;
  /** The run configuration's name. */
  name: string;
  repo: string;
  worktreePath: string;
  cmd: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** Null while running, and for a run killed before it could report one. */
  exitCode?: number | null;
  log: string;
  /**
   * The env the configuration declared, kept so a RERUN is the same run.
   *
   * Without it a rerun silently drops `NODE_ENV=test` from a mocha config and the suite
   * runs against the wrong environment — passing or failing for a reason that has nothing
   * to do with the code.
   */
  env?: Record<string, string>;
  /** Absent after a daemon restart — a pid from a previous process is not ours to signal. */
  pid?: number;
}

interface Saved {
  runs?: Run[];
}

/** A run as it is read back from disk: it may predate any field added since. */
const isFinished = (r: Run): boolean => r.status !== 'running';

export class Runner extends EventEmitter {
  logDir: string;
  file: string;
  runs: Run[];
  /** Live children, by run id. Never persisted: a child cannot outlive the process that spawned it. */
  #children = new Map<string, ChildProcess>();

  constructor(stateDir: string) {
    super();
    this.logDir = path.join(stateDir, 'runs');
    this.file = path.join(stateDir, 'runs.json');
    fs.mkdirSync(this.logDir, { recursive: true });
    const saved = readJsonState<Saved>(this.file, {});
    /*
     * A run recorded as `running` when the daemon died did not survive it — the child was
     * detached from a process that is gone, and nothing is left to report its exit. It is
     * marked interrupted at load rather than left claiming to be in progress forever.
     */
    this.runs = (saved.runs || []).map((r) =>
      r.status === 'running'
        ? { ...r, status: 'stopped' as const, endedAt: r.endedAt ?? Date.now(), pid: undefined }
        : r,
    );
  }

  #save(): void {
    writeJson(this.file, { runs: this.runs.slice(0, KEEP_RUNS) });
  }

  #changed(): void {
    this.#save();
    this.emit('change');
  }

  /** Every run for a worktree, newest first. */
  forWorktree(worktreePath: string): Run[] {
    return this.runs.filter((r) => r.worktreePath === worktreePath);
  }

  get(id: string): Run | undefined {
    return this.runs.find((r) => r.id === id);
  }

  /**
   * Start a command and track it to completion.
   *
   * `detached` so it gets its own process group: a test runner spawns children, and
   * stopping the run has to take the whole tree rather than orphan it.
   */
  start(opts: {
    name: string;
    repo: string;
    worktreePath: string;
    cmd: string;
    env?: Record<string, string>;
  }): Run {
    const id = makeId('r_');
    const log = path.join(this.logDir, `${slug(`${opts.repo}-${opts.name}`, 40)}-${id}.log`);
    const run: Run = {
      id,
      name: opts.name,
      repo: opts.repo,
      worktreePath: opts.worktreePath,
      cmd: opts.cmd,
      status: 'running',
      startedAt: Date.now(),
      log,
      env: opts.env && Object.keys(opts.env).length ? opts.env : undefined,
    };

    const fd = fs.openSync(log, 'a');
    let child: ChildProcess;
    try {
      fs.writeSync(fd, `===== ${new Date().toISOString()} :: ${opts.cmd} @ ${opts.worktreePath} =====\n`);
      child = spawn('bash', ['-lc', opts.cmd], {
        cwd: opts.worktreePath,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...ENV, ...(opts.env || {}) },
      });
    } finally {
      // spawn() dups this into the child synchronously, so the parent's copy is dead
      // weight the moment it returns — and the daemon outlives every run it starts.
      fs.closeSync(fd);
    }

    run.pid = child.pid;
    this.#children.set(id, child);
    this.runs.unshift(run);
    // Keep the list bounded here as well as on save, so a long-lived daemon does not grow
    // an unbounded array in memory between writes.
    if (this.runs.length > KEEP_RUNS) this.runs.length = KEEP_RUNS;

    child.once('error', (e) => this.#finish(id, null, `failed to start: ${e.message}`));
    child.once('exit', (code, signal) => {
      // A signalled exit is a stop, not a failure — `code` is null in that case.
      this.#finish(id, code, signal ? `signalled: ${signal}` : undefined, !!signal);
    });

    this.#changed();
    return run;
  }

  #finish(id: string, code: number | null, note?: string, signalled = false): void {
    const run = this.get(id);
    if (!run || isFinished(run)) return;
    this.#children.delete(id);
    run.endedAt = Date.now();
    run.exitCode = code;
    run.pid = undefined;
    run.status = signalled ? 'stopped' : code === 0 ? 'passed' : 'failed';
    if (note) {
      try {
        fs.appendFileSync(run.log, `\n===== ${note} =====\n`);
      } catch {
        /* the outcome matters more than the note */
      }
    }
    this.#changed();
  }

  /**
   * Run the same thing again.
   *
   * Re-executes the RECORDED command rather than re-resolving the configuration by name.
   * A history row says "run that again", and that is what it does: it cannot fail because
   * the configuration was renamed or deleted since, and it cannot quietly run something
   * different because the file changed. Use ▷ Run for whatever the config says today —
   * that menu re-reads the file every time it opens.
   */
  rerun(id: string): { ok: boolean; error?: string; run?: Run } {
    const prev = this.get(id);
    if (!prev) return { ok: false, error: 'no such run' };
    const run = this.start({
      name: prev.name,
      repo: prev.repo,
      worktreePath: prev.worktreePath,
      cmd: prev.cmd,
      env: prev.env,
    });
    return { ok: true, run };
  }

  /** Stop a running run, taking its whole process group with it. */
  stop(id: string): { ok: boolean; error?: string } {
    const run = this.get(id);
    if (!run) return { ok: false, error: 'no such run' };
    if (isFinished(run)) return { ok: true };
    const child = this.#children.get(id);
    const pid = child?.pid ?? run.pid;
    if (!pid) {
      // Nothing left to signal — from before a restart. Record the truth rather than
      // leaving it claiming to run.
      this.#finish(id, null, 'stopped', true);
      return { ok: true };
    }
    // The GROUP: a test runner's children would otherwise outlive it.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone; the exit handler will finish it */
      }
    }
    return { ok: true };
  }

  /**
   * Incremental log tail, guarded to this runner's own log files.
   *
   * Same contract as Servers.logs — and now literally the same code, which is what that
   * sentence used to claim without it being true. The three ways it differed:
   *
   *   ROTATION, handled the opposite way. `offset > size` means the file shrank, so the
   *   read should restart from the beginning; this clamped `from` to `size` instead, so
   *   `from >= size` held and it returned an empty tail on EVERY subsequent poll. A run
   *   whose log rotated simply stopped updating in the Runs panel, permanently.
   *
   *   UTF-8. It sliced at a raw byte offset, so a multi-byte character straddling the
   *   window rendered as a replacement char. Servers drops the clipped first line, which
   *   disposes of exactly that.
   *
   *   `skipped` was absent, so a client could not tell a quiet log from one it had
   *   fallen behind.
   */
  logs(id: string, opts: { offset?: number; lines?: number } = {}): LogTail {
    return tailFile(this.get(id)?.log, opts);
  }

  /** Forget a finished run and its log. A running one is left alone. */
  remove(id: string): { ok: boolean; error?: string } {
    const run = this.get(id);
    if (!run) return { ok: false, error: 'no such run' };
    if (!isFinished(run)) return { ok: false, error: 'still running — stop it first' };
    this.runs = this.runs.filter((r) => r.id !== id);
    try {
      fs.rmSync(run.log, { force: true });
    } catch {
      /* the record going is what matters */
    }
    this.#changed();
    return { ok: true };
  }
}
