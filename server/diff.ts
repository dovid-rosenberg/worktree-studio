// Pure unified-diff model: parse a `git diff` patch into files → hunks → lines, with
// aligned left/right rows for side-by-side rendering, and serialize a SUBSET of a
// file's hunks back into a patch `git apply` accepts (that's what hunk staging is).
//
// No git calls live here on purpose: everything is a string in / structure out, so the
// nasty cases (no trailing newline, CRLF, renames, binary, mode-only, hunk-offset
// recomputation) are testable from fixture patches without a repo. server/hunks.js is
// the thin git layer on top.
//
// The serializer is byte-exact: formatFilePatch(file) with every hunk selected
// reproduces the input patch verbatim. That property is the whole safety net — if a
// round trip is byte-identical, `git apply` sees exactly what git itself produced.

import type {
  DiffFile, DiffHunk, DiffHunkHeader, DiffLine, DiffLineType, DiffRow,
} from './types.ts';

// "\ No newline at end of file" — the message is translatable, the "\ " prefix is not,
// so match on the prefix and keep the original text for re-serialization.
const NO_NEWLINE_PREFIX = '\\ ';
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Which hunks of a file to emit; null/undefined means every hunk. Indexes arrive from
// the wire, so a string index is as ordinary as a number one.
type HunkSelection = number | string | Array<number | string> | null | undefined;

