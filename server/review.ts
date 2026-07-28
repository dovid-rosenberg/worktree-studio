// Per-worktree review backend: the branch's diff vs its merge-base with the
// default branch (committed delta + uncommitted working changes), single-file
// diffs, and staged commits. All git via arg-arrays through git/gitFull.
import fs from 'fs';
import path from 'path';
import { git, gitFull } from './util.ts';
import { parsePatch } from './diff.ts';
import type { DiffFile } from './types.ts';

/**
 * One changed file in a review view. `diff` and `parsed` are filled in only by
 * the *Detail views — the list views answer with counts alone.
 */
export interface ReviewFile {
  file: string;
  /** A git status letter: 'M', 'A', 'D', 'R', 'C', … */
  status: string;
  added: number;
  deleted: number;
  /** Present only on a rename or copy. */
  oldFile?: string;
  diff?: string;
  parsed?: DiffFile | null;
}

/** One commit on the branch, with the totals rolled up from its numstat rows. */
export interface ReviewCommit {
  sha: string;
  author: string;
  when: string;
  subject: string;
  added: number;
  deleted: number;
  fileCount: number;
}

/** What `commit()` answers with. `sha` on success, `error` on any refusal. */
export interface CommitResult {
  ok: boolean;
  sha?: string;
  error?: string;
}

// A commit-ish that arrived in a query string is not a positional argument until it
// has been proved to be one.
//
// `git show --format= --numstat -z <sha>` spliced `sha` in bare, so a `?sha=` of
// `--output=/tmp/anything` was read by git as an OPTION: it exits 0 and truncates
// that path. `GET /sessions/:id/diff` and `GET /sessions/:id/commit-detail` both
// feed it straight from the query string, so a GET could overwrite an arbitrary
// file. The boot token gates it, but a GET that writes to the filesystem is the
// wrong shape regardless — it lands in logs and shell history, and it would be
// reachable from an <img> tag if the Origin gate ever regressed.
//
// Two independent defences, because either alone is one mistake from being the
// whole protection:
//   - the value has to look like an object name (or the literal 'uncommitted'), and
//   - every command gets `--` after it, so git stops parsing options at that point.
const SHA_RE = /^[0-9a-f]{4,40}$/i;

// `sha` is whatever the query string carried, which is why it is not typed as a
// string: express parses `?sha=a&sha=b` to an array and `?sha[x]=y` to an object.
function isValidSha(sha: unknown): boolean { return sha === 'uncommitted' || SHA_RE.test(String(sha == null ? '' : sha)); }

// The review baseline: the merge-base of HEAD with the default branch. A branch is
// often cut from origin/<default> while the LOCAL <default> ref lags behind — basing
// on the stale local ref drags in commits already on the mainline (the classic "why
// am I seeing another branch's changes?"). So when both a local and a remote merge-base
// exist, use the one CLOSEST to HEAD (the descendant of the two): the tightest correct
// baseline no matter which ref is stale.
async function base(worktreePath: string, defaultBranch: string): Promise<string> {
  const local = await git(worktreePath, ['merge-base', 'HEAD', defaultBranch]);
  const remote = await git(worktreePath, ['merge-base', 'HEAD', `origin/${defaultBranch}`]);
  if (local && remote && local !== remote) {
    const localIsAncestor = (await gitFull(worktreePath, ['merge-base', '--is-ancestor', local, remote])).code === 0;
    return localIsAncestor ? remote : local;
  }
  return local || remote || defaultBranch;
}

function countLines(worktreePath: string, rel: string): number {
  try {
    const content = fs.readFileSync(path.join(worktreePath, rel), 'utf8');
    if (!content) return 0;
    const parts = content.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts.length;
  } catch { return 0; }
}

// `-z` is the only unambiguous way to read a rename out of git. The human-readable
// form collapses it into ONE field (`old => name.js`, or `{src => lib}/math.js`),
// which is indistinguishable from a filename that genuinely contains " => " — and,
// worse, --numstat spells it that way while --name-status reports only the new path.
// Keying off both then produced TWO entries for one rename: the real file, plus a
// phantom keyed `old => new` with no parsed diff. The phantom rendered as an empty
// file block and, in the uncommitted view, claimed "nothing left to stage" — which
// reads to the user as though their changes had vanished.
//
// Under -z a rename emits its paths as separate NUL-terminated fields, so the two
// commands finally agree on one key: the new path.

