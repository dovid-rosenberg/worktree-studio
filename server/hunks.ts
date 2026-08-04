// Hunk-level staging for the working tree, on top of the pure model in ./diff.ts.
// Coexists with (does not replace) the file-level staging in review.commit().
//
// The one decision that makes this correct: hunks are taken from the diffs whose
// pre-image is the thing we're about to modify — the INDEX.
//   stage   → `git diff` (index → worktree), applied with `git apply --cached`
//   unstage → `git diff --cached` (HEAD → index), applied with `--cached --reverse`
// Diffing against HEAD instead would break the moment a file is partially staged: the
// patch wouldn't match the index and git apply would (rightly) refuse. Taking the
// index as the pre-image makes the partially-staged case just work, and is exactly
// what `git add -p` / `git reset -p` do.
import { spawn } from 'child_process';
import { git, gitFull, type RunResult } from './util.ts';
import { parsePatch, formatFilePatch } from './diff.ts';
import type { DiffFile } from './types.ts';

// What a stdin-fed `git apply` can report back: run()'s result minus the parts only
// execFile knows about.
type ApplyResult = Pick<RunResult, 'code' | 'stdout' | 'stderr'>;

/** Both sides of one working file, as fileHunks() hands them back. */
export interface FileHunks {
  file: string;
  untracked: boolean;
  unstaged: DiffFile | null;
  staged: DiffFile | null;
}

/** Which hunks a request is acting on. Indexes arrive from the wire, so a string
 *  index is as ordinary as a number one. */
type HunkSelection = number | string | Array<number | string>;

export interface HunkApplyOptions {
  /** repo-relative path */
  file?: string;
  /** index(es) into that file's diff */
  hunks?: HunkSelection;
  /** true unstages instead of staging */
  reverse?: boolean;
  /** the `@@` header(s) the caller rendered */
  expect?: string | string[];
}

export type HunkApplyResult = { ok: false; error: string } | ({ ok: true; hunks: number[] } & FileHunks);

// Canonical diff flags: force `a/`+`b/` prefixes and plain output so neither the user's
// global git config (diff.mnemonicPrefix gives `c/`+`w/`, diff.noprefix gives none) nor
// an external difftool can change the bytes we parse and hand back to git apply.
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-U3'];

