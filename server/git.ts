// Discover git repos under the configured base dirs, and describe each repo's
// worktrees (branch, head, merged-into-default) — plus the two branch-level reads the
// rest of the app does against one worktree: how far it has drifted from its base
// (readDrift, which server/overlap.ts caches) and bringing it back up to date
// (updateFromBase, the verb behind POST /group/update).
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

/**
 * One worktree measured against its base — the arithmetic server/overlap.ts caches.
 *
 * It lives HERE rather than in overlap.ts because there are now two readers of it: the
 * drift feed, and updateFromBase() below, which must refuse a rebase that overlap has
 * already established will conflict. A second implementation of "which files will fight"
 * is exactly the kind of copy this codebase keeps paying for — the two would disagree,
 * and the disagreement would show up as a verb that starts a rebase the UI said was safe.
 */
export interface DriftRead {
  headSha: string;
  baseSha: string;
  /** Files this branch changed since the merge-base. */
  changed: string[];
  behind: number;
  ahead: number;
  /** Of `changed`, the ones the base also touched since the merge-base. */
  conflicts: string[];
}

/**
 * Read a worktree's drift from `base`, or null when it cannot be read at all.
 *
 * `known` lets a caller that has already resolved both shas — overlap.ts resolves them to
 * decide whether its cached answer still stands — skip two `rev-parse` spawns per sweep.
 */
export async function readDrift(
  worktreePath: string,
  base: string,
  known?: { headSha: string; baseSha: string },
): Promise<DriftRead | null> {
  const headSha = known?.headSha || (await git(worktreePath, ['rev-parse', 'HEAD']));
  if (!headSha) return null;
  // The base is resolved IN THE WORKTREE, so `origin/master` means that worktree's own
  // remote-tracking ref rather than whatever the main checkout last fetched.
  const baseSha = known?.baseSha || (await git(worktreePath, ['rev-parse', base]));
  if (!baseSha) return null;
  const mb = await git(worktreePath, ['merge-base', headSha, baseSha]);
  if (!mb) return null;

  const [mine, theirs, behind, ahead] = await Promise.all([
    git(worktreePath, ['diff', '--name-only', `${mb}..${headSha}`]),
    git(worktreePath, ['diff', '--name-only', `${mb}..${baseSha}`]),
    git(worktreePath, ['rev-list', '--count', `${headSha}..${baseSha}`]),
    git(worktreePath, ['rev-list', '--count', `${baseSha}..${headSha}`]),
  ]);
  const changed = mine.split('\n').filter(Boolean);
  const onBase = new Set(theirs.split('\n').filter(Boolean));
  return {
    headSha,
    baseSha,
    changed,
    behind: Number(behind) || 0,
    ahead: Number(ahead) || 0,
    conflicts: changed.filter((f) => onBase.has(f)),
  };
}

/** What POST /group/update reports for one worktree. */
export interface UpdateResult {
  /** False means NOTHING was attempted or the attempt was fully undone — never half-done. */
  ok: boolean;
  /** True only when commits were actually replayed. An already-current branch is ok+false. */
  updated: boolean;
  /** How far behind the base it was before the attempt — 0 when already current. */
  behind: number;
  /** Why it was refused, or what the rebase said before it was aborted. */
  error?: string;
  /** The files that made a refusal certain, when the refusal was a predicted conflict. */
  conflicts?: string[];
}

const refuse = (error: string, behind = 0, conflicts?: string[]): UpdateResult => ({
  ok: false,
  updated: false,
  behind,
  error,
  ...(conflicts ? { conflicts } : {}),
});

