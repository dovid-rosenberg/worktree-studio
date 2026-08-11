/*
 * Reading the filesystem's SHAPE, for the folder picker in Settings.
 *
 * A base directory is a path on the machine the daemon runs on, and a browser cannot
 * offer one. `<input type="file" webkitdirectory>` uploads a directory's contents and
 * hands back relative names; `showDirectoryPicker()` returns a handle with no path at
 * all. Both answer "which files" when the question is "which path" — so the daemon,
 * which is the thing that will actually scan the folder, lists it instead.
 *
 * WHAT IT DISCLOSES: directory NAMES, and whether a directory is a git repo. No file
 * names, no contents, no sizes. It is reachable only with the boot token and only from
 * the served origin (server/security.ts), which is the same bar as every route that can
 * start a process — and this one cannot change anything at all.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { expandTilde } from './util.ts';

export interface BrowseEntry {
  name: string;
  path: string;
  /** A git checkout — the thing you are looking for when you pick a root's children. */
  repo: boolean;
}

export interface BrowseResult {
  /** The directory that was listed, absolute and resolved. */
  path: string;
  /** Its parent, or null at the filesystem root — what "up" is, decided here not there. */
  parent: string | null;
  /** How many direct children are git repos: what makes this a plausible base directory. */
  repoCount: number;
  entries: BrowseEntry[];
  error?: string;
}

/** Is this directory itself a git checkout? `.git` is a dir in a repo, a FILE in a worktree. */
function isRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * List the directories inside `input`, defaulting to the home directory.
 *
 * Never throws: an unreadable or missing path answers with the home directory's listing
 * and an `error`, because a picker that goes blank when you fat-finger a path is a picker
 * you cannot get out of without closing it.
 */
export function browse(input?: string | null): BrowseResult {
  const want = expandTilde(String(input || '').trim()) || os.homedir();
  let dir = path.resolve(want);
  let error: string | undefined;

  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
  } catch {
    error = `cannot read ${dir}`;
    dir = os.homedir();
  }

  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Readable as a path, not as a listing — a permission-denied directory. Report the
    // directory as empty rather than bouncing to home: you are standing where you asked
    // to stand, and "nothing here" plus a message is the honest answer.
    error = error || `cannot list ${dir}`;
  }

  const entries: BrowseEntry[] = [];
  for (const e of names) {
    /*
     * Directories only, and no dotfiles.
     *
     * `.git`, `.worktrees`, `node_modules` and friends are never what someone is
     * navigating toward, and a home directory's hidden entries outnumber its real ones
     * by an order of magnitude. `node_modules` is not hidden, so it is named explicitly:
     * it is the one visible directory that is always noise and sometimes enormous.
     */
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    // A symlink may point at a file, or nowhere. statSync follows it; a broken one throws
    // and is simply not listed.
    if (e.isSymbolicLink()) {
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    entries.push({ name: e.name, path: full, repo: isRepo(full) });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);

  return {
    path: dir,
    // `path.dirname('/')` is '/', which would draw an "up" that goes nowhere.
    parent: parent === dir ? null : parent,
    repoCount: entries.filter((e) => e.repo).length,
    entries,
    ...(error ? { error } : {}),
  };
}
