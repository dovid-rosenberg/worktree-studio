// Native replacement for the `wt` script — baked in so the app owns worktree
// creation end to end. Creates the worktree off the repo's default branch at
// whatever path server/layout.ts says (default `<repo>/.worktrees/<name>`) and
// copies in the bits a plain `git worktree add` drops: editor scratch files
// (`copyAlways`, e.g. JetBrains run configs) plus the gitignored local config
// and .env files (`copyPatterns`).
import fs from 'fs';
import path from 'path';
import { git, gitFull, slug } from './util.ts';
import * as layoutMod from './layout.ts';
import type { ResolvedLayout } from './layout.ts';
import type { Config, PartialDeep } from './types.ts';

/** How many files `populate()` carried into a new checkout. */
export interface CopyCounts {
  runConfigs: number;
  files: number;
}

/** The copy options `create()` wants, as `worktreeCopyOpts()` reads them out of a config. */
export interface WorktreeCopyOpts {
  copyPatterns: string[];
  copyAlways: string[];
}

export interface WorktreeCreateOptions extends Partial<WorktreeCopyOpts> {
  /** auto-suffix on collision instead of failing */
  unique?: boolean;
  /** false skips the pre-add fetch */
  fetch?: boolean;
  fetchTimeoutMs?: number;
  /** a server/layout.ts descriptor; defaults to nested `.worktrees` */
  layout?: ResolvedLayout;
  /**
   * What the new branch is cut from. Defaults to `origin/HEAD` — the pushed base,
   * so a new feature starts from what the team has rather than from whatever local
   * state the main checkout happens to be in. Promote overrides it with `HEAD` when
   * the user chooses to bring commits already made in the main checkout along.
   */
  base?: string;
}

export interface WorktreeCreateSuccess {
  ok: true;
  path: string;
  branch: string;
  name: string;
  /** The ref the new branch was cut from; null when the branch already existed. */
  base: string | null;
  created: boolean;
  copied: CopyCounts;
  warnings: string[];
}

/** A failure still names the worktree it was going to make — `addRepo()` attaches to it. */
export interface WorktreeCreateFailure {
  ok: false;
  error: string;
  path: string;
  name: string;
  branch: string;
}

export type WorktreeCreateResult = WorktreeCreateSuccess | WorktreeCreateFailure;

export interface WorktreeRemoveOptions {
  branch?: string | null;
  deleteBranch?: boolean;
}

export type WorktreeRemoveResult = { ok: true; branchDeleted: boolean } | { ok: false; error: string };

// Expand a shell-style pattern (e.g. "config/*-config.ts", ".env.*.local")
// relative to base. Supports `*` (any chars within one path segment). Segments
// are matched literally when they contain no `*`.
function expandPattern(base: string, pattern: string): string[] {
  const segs = pattern.split('/');
  let dirs = [''];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    const next: string[] = [];
    const re = seg.includes('*')
      ? new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
      : null;
    for (const d of dirs) {
      const abs = path.join(base, d);
      if (re) {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!re.test(e.name)) continue;
          if (last ? e.isFile() : e.isDirectory()) next.push(path.join(d, e.name));
        }
      } else {
        const cand = path.join(abs, seg);
        try {
          const st = fs.statSync(cand);
          if (last ? st.isFile() : st.isDirectory()) next.push(path.join(d, seg));
        } catch {
          /* missing */
        }
      }
    }
    dirs = next;
  }
  return dirs;
}

async function isIgnored(repoPath: string, rel: string): Promise<boolean> {
  const r = await gitFull(repoPath, ['check-ignore', '-q', rel]);
  return r.code === 0;
}

// The editor scratch a bare `git worktree add` silently drops. Kept here (and
// re-exported through config.defaults().copyAlways) so a caller that passes no
// `copyAlways` — every pre-existing one — still gets the historical behavior.
// An explicit empty array turns it off.
const DEFAULT_COPY_ALWAYS = ['.idea/runConfigurations/*.xml'];

// The only network round-trip in a worktree create, and a best-effort one: it just
// makes the base ref fresher, and a repo with no `origin` at all already skips
// straight past it. Left unbounded it was enough to hang POST /api/worktrees,
// /promote and /add-repo forever — the child never reaped, the route never
// answered — on a dropped VPN or a credential helper prompting on a stdin nobody
// is going to answer. Bound it and carry on with the refs that are already local.
const FETCH_TIMEOUT_MS = 60000;

// The copy options `create()` wants, read out of a loaded config: a per-repo
// override under `copyPatterns`/`copyAlways` wins over `.default`. An absent
// `copyAlways` key (a config written before it existed, or a hand-built test cfg)
// keeps the historical unconditional run-config copy; an explicit one is obeyed,
// empty array included.
function worktreeCopyOpts(cfg: PartialDeep<Config> | null | undefined, repo: string): WorktreeCopyOpts {
  const pick = (m?: Record<string, string[] | undefined> | null): string[] =>
    (m && (m[repo] || m.default)) || [];
  return {
    copyPatterns: pick(cfg?.copyPatterns),
    copyAlways: cfg?.copyAlways ? pick(cfg.copyAlways) : DEFAULT_COPY_ALWAYS,
  };
}

// Copy one expanded pattern's files from repoPath into dest. Returns the count.
function copyMatches(repoPath: string, dest: string, pattern: string): number {
  let n = 0;
  for (const rel of expandPattern(repoPath, pattern)) {
    const src = path.join(repoPath, rel);
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.copyFileSync(src, target);
      n++;
    } catch {
      /* */
    }
  }
  return n;
}