// Split a patch into lines WITHOUT touching \r — a CRLF file's diff carries the \r
// inside each payload line and dropping it would corrupt the patch.
function splitLines(text: string | null | undefined): string[] {
  const out = String(text == null ? '' : text).split('\n');
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// Undo git's C-style quoting of paths with unusual bytes ("\303\244.txt"). Only used
// for the display path — header lines are re-emitted verbatim, so whatever quoting git
// chose is what git apply reads back.
function unquotePath(p: string): string {
  if (!(p.length > 1 && p[0] === '"' && p[p.length - 1] === '"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(body.charCodeAt(i) & 0xff); continue; }
    const c = body[++i];
    if (c >= '0' && c <= '7') { bytes.push(parseInt(body.substr(i, 3), 8) & 0xff); i += 2; continue; }
    const esc: Record<string, number> = { n: 10, t: 9, r: 13, f: 12, b: 8, a: 7, v: 11 };
    bytes.push(c in esc ? esc[c] : c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

// `--- a/foo` / `+++ w/foo` → `foo`; `/dev/null` → null. The prefix is whatever the
// user's diff.mnemonicPrefix / --src-prefix produced, so strip the first component
// rather than assuming `a/` and `b/`.
function stripPrefix(p: string | null | undefined): string | null {
  if (!p || p === '/dev/null') return null;
  const unq = unquotePath(p);
  const slash = unq.indexOf('/');
  return slash === -1 ? unq : unq.slice(slash + 1);
}

// Pair up a hunk's lines into side-by-side rows. A run of removals immediately followed
// by a run of additions is the "changed line" case: pair them index-wise so the two
// versions sit on the same row, and let the leftovers fall through as one-sided rows.
// Rows reference `lines` BY INDEX so the same payload renders unified (walk `lines`) or
// side-by-side (walk `rows`) without duplicating any text.
/**
 * @param lines only the line KINDS matter here — rows carry indexes, never text
 */
function alignRows(lines: Array<{ type: DiffLineType }>): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type === 'context') { rows.push({ type: 'context', left: i, right: i }); i += 1; continue; }
    const dels: number[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(i++);
    const adds: number[] = [];
    while (i < lines.length && lines[i].type === 'add') adds.push(i++);
    if (!dels.length && !adds.length) { i += 1; continue; } // unreachable guard: never spin
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const left = k < dels.length ? dels[k] : null;
      const right = k < adds.length ? adds[k] : null;
      rows.push({ type: left !== null && right !== null ? 'change' : left !== null ? 'del' : 'add', left, right });
    }
  }
  return rows;
}

// One hunk body: consume exactly the lines the header promises (counts are
// authoritative), plus any trailing "\ No newline" marker, which belongs to the line
// before it and carries no line number of its own.
/**
 * @param lines the whole patch, split
 * @param start first body line
 * @param end   exclusive bound (next file's block, or EOF)
 * @param hunk  the header this body belongs to; its counts are authoritative about
 *        how many lines to consume
 */
function parseHunkBody(
  lines: string[], start: number, end: number, hunk: DiffHunkHeader,
): { lines: DiffLine[]; next: number } {
  const out: DiffLine[] = [];
  let i = start;
  let oldLeft = hunk.oldLines;
  let newLeft = hunk.newLines;
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const attachNoNewline = (text: string) => {
    const prev = out[out.length - 1];
    if (prev) { prev.noNewline = true; prev.noNewlineText = text; }
  };
  while (i < end) {
    const raw = lines[i];
    if (raw.startsWith(NO_NEWLINE_PREFIX) || raw === '\\') { attachNoNewline(raw); i += 1; continue; }
    if (oldLeft <= 0 && newLeft <= 0) break;
    const marker = raw[0];
    if (marker === '-') {
      out.push({ type: 'del', text: raw.slice(1), oldLine: oldLine++, newLine: null });
      oldLeft -= 1;
    } else if (marker === '+') {
      out.push({ type: 'add', text: raw.slice(1), oldLine: null, newLine: newLine++ });
      newLeft -= 1;
    } else if (marker === ' ' || raw === '') {
      // A bare empty line is an empty context line some tools emit without the leading
      // space; remember which form it was so a round trip stays byte-identical.
      const line: DiffLine = { type: 'context', text: raw === '' ? '' : raw.slice(1), oldLine: oldLine++, newLine: newLine++ };
      if (raw === '') line.bare = true;
      out.push(line);
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      break; // not part of this hunk (trailing prose, next file, …)
    }
    i += 1;
  }
  return { lines: out, next: i };
}

// Parse one `diff --git` block: the raw header lines (kept verbatim for re-emission),
// what kind of change it is, and its hunks.
function parseFile(lines: string[], start: number, end: number): DiffFile {
  const file: DiffFile = {
    path: null, oldPath: null, newPath: null, status: 'modified',
    binary: false, oldMode: null, newMode: null, similarity: null,
    header: [], hunks: [], added: 0, deleted: 0,
  };
  let i = start;
  if (lines[i] && lines[i].startsWith('diff --git ')) file.header.push(lines[i++]);
  for (; i < end; i++) {
    const l = lines[i];
    if (l.startsWith('@@')) break;
    if (l.startsWith('GIT binary patch') || l.startsWith('Binary files ') || l.startsWith('Binary file ')) {
      file.binary = true;
      break; // the binary payload is not something we can serialize a subset of
    }
    file.header.push(l);
    if (l.startsWith('old mode ')) file.oldMode = l.slice(9).trim();
    else if (l.startsWith('new mode ')) file.newMode = l.slice(9).trim();
    else if (l.startsWith('new file mode ')) { file.status = 'added'; file.newMode = l.slice(14).trim(); }
    else if (l.startsWith('deleted file mode ')) { file.status = 'deleted'; file.oldMode = l.slice(18).trim(); }
    else if (l.startsWith('similarity index ')) file.similarity = parseInt(l.slice(17), 10);
    else if (l.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = unquotePath(l.slice(12)); }
    else if (l.startsWith('rename to ')) { file.status = 'renamed'; file.newPath = unquotePath(l.slice(10)); }
    else if (l.startsWith('copy from ')) { file.status = 'copied'; file.oldPath = unquotePath(l.slice(10)); }
    else if (l.startsWith('copy to ')) { file.status = 'copied'; file.newPath = unquotePath(l.slice(8)); }
    else if (l.startsWith('--- ')) file.oldPath = stripPrefix(l.slice(4));
    else if (l.startsWith('+++ ')) file.newPath = stripPrefix(l.slice(4));
  }

  // Fall back to the `diff --git a/x b/y` line when there were no ---/+++ lines
  // (mode-only and binary changes have none).
  if (!file.oldPath && !file.newPath && file.header[0]) {
    const m = /^diff --git (.+) (.+)$/.exec(file.header[0]);
    if (m) { file.oldPath = stripPrefix(m[1]); file.newPath = stripPrefix(m[2]); }
  }
  file.path = file.newPath || file.oldPath;

  while (i < end) {
    const m = HUNK_RE.exec(lines[i]);
    if (!m) {
      // `@@@` = a combined (merge) diff. We can render neither side-by-side rows nor a
      // subset patch from it, so flag it rather than mis-parsing it.
      if (lines[i].startsWith('@@')) { file.unsupported = 'combined'; break; }
      i += 1;
      continue;
    }
    const head: DiffHunkHeader = {
      index: file.hunks.length,
      oldStart: parseInt(m[1], 10),
      oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
      newStart: parseInt(m[3], 10),
      newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
      section: m[5] || '',
      header: lines[i],
    };
    const body = parseHunkBody(lines, i + 1, end, head);
    const hunk: DiffHunk = {
      ...head,
      lines: body.lines,
      rows: alignRows(body.lines),
      added: body.lines.filter((l) => l.type === 'add').length,
      deleted: body.lines.filter((l) => l.type === 'del').length,
    };
    file.added += hunk.added;
    file.deleted += hunk.deleted;
    file.hunks.push(hunk);
    i = body.next;
  }
  // A chmod with no content change: no hunks to stage, but the header still carries the
  // mode transition, so callers can offer it as a file-level stage instead.
  if (!file.hunks.length && !file.binary && file.oldMode && file.newMode) file.modeOnly = true;
  return file;
}

// parsePatch(text) → [file, …]. Accepts a multi-file `git diff`/`git show` patch; any
// preamble (commit message, `git show` header) before the first `diff --git` is ignored.
/**
 * @param text a `git diff` / `git show` patch, possibly multi-file
 */
function parsePatch(text: string): DiffFile[] {
  const lines = splitLines(text);
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('diff --git ')) starts.push(i);
  // A bare unified diff (no `diff --git` header) still parses as a single file.
  if (!starts.length) {
    const first = lines.findIndex((l) => l.startsWith('--- ') || l.startsWith('@@ '));
    if (first === -1) return [];
    starts.push(first);
  }
  const out: DiffFile[] = [];
  for (let k = 0; k < starts.length; k++) {
    out.push(parseFile(lines, starts[k], k + 1 < starts.length ? starts[k + 1] : lines.length));
  }
  return out;
}

// `@@ -a,b +c,d @@section` — git omits the `,count` when the count is 1, and we match
// that exactly so a full round trip is byte-identical.
function formatHunkHeader(
  oldStart: number, oldLines: number, newStart: number, newLines: number,
  section?: string | null,
): string {
  const at = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);
  return `@@ -${at(oldStart, oldLines)} +${at(newStart, newLines)} @@${section || ''}`;
}

