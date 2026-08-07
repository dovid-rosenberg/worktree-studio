/**
 * Deep links: the URL fragment that names what is selected.
 *
 * `http://127.0.0.1:7788/#s:s_abc` opens the cockpit on that session. Alfred and the
 * menubar list sessions and features; without this they could only open the app at
 * whatever it happened to be showing, which is a link to the building rather than to
 * the room.
 *
 * The fragment reuses the rail's own key scheme — `s:` session, `f:` feature, `w:`
 * main-checkout server — instead of inventing a second vocabulary for the same three
 * things. The value is percent-encoded: feature names can be manual group names with
 * spaces, and paths can contain anything a directory name can, including the `#` that
 * would otherwise end the fragment.
 *
 * Pure on purpose — no `window` here. The browser wiring (read on load, follow
 * `hashchange`, write on selection) lives in the page component; this half is what the
 * tests can hold still.
 */
import type { Selection } from './stores/ui.svelte.js';

/** `#s:s_abc` → `{ kind: 'session', id: 's_abc' }`. Null for anything unrecognised. */
export function selectionFromHash(hash: string): Selection {
  const raw = (hash || '').replace(/^#/, '');
  // Split on the FIRST colon only: everything after it is one opaque value, and a
  // path is full of colons that are not delimiters.
  const at = raw.indexOf(':');
  if (at < 1) return null;
  const kind = raw.slice(0, at);
  let value: string;
  try {
    value = decodeURIComponent(raw.slice(at + 1));
  } catch {
    return null; // a malformed escape is not a selection
  }
  if (!value) return null;
  if (kind === 's') return { kind: 'session', id: value };
  if (kind === 'f') return { kind: 'feature', name: value };
  if (kind === 'w') return { kind: 'mainserver', path: value };
  return null;
}

/** The inverse. Empty string when nothing is selected — no stale fragment left behind. */
export function hashForSelection(s: Selection): string {
  if (!s) return '';
  if (s.kind === 'session') return `#s:${encodeURIComponent(s.id)}`;
  if (s.kind === 'feature') return `#f:${encodeURIComponent(s.name)}`;
  return `#w:${encodeURIComponent(s.path)}`;
}