/**
 * BRING ONE WORKTREE UP TO DATE WITH ITS BASE — by REBASE, not by merge.
 *
 * Rebase, because that is how this repo's branches are actually managed. Every merge in
 * `git log --merges` is an integration merge OF a branch INTO the default branch
 * ("Merge feat/offslot-ports: …"); there is not one merge of the default branch back into
 * a feature branch, and every branch's first commit hangs directly off the tip of main at
 * the moment it was cut. worktree.create() cuts new branches from `origin/HEAD`
 * (git.defaultBase) for the same reason. A merge here would put the first merge commit
 * anybody has ever made on the branch side into a history whose whole shape is "one clean
 * line per feature, one merge commit per integration", and it would do it to four repos at
 * once. readDrift's `conflicts` is already defined as what a REBASE will fight, and it is
 * what the UI has been showing all along.
 *
 * It REFUSES rather than half-succeeding. Four refusals, all decided before git touches
 * the working tree:
 *
 *   - a detached worktree has no branch to replay;
 *   - a rebase (or an am) already in progress — resuming somebody else's half-finished
 *     conflict resolution is not this verb's job;
 *   - a dirty tree: `git rebase` would refuse anyway, but the interesting part is that a
 *     user with `rebase.autoStash` set would NOT get a refusal, they would get their
 *     uncommitted work stashed and replayed by a button they pressed to update a branch;
 *   - a predicted conflict, from the same read the "27 behind · 3 will conflict" chip
 *     comes from. The whole value of the verb is that it cannot leave you in a conflicted
 *     rebase across four repos, and that is knowable before it starts.
 *
 * And if git fails anyway — a conflict the file-level prediction could not see, since two
 * branches can conflict inside one file that only one of them "changed" by name, or a
 * hook that rejects the replay — the rebase is ABORTED and the failure is reported. The
 * worktree is left exactly as it was found.
 */
export async function updateFromBase(worktreePath: string, base: string): Promise<UpdateResult> {
  /*
   * FIRST, and before the detached check — because a stopped rebase IS detached.
   *
   * A user who hit a conflict in a terminal and came back here has a worktree whose HEAD
   * is on no branch, and answering "the worktree is detached" would describe the symptom
   * while hiding the cause and the fix. `--git-path` answers per-worktree (a linked
   * worktree's state lives under .git/worktrees/<name>/), which is what makes this work
   * on a worktree at all.
   */
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    const p = await git(worktreePath, ['rev-parse', '--git-path', dir]);
    if (p && fs.existsSync(path.resolve(worktreePath, p)))
      return refuse('a rebase is already in progress here — finish or abort it first');
  }

  const branch = await currentBranch(worktreePath);
  if (!branch) return refuse('the worktree is detached — there is no branch to rebase');

  // untracked: false, deliberately. A rebase carries untracked files through untouched,
  // so counting them would refuse the very common "npm wrote a log file" worktree for no
  // reason. Tracked modifications are the ones that get stashed or lost.
  const dirty = await porcelainStatus(worktreePath, { untracked: false });
  if (dirty.length)
    return refuse(
      `${dirty.length} uncommitted change(s) — commit or stash them first (${dirty
        .slice(0, 3)
        .map((e) => e.path)
        .join(', ')}${dirty.length > 3 ? ', …' : ''})`,
    );

  const drift = await readDrift(worktreePath, base);
  if (!drift) return refuse(`cannot read this worktree against ${base}`);
  if (!drift.behind) return { ok: true, updated: false, behind: 0 };
  if (drift.conflicts.length)
    return refuse(
      `${drift.conflicts.length} file(s) would conflict with ${base} — rebase by hand: ${drift.conflicts
        .slice(0, 5)
        .join(', ')}${drift.conflicts.length > 5 ? ', …' : ''}`,
      drift.behind,
      drift.conflicts,
    );

  // GIT_EDITOR/GIT_SEQUENCE_EDITOR: a plain rebase does not open an editor, but a repo
  // configured with `rebase.autoSquash` and a sequence editor could — and an editor
  // waiting on a stdin nobody will ever answer is the hang util.ts's timeout exists to
  // survive rather than a failure worth having. `--no-autostash` makes the dirty refusal
  // above mean what it says regardless of the user's config.
  const r = await gitFull(worktreePath, ['rebase', '--no-autostash', base], {
    env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
  });
  if (r.code === 0) return { ok: true, updated: true, behind: drift.behind };

  // NEVER leave the tree mid-rebase. This is the difference between a verb that failed
  // and a verb that broke four checkouts: without the abort, the next thing the user sees
  // is a detached HEAD in a directory their dev server was serving from.
  await gitFull(worktreePath, ['rebase', '--abort']);
  return refuse(
    `rebase onto ${base} failed and was aborted: ${rebaseFailureLine(r.stderr, r.stdout)}`,
    drift.behind,
  );
}

/**
 * The one line of a failed rebase worth showing.
 *
 * Same reasoning as forge.pushFailureLine(): git interleaves progress ("First, rewinding
 * head to replay your work on top of it…") with the complaint, and the complaint is
 * rarely the first line.
 */
function rebaseFailureLine(stderr: string, stdout: string): string {
  const lines = `${stderr || ''}\n${stdout || ''}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /^(?:error|fatal|CONFLICT|hint: )/i.test(l)) || lines[0] || 'git rebase failed';
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