function hunkBodyLines(hunk: DiffHunk): string[] {
  const out: string[] = [];
  for (const l of hunk.lines) {
    const marker = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    out.push(l.bare && l.type === 'context' ? '' : marker + l.text);
    if (l.noNewline) out.push(l.noNewlineText || '\\ No newline at end of file');
  }
  return out;
}

/**
 * @param selection null/undefined selects every hunk
 * @param count how many hunks the file has
 * @returns in-range hunk indexes
 */
function normalizeSelection(selection: HunkSelection, count: number): number[] {
  if (selection == null) return [...Array(count).keys()];
  const list = Array.isArray(selection) ? selection : [selection];
  const set = new Set<number>();
  for (const n of list) {
    const i = typeof n === 'number' ? n : parseInt(n, 10);
    if (Number.isInteger(i) && i >= 0 && i < count) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}

// formatFilePatch(file, selection, { reverse }) → a patch containing ONLY the selected
// hunks, with their `@@` offsets recomputed so git apply accepts it.
//
// Why the offsets move: hunk headers state positions in BOTH the pre- and post-image.
// Dropping hunk 1 doesn't change where hunk 2 sits in the pre-image, but it does change
// where it lands in the post-image, by however many lines the dropped hunks would have
// added or removed. So the side git reads as the source stays put and the other side
// shifts by (net change of the hunks we KEPT) − (net change of all hunks BEFORE this one).
//   forward (stage): source is the pre-image (the index) → shift the new side.
//   reverse (unstage): git apply --reverse reads the post-image as its source (the diff
//   is HEAD→index, so the "+" side IS the index) → keep it and shift the old side.
// The header block (mode changes, rename from/to, index line) is copied verbatim: a
// subset of a renamed file's hunks still has to carry the rename.
/**
 * @param selection which hunks to emit
 * @returns a patch `git apply` accepts
 */
function formatFilePatch(
  file: DiffFile, selection?: HunkSelection, opts: { reverse?: boolean } = {},
): string {
  const reverse = !!opts.reverse;
  const sel = new Set(normalizeSelection(selection, file.hunks.length));
  const out = [...file.header];
  let allDelta = 0; // net (new − old) lines over every preceding hunk
  let keptDelta = 0; // …over the preceding hunks we actually kept
  for (const h of file.hunks) {
    if (sel.has(h.index)) {
      const shift = keptDelta - allDelta;
      out.push(formatHunkHeader(
        reverse ? h.oldStart - shift : h.oldStart, h.oldLines,
        reverse ? h.newStart : h.newStart + shift, h.newLines,
        h.section,
      ));
      out.push(...hunkBodyLines(h));
      keptDelta += h.newLines - h.oldLines;
    }
    allDelta += h.newLines - h.oldLines;
  }
  return `${out.join('\n')}\n`;
}

export { parsePatch, formatFilePatch, formatHunkHeader, alignRows, splitLines, stripPrefix, unquotePath, normalizeSelection };
