/*
 * The flat row model the diff viewport renders, plus the small pure helpers around it.
 *
 * WHY FLAT: a commit can carry tens of thousands of diff lines, and the only way to keep
 * that off the main thread is to render a window of it. Windowing needs (a) one linear
 * list of things to draw and (b) each item's height without measuring the DOM. So every
 * file header, group label, hunk header, diff row and note in the whole detail view is
 * flattened into ONE array of fixed-height items, and a prefix-sum of those heights lets
 * the viewport binary-search "what is at scrollTop" in O(log n).
 *
 * Nothing here touches the DOM or the network — it is `blocks in, items out`, so the
 * awkward parts (unified vs side-by-side, refused files, collapsed files) are decided
 * once, in one testable place, instead of inside a template.
 *
 * Both layouts come straight off the server's `parsed` model and neither re-parses text:
 *   unified        → walk hunk.lines
 *   side-by-side   → walk hunk.rows, whose left/right index INTO hunk.lines
 */

import type { DiffLine, Hunk, ParsedFile } from './api';

export interface Group {
  label: string;
  side: 'unstaged' | 'staged' | null;
  action: 'stage' | 'unstage' | null;
  hunks: Hunk[];
}

export interface Note {
  tone: 'info' | 'warn' | 'error';
  text: string;
}

export interface Block {
  file: string;
  status: string;
  added: number;
  deleted: number;
  collapsed: boolean;
  rename: string | null;
  busy: boolean;
  note: Note | null;
  error: string | null;
  groups: Group[];
}

/**
 * Item heights, in px. These are LOAD-BEARING: the viewport positions every row from
 * them without measuring, so a CSS change to a row's height must change the number here
 * too or the list will drift out of alignment with its own scrollbar. The diff CSS pins
 * the matching `height` on each element rather than relying on line-height alone.
 */
export const H = { file: 34, note: 30, group: 24, hunk: 24, row: 19, gap: 9 };

/** Kinds the cursor can land on with ↑/↓. Everything drawn is navigable — a diff row is
 *  the unit a reader actually moves through. */
const NAVIGABLE = new Set(['file', 'note', 'group', 'hunk', 'row']);

/** One drawn row. `k` is the discriminant every consumer switches on. */
export type Item =
  | { k: 'file'; b: Block }
  | { k: 'note'; b: Block; note: Note }
  | { k: 'group'; b: Block; g: Group }
  | { k: 'hunk'; b: Block; g: Group; hunk: Hunk }
  | { k: 'row'; b: Block; type: 'context' | 'add' | 'del' | 'change';
      left: DiffLine | null; right: DiffLine | null }
  | { k: 'gap' };

/**
 * Tab stops matter for width: a tab is one character in the string but up to `TAB` columns
 * on screen, and the viewport sizes its scroll canvas in `ch` units. Undercounting here
 * would clip the right-hand end of tab-indented code.
 */
const TAB = 4;

export function displayWidth(text: string) {
  if (text.indexOf('\t') === -1) return text.length;
  let n = 0;
  for (let i = 0; i < text.length; i++) n = text[i] === '\t' ? n + TAB - (n % TAB) : n + 1;
  return n;
}

/**
 * Flatten blocks into the render list.
 *
 * @returns {{ items:Item[], offsets:Float64Array, total:number,
 *             cols:number, colsLeft:number, colsRight:number }}
 *   `offsets[i]` is item i's top; `offsets[items.length]` is the total height.
 *
 *   The three widths are the widest line, in columns, of each surface that scrolls
 *   sideways on its own: `cols` for the unified canvas, `colsLeft`/`colsRight` for the
 *   two side-by-side columns. They are measured HERE, over the whole diff, so each
 *   surface's scroll range is fixed before the first frame and does not jitter as rows
 *   are recycled — and so one 260-column line on the right cannot invent scroll range
 *   on the left, where every line is short.
 */
export function buildItems(blocks: Block[], view: 'unified' | 'split') {
  const items: Item[] = [];
  const split = view === 'split';
  let cols = 0;
  let colsLeft = 0;
  let colsRight = 0;

  for (const b of blocks) {
    items.push({ k: 'file', b });
    if (!b.collapsed) {
      if (b.note) items.push({ k: 'note', b, note: b.note });
      if (b.error) items.push({ k: 'note', b, note: { tone: 'error', text: b.error } });
      for (const g of b.groups) {
        if (g.label) items.push({ k: 'group', b, g });
        for (const hunk of g.hunks) {
          items.push({ k: 'hunk', b, g, hunk });
          if (split) {
            // `rows` is the server's alignment: left/right index INTO `lines`, and a
            // null side is a line that exists only on the other one.
            for (const r of hunk.rows) {
              const left = r.left === null ? null : hunk.lines[r.left];
              const right = r.right === null ? null : hunk.lines[r.right];
              if (left) colsLeft = Math.max(colsLeft, displayWidth(left.text));
              if (right) colsRight = Math.max(colsRight, displayWidth(right.text));
              items.push({ k: 'row', b, type: r.type, left, right });
            }
          } else {
            for (const line of hunk.lines) {
              cols = Math.max(cols, displayWidth(line.text));
              items.push({ k: 'row', b, type: line.type, left: line, right: line });
            }
          }
        }
      }
    }
    items.push({ k: 'gap' });
  }

  const offsets = new Float64Array(items.length + 1);
  let y = 0;
  for (let i = 0; i < items.length; i++) { offsets[i] = y; y += H[items[i].k]; }
  offsets[items.length] = y;
  // A hard floor keeps short diffs from collapsing the gutter, and the cap stops one
  // pathological minified line from creating a 200k-pixel-wide surface nothing can scroll.
  const clamp = (n: number) => Math.max(40, Math.min(n, 2000));
  return { items, offsets, total: y, cols: clamp(cols), colsLeft: clamp(colsLeft), colsRight: clamp(colsRight) };
}