/** One `--numstat -z` record. `oldFile` is set only when git reported a rename. */
interface NumstatEntry {
  added: number;
  deleted: number;
  file: string;
  oldFile?: string;
}

/** One `--name-status -z` record. */
interface NameStatusEntry {
  status: string;
  file: string;
  oldFile?: string;
}

// `add\tdel\tpath\0` per file — except a rename, which is `add\tdel\t\0old\0new\0`.
function parseNumstatZ(raw: string): NumstatEntry[] {
  const out: NumstatEntry[] = [];
  const tok = String(raw || '').split('\0');
  for (let i = 0; i < tok.length; i++) {
    if (!tok[i]) continue;
    const parts = tok[i].split('\t');
    if (parts.length < 3) continue; // not a record header
    const [a, d, inline] = parts;
    const num = (v: string) => (v === '-' ? 0 : Number(v) || 0);
    if (inline) { out.push({ added: num(a), deleted: num(d), file: inline }); continue; }
    // empty third field → the next two tokens are the old and new paths
    const oldFile = tok[++i];
    const file = tok[++i];
    if (file) out.push({ added: num(a), deleted: num(d), file, oldFile });
  }
  return out;
}

// `X\0path\0` per file — except a rename/copy, which is `Rnnn\0old\0new\0`.
function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = [];
  const tok = String(raw || '').split('\0').filter((t) => t !== '');
  for (let i = 0; i < tok.length; i++) {
    const code = tok[i];
    if (!/^[A-Z]/.test(code)) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldFile = tok[++i]; const file = tok[++i];
      if (file) out.push({ status: letter, file, oldFile });
    } else {
      const file = tok[++i];
      if (file) out.push({ status: letter, file });
    }
  }
  return out;
}

// The working tree's UNCOMMITTED changes (vs HEAD), de-duped by path: tracked changes
// from git diff HEAD (numstat counts + name-status), untracked files from git status
// --porcelain (status 'A', line count as added). Excludes everything already committed.
async function working(worktreePath: string): Promise<{ files: ReviewFile[] }> {
  const byPath = new Map<string, ReviewFile>();
  const get = (f: string): ReviewFile => {
    const hit = byPath.get(f);
    if (hit) return hit;
    const made: ReviewFile = { file: f, status: 'M', added: 0, deleted: 0 };
    byPath.set(f, made);
    return made;
  };

  for (const r of parseNumstatZ(await git(worktreePath, ['diff', '--numstat', '-z', 'HEAD']))) {
    const e = get(r.file);
    e.added = r.added;
    e.deleted = r.deleted;
    if (r.oldFile) e.oldFile = r.oldFile;
  }

  for (const r of parseNameStatusZ(await git(worktreePath, ['diff', '--name-status', '-z', 'HEAD']))) {
    const e = get(r.file);
    e.status = r.status;
    if (r.oldFile) e.oldFile = r.oldFile;
  }

  const porcelain = await git(worktreePath, ['status', '--porcelain']);
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('??')) continue;
    const f = line.slice(3);
    const e = get(f);
    e.status = 'A';
    e.added = countLines(worktreePath, f);
  }

  return { files: [...byPath.values()] };
}

// Raw unified diff for one working-tree file (vs HEAD); untracked → /dev/null diff.
async function workingFileDiff(worktreePath: string, file: string): Promise<string> {
  const r = await gitFull(worktreePath, ['diff', 'HEAD', '--', file]);
  if (r.stdout) return r.stdout;
  const st = await git(worktreePath, ['status', '--porcelain', '--', file]);
  if (st.startsWith('??')) {
    const u = await gitFull(worktreePath, ['diff', '--no-index', '--', '/dev/null', file]);
    return u.stdout;
  }
  return r.stdout;
}

// The commits on this branch (base..HEAD), newest first, each with its totals. One
// `git log --numstat` call: a REC-prefixed header line per commit, then its numstat rows.
async function commits(worktreePath: string, defaultBranch: string): Promise<{ base: string, commits: ReviewCommit[] }> {
  const b = await base(worktreePath, defaultBranch);
  const SEP = '\x1f'; const REC = '\x1e';
  const raw = await git(worktreePath, ['log', `--format=${REC}%H${SEP}%an${SEP}%ar${SEP}%s`, '--numstat', `${b}..HEAD`]);
  const list: ReviewCommit[] = [];
  let cur: ReviewCommit | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith(REC)) {
      const [sha, author, when, subject] = line.slice(1).split(SEP);
      cur = { sha, author, when, subject: subject || '', added: 0, deleted: 0, fileCount: 0 };
      list.push(cur);
    } else if (line.trim() && cur) {
      const [a, d] = line.split('\t');
      cur.added += a === '-' ? 0 : Number(a) || 0;
      cur.deleted += d === '-' ? 0 : Number(d) || 0;
      cur.fileCount += 1;
    }
  }
  return { base: b, commits: list };
}