// git apply reads the patch on stdin — nothing hits the disk, and a patch that would
// half-apply never gets written anywhere. util.run() can't feed stdin, hence spawn.
function gitApply(cwd: string, args: string[], patch: string): Promise<ApplyResult> {
  return new Promise((resolve) => {
    const p = spawn('git', ['-C', cwd, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => {
      stdout += d;
    });
    p.stderr.on('data', (d) => {
      stderr += d;
    });
    p.on('error', (e) => resolve({ code: 1, stdout, stderr: e.message }));
    p.on('close', (code) => resolve({ code: code === null ? 1 : code, stdout, stderr }));
    p.stdin.on('error', () => {
      /* git exited before reading the patch; `close` reports it */
    });
    p.stdin.end(patch);
  });
}

// Unstaged changes for one file: index → worktree. An untracked file has no index entry,
// so synthesize the /dev/null → file patch git itself would produce for `git add -N`;
// `git apply --cached` on it creates the blob + index entry, i.e. stages exactly the
// selected lines of a brand-new file.
async function unstagedDiff(worktreePath: string, file: string): Promise<string> {
  const r = await gitFull(worktreePath, ['diff', ...DIFF_FLAGS, '--', file]);
  if (r.stdout) return r.stdout;
  const st = await git(worktreePath, ['status', '--porcelain', '--', file]);
  if (st.startsWith('??')) {
    return (await gitFull(worktreePath, ['diff', '--no-index', ...DIFF_FLAGS, '--', '/dev/null', file]))
      .stdout;
  }
  return '';
}

// Staged changes for one file: HEAD → index.
async function stagedDiff(worktreePath: string, file: string): Promise<string> {
  return (await gitFull(worktreePath, ['diff', '--cached', ...DIFF_FLAGS, '--', file])).stdout;
}

function parseOne(patch: string, file: string): DiffFile | null {
  const files = parsePatch(patch);
  if (!files.length) return null;
  // Match on path so a rename (old ≠ new name) resolves from either side; a single-file
  // diff that somehow disagrees still resolves to its only entry.
  return (
    files.find((f) => f.path === file || f.oldPath === file || f.newPath === file) ||
    (files.length === 1 ? files[0] : null)
  );
}

// fileHunks(worktreePath, file) → both sides of one working file, structured.
// `unstaged` is what can be staged, `staged` is what can be unstaged; hunk indexes in
// stage()/unstage() refer to the matching side.
async function fileHunks(worktreePath: string, file: string): Promise<FileHunks> {
  const [unstagedRaw, stagedRaw] = await Promise.all([
    unstagedDiff(worktreePath, file),
    stagedDiff(worktreePath, file),
  ]);
  const porcelain = await git(worktreePath, ['status', '--porcelain', '--', file]);
  return {
    file,
    untracked: porcelain.startsWith('??'),
    unstaged: unstagedRaw ? parseOne(unstagedRaw, file) : null,
    staged: stagedRaw ? parseOne(stagedRaw, file) : null,
  };
}

// Why a hunk can't be staged as a patch. Returned as a plain message so the caller can
// point the user at file-level staging, which handles all of these.
function unstageableReason(fd: DiffFile, scope: string): string | null {
  if (fd.binary) return 'binary file — stage or unstage the whole file instead';
  if (fd.unsupported === 'combined') return 'combined (merge) diff — hunk staging is not supported';
  if (fd.modeOnly) return 'mode-only change — stage or unstage the whole file instead';
  if (!fd.hunks.length) return `no hunks in the ${scope} diff for this file`;
  return null;
}

// apply(worktreePath, { file, hunks, reverse, expect }) → { ok, staged|unstaged, error }.
//
// `expect` (optional) is the `@@` header the caller believes each selected hunk has. The
// diff is re-read here, so between the client rendering it and this call the file may
// have moved under us; without the guard a stale index would silently stage the WRONG
// hunk. With it we refuse and tell the caller to reload.
async function apply(
  worktreePath: string,
  { file, hunks, reverse = false, expect }: HunkApplyOptions = {},
): Promise<HunkApplyResult> {
  if (!file) return { ok: false, error: 'file is required' };
  const scope = reverse ? 'staged' : 'unstaged';
  const raw = reverse ? await stagedDiff(worktreePath, file) : await unstagedDiff(worktreePath, file);
  const fd = raw ? parseOne(raw, file) : null;
  if (!fd) return { ok: false, error: `no ${scope} changes for this file` };
  const why = unstageableReason(fd, scope);
  if (why) return { ok: false, error: why };

  const list = (Array.isArray(hunks) ? hunks : [hunks]).map((n) =>
    typeof n === 'number' ? n : parseInt(String(n), 10),
  );
  if (!list.length || list.some((n) => !Number.isInteger(n) || n < 0 || n >= fd.hunks.length)) {
    return { ok: false, error: `hunks must be indexes into the ${scope} diff (0…${fd.hunks.length - 1})` };
  }
  if (Array.isArray(expect)) {
    for (let i = 0; i < list.length; i++) {
      const want = expect[i];
      if (want && fd.hunks[list[i]].header !== want) {
        return { ok: false, error: 'the diff changed since it was loaded — reload and try again' };
      }
    }
  }

  const patch = formatFilePatch(fd, list, { reverse });
  // --check first: git apply is not atomic across files, and a patch that only partly
  // applies leaves the index in a state nobody asked for. Refuse instead of half-doing it.
  const args = ['apply', '--cached', '--whitespace=nowarn', ...(reverse ? ['--reverse'] : [])];
  const check = await gitApply(worktreePath, [...args, '--check'], patch);
  if (check.code !== 0)
    return { ok: false, error: (check.stderr || check.stdout).trim() || 'patch does not apply' };
  const done = await gitApply(worktreePath, args, patch);
  if (done.code !== 0) return { ok: false, error: (done.stderr || done.stdout).trim() || 'git apply failed' };
  return { ok: true, hunks: list, ...(await fileHunks(worktreePath, file)) };
}

const stage = (worktreePath: string, opts: HunkApplyOptions) =>
  apply(worktreePath, { ...opts, reverse: false });
const unstage = (worktreePath: string, opts: HunkApplyOptions) =>
  apply(worktreePath, { ...opts, reverse: true });

export { fileHunks, stage, unstage, apply, unstagedDiff, stagedDiff, DIFF_FLAGS };