/**
 * Index of the last item whose top is <= y. Binary search, so scrolling a 100k-row diff
 * costs the same as scrolling a 100-row one.

 */
export function indexAt(offsets: Float64Array, y: number, count: number): number {
  let lo = 0;
  let hi = count - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export const navigable = (item: Item): boolean => NAVIGABLE.has(item.k);

/**
 * git's status letter → the class and label the file header shows. `R` (rename) only
 * appears when git's own rename detection fired; when it did not, the change arrives as
 * a `D` + `A` pair and `pairRenames()` below re-links them for display.
 */
export function statusInfo(status: string) {
  const s = (status || 'M').toUpperCase()[0];
  if (s === 'A') return { letter: 'A', cls: 'a', label: 'added' };
  if (s === 'D') return { letter: 'D', cls: 'd', label: 'deleted' };
  if (s === 'R') return { letter: 'R', cls: 'r', label: 'renamed' };
  if (s === 'C') return { letter: 'C', cls: 'r', label: 'copied' };
  if (s === '?') return { letter: '?', cls: 'a', label: 'untracked' };
  return { letter: s || 'M', cls: 'm', label: 'modified' };
}

/**
 * True for the composite path `git --numstat` prints for a rename: `old => new`, or
 * `{src => lib}/math.js` when only part of the path moved.
 *
 * The daemon builds its file list from `--numstat` AND `--name-status`, keyed by path,
 * and those two spell a rename differently — so a renamed file arrives TWICE: once under
 * this composite path with no patch at all, and once under its real new path with the
 * diff. Without this the composite half renders as a file header with nothing under it,
 * which reads as "this file's diff failed to load".
 *
 * A path test rather than a payload flag because the daemon does not mark them, and
 * ` => ` does not occur in real paths.
 */
export function isRenameSummaryPath(file: string): boolean {
  return / => /.test(file);
}

/**
 * Why a file has no stageable hunks, phrased for the user. Mirrors
 * `unstageableReason()` in server/hunks.js — the server refuses these, and the panel
 * has to say so up front rather than letting the user press Stage and get a 400.

 */
export function refusal(p: ParsedFile | null | undefined): Note | null {
  if (!p) return null;
  if (p.binary) return { tone: 'warn', text: 'Binary file — no textual diff. Hunk staging is unavailable; stage the whole file from the command line.' };
  if (p.unsupported === 'combined') return { tone: 'warn', text: 'Combined (merge) diff — hunk staging is not supported for this file.' };
  if (p.modeOnly) {
    const mode = p.oldMode && p.newMode ? ` (${p.oldMode} → ${p.newMode})` : '';
    return { tone: 'warn', text: `Mode-only change${mode} — no content changed, so there are no hunks to stage.` };
  }
  if (!p.hunks.length) return { tone: 'info', text: 'No textual changes in this file.' };
  return null;
}

/**
 * Re-link a rename that reached us as an independent delete + add.
 *
 * git's rename detection is on by default, so most renames arrive as one `R` file — but
 * it is off for a diff whose rename limit was blown, and the hunk layer deliberately
 * splits a rename into two halves (one per path) because each half stages separately.
 * Matching on basename is a display hint only: nothing is merged, both files still
 * render and stage on their own, they just say what they are probably part of.
 *
 */
export function pairRenames(blocks: Block[]): Block[] {
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const dels = blocks.filter((b) => statusInfo(b.status).letter === 'D');
  const adds = blocks.filter((b) => statusInfo(b.status).letter === 'A');
  if (!dels.length || !adds.length) return blocks;
  for (const d of dels) {
    const hit = adds.find((a) => base(a.file) === base(d.file) && a.file !== d.file && !a.rename);
    if (!hit) continue;
    d.rename = `→ ${hit.file}`;
    hit.rename = `← ${d.file}`;
  }
  return blocks;
}

/*
 * `stat(added, deleted)` was removed here rather than given a type.
 *
 * It was exported, imported by nothing in the repo, and its body contradicted its own
 * docstring: documented as returning `+12 −3`, it actually returned the two-element
 * array ['+12', '−3'], which renders as "+12,−3". Typing it would have meant either
 * enshrining the wrong return or silently changing dead code's behaviour. The two
 * components that show this stat (CommitList, ReviewPanel) build the markup inline.
 */