// Per-file breakdown (status + counts + unified diff) for a single commit, or for the
// working tree when sha === 'uncommitted'. Diffs are inline so the pane can show all
// files at once and filter to one client-side without another round-trip.
async function commitDetail(worktreePath: string, defaultBranch: string, sha: string): Promise<{ files: ReviewFile[] }> {
  if (sha === 'uncommitted') return workingDetail(worktreePath);
  // Last line of defence — the routes reject this with a 400 first, but nothing
  // downstream of here should ever have to wonder whether `sha` is a flag.
  if (!isValidSha(sha)) throw new Error(`invalid commit sha: ${String(sha).slice(0, 60)}`);
  const byPath = new Map<string, ReviewFile>();
  const get = (f: string): ReviewFile => {
    const hit = byPath.get(f);
    if (hit) return hit;
    const made: ReviewFile = { file: f, status: 'M', added: 0, deleted: 0 };
    byPath.set(f, made);
    return made;
  };
  for (const r of parseNumstatZ(await git(worktreePath, ['show', '--format=', '--numstat', '-z', sha, '--']))) {
    const e = get(r.file);
    e.added = r.added;
    e.deleted = r.deleted;
    if (r.oldFile) e.oldFile = r.oldFile;
  }
  for (const r of parseNameStatusZ(await git(worktreePath, ['show', '--format=', '--name-status', '-z', sha, '--']))) {
    const e = get(r.file);
    e.status = r.status;
    if (r.oldFile) e.oldFile = r.oldFile;
  }
  const files = [...byPath.values()];
  for (const f of files) {
    f.diff = (await gitFull(worktreePath, ['show', '--format=', sha, '--', f.file])).stdout;
    f.parsed = structure(f.diff);
  }
  return { files };
}

// The working tree's uncommitted changes with inline diffs.
async function workingDetail(worktreePath: string): Promise<{ files: ReviewFile[] }> {
  const { files } = await working(worktreePath);
  for (const f of files) {
    f.diff = await workingFileDiff(worktreePath, f.file);
    f.parsed = structure(f.diff);
  }
  return { files };
}

// The structured side-by-side model for one file's diff (see server/diff.js): hunks with
// aligned left/right rows and line numbers on both sides, so a client can render either
// layout without re-parsing the text. `diff` stays alongside it — the raw patch is still
// what git speaks, and dropping it would break anything that renders the text directly.
function structure(diffText: string | undefined): DiffFile | null {
  if (!diffText) return null;
  // Each diff here is already scoped to a single path, so there is exactly one entry.
  return parsePatch(diffText)[0] || null;
}

// Stage the given paths (or everything) and commit. Returns { ok, sha, error }.
async function commit(worktreePath: string, message: string, { amend, paths }: { amend?: boolean, paths?: unknown } = {}): Promise<CommitResult> {
  // `paths` is req.body.paths, and it was spread straight into the argv. Without a
  // `--` separator an element beginning with `-` is an OPTION to git add
  // (`--chmod=+x`, `--pathspec-from-file=…`), and a non-string element reaches
  // execFile and throws a TypeError — a 500 for what is a bad request. Every other
  // git call in this file already separates paths from flags; this one didn't.
  if (paths != null && !Array.isArray(paths)) return { ok: false, error: 'paths must be an array of strings' };
  const list: unknown[] = paths || [];
  if (!list.every((p): p is string => typeof p === 'string' && !!p)) return { ok: false, error: 'every entry in paths must be a non-empty string' };
  const add = list.length ? ['add', '--', ...list] : ['add', '-A'];
  const a = await gitFull(worktreePath, add);
  if (a.code !== 0) return { ok: false, error: a.stderr.trim() || 'git add failed' };
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  const c = await gitFull(worktreePath, args);
  if (c.code !== 0) return { ok: false, error: c.stderr.trim() || c.stdout.trim() || 'git commit failed' };
  return { ok: true, sha: await git(worktreePath, ['rev-parse', 'HEAD']) };
}

export { base, working, commits, commitDetail, commit, isValidSha };
