// Where a repo's worktrees live on disk — pure, side-effect-free.
//
// Studio was written around one convention: `<repo>/.worktrees/<name>`. That
// spelling was baked into worktree creation, into the gitignore warning, and
// into the slot key derived from a path. This module is the single place that
// knows it, so the convention becomes a config choice instead of a constant.
//
// Three layouts, all naming the worktree by its last path segment:
//   nested   <repo>/<dir>/<name>          (default; dir defaults to `.worktrees`)
//   sibling  <repo>/../<name>             (worktrees beside the repo they belong to)
//   external <root>/<repo-basename>/<name> (one tree of worktrees, off to the side)
//
// Only `nested` puts worktrees inside the repo, so only `nested` needs the
// checkout dir to be gitignored — the other two are outside the working tree and
// git never sees them.
import path from 'path';
import { expandTilde } from './util.ts';
import type { Config, PartialDeep, WorktreeLayout } from './types.ts';

type LayoutMode = WorktreeLayout['layout'];

/** cfg.worktrees, normalized — what every function below is handed. */
export interface ResolvedLayout {
  mode: LayoutMode;
  dir: string;
  root: string;
}

const MODES: LayoutMode[] = ['nested', 'sibling', 'external'];
const DEFAULT_DIR = '.worktrees';

// Normalize cfg.worktrees into { mode, dir, root }. Unknown/missing values fall
// back to today's behavior rather than throwing: this is a local dev tool and a
// typo in config.json must not stop it booting.
function resolve(cfg?: PartialDeep<Config> | null): ResolvedLayout {
  const w: PartialDeep<WorktreeLayout> = cfg?.worktrees || {};
  const want = String(w.layout || 'nested');
  let mode = MODES.find((m) => m === want);
  if (!mode) {
    console.warn(`[wt-studio] worktrees.layout '${want}' is not one of ${MODES.join('/')} — using 'nested'.`);
    mode = 'nested';
  }
  // A leading/trailing slash in `dir` would produce an absolute or trailing-empty
  // segment when joined, so strip them before anything else uses it.
  const dir = String(w.dir || DEFAULT_DIR).replace(/^\/+|\/+$/g, '') || DEFAULT_DIR;
  const root = w.root ? expandTilde(String(w.root)) : '';
  if (mode === 'external' && !root) {
    console.warn("[wt-studio] worktrees.layout is 'external' but worktrees.root is unset — using 'nested'.");
    mode = 'nested';
  }
  return { mode, dir, root };
}

// The directory new worktrees of `repoPath` are created in.
function containerFor(layout: ResolvedLayout, repoPath: string): string {
  if (layout.mode === 'sibling') return path.dirname(repoPath);
  if (layout.mode === 'external') return path.join(layout.root, path.basename(repoPath));
  return path.join(repoPath, layout.dir);
}

// Absolute path of the worktree named `name` in `repoPath`.
function destFor(layout: ResolvedLayout, repoPath: string, name: string): string {
  return path.join(containerFor(layout, repoPath), name);
}

// The repo-relative path that must be gitignored for this layout, or null when
// the layout puts worktrees outside the working tree (nothing to ignore).
function ignorePath(layout: ResolvedLayout): string | null {
  return layout.mode === 'nested' ? layout.dir : null;
}

// The worktree name a path belongs to — the identity `basename` grouping keys on.
//
// For `nested` this is deliberately NOT plain basename: it finds the configured
// container segment and takes the segment after it, so a path *inside* a worktree
// (a process cwd, say) still resolves to the worktree, not to a subdirectory. A
// path with no container segment (a main checkout) falls back to its basename,
// which is the repo name — exactly what featureFromPath() has always returned.
function nameFromPath(layout: ResolvedLayout, worktreePath: string | null | undefined): string {
  const p = String(worktreePath || '');
  if (layout.mode === 'nested') {
    const parts = p.split(path.sep);
    const segs = layout.dir.split('/');
    // scan from the right for the last occurrence of the container segments
    for (let i = parts.length - segs.length - 1; i >= 0; i--) {
      if (segs.every((s, k) => parts[i + k] === s) && parts[i + segs.length]) {
        return parts[i + segs.length];
      }
    }
  }
  return path.basename(p);
}

export { resolve, containerFor, destFor, ignorePath, nameFromPath, MODES, DEFAULT_DIR };
