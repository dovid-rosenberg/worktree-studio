// Turning a search hit's snippet into highlightable segments.
//
// The three search backends return three different things, and the UI has to look the
// same across all of them:
//
//   sqlite-fts5  snippet() wraps matches in « », the delimiters chosen in
//                server/transcript-index.js. Best case — the server knows exactly which
//                tokens matched, including stemmed forms the client couldn't guess.
//   sqlite-like  substr(body, 1, 400). No markers, and the match may be past the cut.
//   file-scan    transcripts.excerpt() centres the window on the match. No markers.
//
// So: trust the server's markers when they're there, fall back to marking the query
// terms client-side when they're not.
//
// Output is always an array of {text, hit} — never an HTML string. Transcript bodies
// contain arbitrary user and tool-output text, so nothing here may reach {@html}.

const OPEN = '«'; // «
const CLOSE = '»'; // »

export interface Segment {
  text: string;
  hit: boolean;
}

/** @param terms query phrases, longest first */
export function segments(snippet: string, terms: string[] = []): Segment[] {
  const s = String(snippet || '');
  if (!s) return [];
  return s.includes(OPEN) ? fromMarkers(s) : fromTerms(s, terms);
}

// Alternate on the server's delimiters. A « with no closing » (a snippet window that
// cut mid-highlight) still terminates cleanly: the rest of the string is the hit.
function fromMarkers(s: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf(OPEN, i);
    if (open === -1) { push(out, s.slice(i), false); break; }
    push(out, s.slice(i, open), false);
    const close = s.indexOf(CLOSE, open + 1);
    if (close === -1) { push(out, s.slice(open + 1), true); break; }
    push(out, s.slice(open + 1, close), true);
    i = close + 1;
  }
  return out;
}

// Longest-first, non-overlapping, case-insensitive. Longest-first matters: with terms
// ["cache", "cache read"] the short one would otherwise claim the prefix and leave a
// ragged half-highlight.
function fromTerms(s: string, terms: string[]): Segment[] {
  const list = (terms || []).filter(Boolean);
  if (!list.length) return [{ text: s, hit: false }];
  const hay = s.toLowerCase();
  const ranges: [number, number][] = [];
  for (const raw of list) {
    const t = raw.toLowerCase();
    let from = 0;
    for (;;) {
      const at = hay.indexOf(t, from);
      if (at === -1) break;
      if (!ranges.some(([a, b]) => at < b && at + t.length > a)) ranges.push([at, at + t.length]);
      from = at + t.length;
    }
  }
  if (!ranges.length) return [{ text: s, hit: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Segment[] = [];
  let cursor = 0;
  for (const [a, b] of ranges) {
    push(out, s.slice(cursor, a), false);
    push(out, s.slice(a, b), true);
    cursor = b;
  }
  push(out, s.slice(cursor), false);
  return out;
}

function push(out: Segment[], text: string, hit: boolean): void {
  if (!text) return;
  // Merge runs so a snippet doesn't render as dozens of adjacent spans.
  const last = out[out.length - 1];
  if (last && last.hit === hit) last.text += text;
  else out.push({ text, hit });
}