// `always` are patterns copied whether or not git ignores them — editor scratch
// (JetBrains run configs by default) that a checkout will not bring along.
// `patterns` are copied ONLY when git ignores them: a tracked file already
// arrives with the checkout, and copying the main checkout's copy over it would
// silently import uncommitted edits.
async function populate(
  repoPath: string,
  dest: string,
  patterns?: string[] | null,
  always: string[] | null = DEFAULT_COPY_ALWAYS,
): Promise<CopyCounts> {
  const copied: CopyCounts = { runConfigs: 0, files: 0 };
  for (const pat of always || []) copied.runConfigs += copyMatches(repoPath, dest, pat);
  // local files — only carry the ones git actually ignores
  for (const pat of patterns || []) {
    for (const rel of expandPattern(repoPath, pat)) {
      const src = path.join(repoPath, rel);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      if (!(await isIgnored(repoPath, rel))) continue; // tracked files arrive with checkout
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.copyFileSync(src, target);
        copied.files++;
      } catch {
        /* */
      }
    }
  }
  return copied;
}

// Does a local or remote branch already exist?
async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const local = await gitFull(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (local.code === 0) return true;
  const remote = await gitFull(repoPath, [
    'show-ref',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}`,
  ]);
  return remote.code === 0;
}

async function defaultBase(repoPath: string): Promise<string> {
  const sym = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) return sym; // e.g. origin/develop
  const cur = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur || 'main';
}

/**
 * Create a worktree. Returns { ok, path, branch, name, base, created, copied, warnings, error }.
 * @param repoPath  main checkout the worktree is added to
 * @param branch  branch name (created off default base if it doesn't exist)
 * @param name    worktree dir name (defaults from branch)
 */
async function create(
  repoPath: string,
  branch: string,
  name?: string | null,
  opts: WorktreeCreateOptions = {},
): Promise<WorktreeCreateResult> {
  const warnings: string[] = [];
  const layout = opts.layout || layoutMod.resolve({});
  let wtName = slug(name || branch.replace(/\//g, '-'));
  let dest = layoutMod.destFor(layout, repoPath, wtName);

  // On a name/branch collision: opts.unique auto-suffixes (foo → foo-2) instead
  // of hard-failing, keeping the worktree name and branch's last segment in sync.
  if (opts.unique) {
    const baseName = wtName;
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (fs.existsSync(dest) || (await branchExists(repoPath, branch))) {
      n += 1;
      wtName = `${baseName}-${n}`;
      dest = layoutMod.destFor(layout, repoPath, wtName);
      branch = branch.replace(/[^/]+$/, wtName);
    }
    if (n > 1) warnings.push(`name was taken — using "${wtName}"`);
  }

  if (fs.existsSync(dest)) {
    return {
      ok: false,
      error: `worktree "${wtName}" already exists in ${path.basename(repoPath)}`,
      path: dest,
      name: wtName,
      branch,
    };
  }
  // Only a layout that puts worktrees INSIDE the repo needs ignoring; sibling and
  // external checkouts are outside the working tree and git never sees them.
  const ignoreRel = layoutMod.ignorePath(layout);
  if (ignoreRel) {
    const ign = await gitFull(repoPath, ['check-ignore', '-q', ignoreRel]);
    if (ign.code !== 0)
      warnings.push(`${ignoreRel}/ is not gitignored here; checkouts will show as untracked`);
  }
  // git worktree add creates the leaf, not the tree above it (sibling/external
  // layouts point outside the repo, where nothing has made the parent yet).
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (opts.fetch !== false)
    await gitFull(repoPath, ['fetch', '--prune', 'origin'], {
      timeout: opts.fetchTimeoutMs || FETCH_TIMEOUT_MS,
    });

  let created = false;
  let base: string | null = null;
  if (await branchExists(repoPath, branch)) {
    const r = await gitFull(repoPath, ['worktree', 'add', dest, branch]);
    if (r.code !== 0)
      return {
        ok: false,
        error: r.stderr.trim() || 'git worktree add failed',
        path: dest,
        name: wtName,
        branch,
      };
  } else {
    base = opts.base || (await defaultBase(repoPath));
    const r = await gitFull(repoPath, ['worktree', 'add', '-b', branch, dest, base]);
    if (r.code !== 0)
      return {
        ok: false,
        error: r.stderr.trim() || 'git worktree add -b failed',
        path: dest,
        name: wtName,
        branch,
      };
    created = true;
  }

  const copied = await populate(repoPath, dest, opts.copyPatterns, opts.copyAlways);
  return { ok: true, path: dest, branch, name: wtName, base, created, copied, warnings };
}

async function remove(
  repoPath: string,
  worktreePath: string,
  opts: WorktreeRemoveOptions = {},
): Promise<WorktreeRemoveResult> {
  const r = await gitFull(repoPath, ['worktree', 'remove', worktreePath]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'worktree remove failed (use force?)' };
  let branchDeleted = false;
  if (opts.deleteBranch && opts.branch) {
    const d = await gitFull(repoPath, ['branch', '-d', opts.branch]);
    branchDeleted = d.code === 0;
  }
  return { ok: true, branchDeleted };
}

export {
  create,
  remove,
  populate,
  branchExists,
  defaultBase,
  expandPattern,
  worktreeCopyOpts,
  DEFAULT_COPY_ALWAYS,
  FETCH_TIMEOUT_MS,
};
