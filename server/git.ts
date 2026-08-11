// Discover git repos under the configured base dirs, and describe each repo's
// worktrees (branch, head, merged-into-default).
import fs from 'fs';
import path from 'path';
import { git, gitFull } from './util.ts';

/** One `git worktree list --porcelain` record, as parsed and before it is decorated. */
export interface PorcelainWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

/** The same record once describeRepo() has added what only the repo around it knows. */
export interface RepoWorktree extends PorcelainWorktree {
  isMain: boolean;
  name: string;
  merged: boolean;
  ahead: number;
}

export interface ScannedRepo {
  name: string;
  path: string;
  defaultBranch: string;
  defaultHead: string;
  worktrees: RepoWorktree[];
}

// Walk baseDirs up to `depth` looking for directories that contain a .git.
// Returns both the repos found and the plain container directories the walk passed
// through — those are exactly the places a *new* repo can show up, which is what
// the filesystem watcher (server/watch.ts) needs to arm itself on.
// A linked worktree also has a `.git` — a FILE reading `gitdir: …/.git/worktrees/<name>`
// rather than a directory. It is not a repo of its own; it is already reported by
// `git worktree list` in the repo it belongs to. The nested layout hides worktrees
// behind a dot-dir the walk skips anyway, but the sibling/external layouts put them
// where the walk will find them, and listing one as a separate repo would double it
// in the UI (and give it a main checkout it doesn't have).
function isLinkedWorktree(dir: string): boolean {
  const dotgit = path.join(dir, '.git');
  try {
    if (fs.statSync(dotgit).isDirectory()) return false;
    return /^gitdir:.*[/\\]worktrees[/\\]/.test(fs.readFileSync(dotgit, 'utf8').trim());
  } catch {
    return false;
  }
}

function walkTree(baseDirs: string[], depth: number): { repos: string[]; dirs: string[] } {
  const repos: string[] = [];
  const dirs: string[] = [];
  const seen = new Set<string>();
  function walk(dir: string, d: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (fs.existsSync(path.join(dir, '.git'))) {
      if (isLinkedWorktree(dir)) return; // not a repo — its main checkout reports it
      const real = fs.realpathSync(dir);
      if (!seen.has(real)) {
        seen.add(real);
        repos.push(dir);
      }
      return; // don't descend into a repo (its worktrees handled via git)
    }
    dirs.push(dir);
    if (d <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), d - 1);
    }
  }
  for (const base of baseDirs) walk(base, depth);
  return { repos, dirs };
}

function findRepos(baseDirs: string[], depth: number): string[] {
  return walkTree(baseDirs, depth).repos;
}

