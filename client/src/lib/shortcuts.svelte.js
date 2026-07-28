/*
 * Global keyboard shortcuts, and the cheatsheet that documents them.
 *
 * Precedence, unchanged from app.js:
 *   1. ⌘K always toggles the palette — even from inside a text field.
 *   2. Escape closes the topmost overlay. (A uiDialog handles its own Escape, since it
 *      outranks everything and can be opened from inside another overlay.)
 *   3. ? opens the cheatsheet, but never while typing or over an overlay.
 *   4. Everything else stands down while typing or while an overlay is up.
 *
 * The terminal counts as a typing target implicitly: xterm puts focus on a textarea, so
 * the isTypingTarget() check below already keeps ⌘D and friends out of a live shell.
 */

import { ui } from '$lib/stores/ui.svelte.js';
import { world } from '$lib/stores/world.svelte.js';
import { overlays } from '$lib/stores/overlays.svelte.js';
import { uiDialog } from '$lib/stores/dialog.svelte.js';
import { promote, startSessionServers } from '$lib/ops.svelte.js';

const ROWS = [
  ['⌘K', 'Command palette'],
  ['⌘N', 'New session'],
  ['⌘\\', 'Toggle the Overview pane'],
  ['⌘1–9', 'Jump to the Nth rail row'],
  ['⌘↵', 'Promote current to worktree'],
  ['⌘D', 'Review changes'],
  ['⌘R', 'Run dev servers'],
  ['?', 'This help'],
];

export function showShortcuts() {
  const html = `<div class="kbd-list">${ROWS.map(([k, d]) => `<div class="kbd-row"><kbd>${k}</kbd><span>${d}</span></div>`).join('')}</div>`;
  uiDialog({ title: 'Keyboard shortcuts', messageHtml: html, okLabel: 'Done', cancelLabel: '' });
}

/** @param {EventTarget|null} el */
function isTypingTarget(el) {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** @param {KeyboardEvent} e */
export function handleShortcut(e) {
  const meta = e.metaKey || e.ctrlKey;

  if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); overlays.togglePalette(); return; }

  if (e.key === 'Escape') { overlays.escape(); return; }

  if (e.key === '?' && !isTypingTarget(e.target) && !overlays.any) { e.preventDefault(); showShortcuts(); return; }

  if (isTypingTarget(e.target) || overlays.any || !meta) return;

  const s = ui.selected;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); overlays.openIntake(); return; }
  if (e.key === '\\') { e.preventDefault(); ui.toggleOverview(); return; }
  if (e.key >= '1' && e.key <= '9') {
    // The rail draws agents then features, and a feature may have no session — so a row
    // is picked by what it IS, not by a session id it might not have.
    const pick = ui.railOrder[Number(e.key) - 1];
    if (!pick) return;
    e.preventDefault();
    if (pick.id) ui.goToSession(pick.id);
    else ui.selectFeature(world.features.find((/** @type {any} */ f) => f.name === pick.name));
    return;
  }
  if (e.key === 'Enter') { if (s && !s.worktreePath) { e.preventDefault(); promote(s); } return; }
  if (e.key === 'd' || e.key === 'D') {
    if (s && s.worktreePath) { e.preventDefault(); ui.goToSession(s.id); ui.dockView = 'changes'; }
    return;
  }
  if (e.key === 'r' || e.key === 'R') { if (s && s.worktreePath) { e.preventDefault(); startSessionServers(s); } }
}