function parseWorktrees(porcelain: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = [];
  let cur: PorcelainWorktree | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false };
    } else if (line.startsWith('HEAD ')) {
      if (cur) cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      if (cur) cur.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'detached') {
      if (cur) cur.detached = true;
    } else if (line === 'bare') {
      if (cur) cur.bare = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** One line of `git status --porcelain`, split into the two things a caller can use. */
export interface PorcelainEntry {
  /**
   * The two-character status field exactly as git wrote it — index column then worktree
   * column, e.g. ' M', 'M ', 'A ', '??', 'RM'. Kept verbatim so a caller can ask its own
   * question of it rather than having this parser guess which distinction matters.
   */
  status: string;
  /** The path, unquoted and unescaped. For a rename or copy this is the DESTINATION. */
  path: string;
  /** Where a rename or copy came from. Absent for every other status. */
  from?: string;
}

/**
 * Undo git's C-style quoting of a path.
 *
 * git wraps a path in double quotes and escapes it the moment it contains anything
 * awkward — a space, a control character, or (with the default core.quotePath) any byte
 * outside ASCII, which arrives as three-digit OCTAL escapes of the UTF-8 bytes. Decoding
 * has to go through bytes for that reason: "\303\274" is one character, ü, not two.
 */
function unquotePath(field: string): string {
  if (!field.startsWith('"') || !field.endsWith('"') || field.length < 2) return field;
  const body = field.slice(1, -1);
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
    '\\': 92,
    '"': 34,
  };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else if (next in simple) {
      bytes.push(simple[next]);
    } else {
      for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Split `old -> new` without being fooled by an arrow INSIDE a quoted path.
 *
 * A path is only left unquoted when it holds nothing special, and " -> " holds spaces —
 * so an unquoted first field cannot contain the separator, and a quoted one is bounded by
 * its own closing quote. Reading the first field to its end and only then looking for the
 * arrow is what keeps a file literally named `a -> b` from being read as a rename.
 */
function splitRename(rest: string): { path: string; from?: string } {
  let end: number;
  if (rest.startsWith('"')) {
    end = 1;
    while (end < rest.length && rest[end] !== '"') end += rest[end] === '\\' ? 2 : 1;
    end++;
  } else {
    const arrow = rest.indexOf(' -> ');
    end = arrow === -1 ? rest.length : arrow;
  }
  const tail = rest.slice(end);
  if (!tail.startsWith(' -> ')) return { path: unquotePath(rest) };
  return { from: unquotePath(rest.slice(0, end)), path: unquotePath(tail.slice(4)) };
}

/**
 * Parse `git status --porcelain` (v1) output.
 *
 * This exists because the same parse was written three times with three different
 * contracts — one stripped the status prefix, one did not, and a third stripped it a
 * SECOND time off an already-stripped line. That third one was a guard against stashing
 * away a sibling worktree, and comparing `rktrees/foo` against `.worktrees/` meant it
 * could never fire. One parser, one contract: status and path, both honest.
 */
export function parsePorcelain(stdout: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  for (const line of stdout.split('\n')) {
    // Every record is `XY<space><path>`; anything shorter is not one.
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    // Only R and C carry a source; for every other status an arrow is part of the name.
    const paths =
      status.startsWith('R') || status.startsWith('C') ? splitRename(rest) : { path: unquotePath(rest) };
    out.push({ status, ...paths });
  }
  return out;
}

/**
 * What `git status` says about a repo, parsed.
 *
 * `untracked: false` passes `--untracked-files=no`, which is a genuinely different
 * question rather than a filter over the same answer: a checkout carries untracked files
 * across a branch switch unharmed, so a caller deciding whether a switch is safe must not
 * see them, while a caller deciding what a stash would sweep up must.
 */
export async function porcelainStatus(
  repoPath: string,
  { untracked = true }: { untracked?: boolean } = {},
): Promise<PorcelainEntry[]> {
  const r = await gitFull(repoPath, [
    'status',
    '--porcelain',
    ...(untracked ? [] : ['--untracked-files=no']),
  ]);
  return r.code === 0 ? parsePorcelain(r.stdout) : [];
}

/*
 * "What is this repo's default branch" — asked THREE ways, answered three ways.
 *
 * The same `symbolic-ref refs/remotes/origin/HEAD` lookup was written here, in
 * worktree.defaultBase() and in checkout.defaultBranchOf(), and the three disagreed on
 * both the `origin/` prefix and the fallback. For a repo with no `origin/HEAD`, git.ts
 * reported the current branch (or literally 'main') while checkout.ts reported '' — two
 * answers to one question, in one process, about one repo. review.base() computes the
 * diff baseline from whatever it is handed, so the day a caller picks the other one it
 * silently shows the wrong diff.
 *
 * One lookup now, in three named forms, because the three CALLERS genuinely differ:
 *
 *   originHead()      — the raw truth, '' when there is none. For code that must be able
 *                       to tell "no default branch" from a guess (checkout.ts refuses to
 *                       switch rather than switching to something invented).
 *   defaultBranch()   — a bare branch name, guessed if need be. For display and diffs.
 *   defaultBase()     — keeps `origin/`, so a new worktree branches off the REMOTE tip
 *                       rather than a stale local copy. That prefix is the whole point.
 */
async function originHead(repoPath: string): Promise<string> {
  return git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
}

/**
 * The branch a checkout is actually on, or null when it is detached.
 *
 * `HEAD` is what git says when there is NO branch, not the name of one. A detached
 * checkout — during a bisect, or after checking out a tag — returns the literal string
 * "HEAD", and every caller that took it at face value carried it somewhere it did real
 * damage: `review.base()` resolved it to the current commit, so a branch's own commits
 * diffed against themselves and the Changes pane showed nothing, explaining nothing.
 * Null is the honest answer, and it makes each caller state its own fallback.
 */
async function currentBranch(repoPath: string): Promise<string | null> {
  const cur = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur && cur !== 'HEAD' ? cur : null;
}

/** The current branch, or 'main' — the shared fallback when `origin/HEAD` is absent. */
async function guessDefault(repoPath: string): Promise<string> {
  // 'main' is a guess, but it is a guess about a BRANCH, which is the kind of thing the
  // caller asked for.
  return (await currentBranch(repoPath)) ?? 'main';
}

async function defaultBranch(repoPath: string): Promise<string> {
  const sym = await originHead(repoPath);
  return sym ? sym.replace(/^origin\//, '') : guessDefault(repoPath);
}

/** Like defaultBranch, but KEEPS `origin/` — a start point, not a name. */
async function defaultBase(repoPath: string): Promise<string> {
  const sym = await originHead(repoPath);
  return sym || guessDefault(repoPath);
}

async function describeRepo(repoPath: string): Promise<ScannedRepo> {
  const name = path.basename(repoPath);
  const def = await defaultBranch(repoPath);
  const defHead =
    (await git(repoPath, ['rev-parse', `refs/heads/${def}`])) ||
    (await git(repoPath, ['rev-parse', `origin/${def}`])) ||
    '';
  const porcelain = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const parsed = parseWorktrees(porcelain);
  const worktrees: RepoWorktree[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const w = parsed[i];
    const isMain = i === 0;
    let merged = false;
    // merged = the branch's commits are all in the default branch AND it isn't
    // simply a fresh branch sitting at the base (head === defHead → new, not merged)
    if (!isMain && w.head && defHead && !w.detached && w.head !== defHead) {
      const anc = await gitFull(repoPath, ['merge-base', '--is-ancestor', w.head, defHead]);
      merged = anc.code === 0;
    }
    worktrees.push({ ...w, isMain, name: path.basename(w.path), merged, ahead: 0 });
  }
  return { name, path: repoPath, defaultBranch: def, defaultHead: defHead, worktrees };
}

async function scan(baseDirs: string[], depth: number): Promise<ScannedRepo[]> {
  const repoPaths = findRepos(baseDirs, depth);
  const repos: ScannedRepo[] = [];
  for (const p of repoPaths) {
    try {
      repos.push(await describeRepo(p));
    } catch {
      /* skip unreadable */
    }
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

export {
  scan,
  findRepos,
  walkTree,
  currentBranch,
  originHead,
  defaultBranch,
  defaultBase,
  parseWorktrees,
  isLinkedWorktree,
};
