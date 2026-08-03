/*
 * Global keyboard shortcuts, and the cheatsheet that documents them.
 *
 * Precedence:
 *   1. ⌘K toggles the palette, even from inside a text field.
 *   2. Escape closes the topmost overlay — but ONLY if one is open, so a bare Escape
 *      still reaches the shell. (A uiDialog handles its own Escape, since it outranks
 *      everything and can be opened from inside another overlay.)
 *   3. ? opens the cheatsheet, but never while typing or over an overlay.
 *   4. Everything else stands down while typing or while an overlay is up.
 *
 * Two rules this file gets wrong easily, both found by using it:
 *
 * CTRL BELONGS TO THE SHELL — when a shell has focus. The modifier used to be
 * `metaKey || ctrlKey`, which made every shortcut answer to Ctrl as well; and since the
 * ⌘K branch runs before the typing-target check, Ctrl+K opened the palette with a shell
 * focused, costing readline its kill-to-end-of-line.
 *
 * The rule is about focus, not platform. Sniffing the OS was the first attempt and it
 * was worse: it made behaviour differ between environments for a reason nothing on
 * screen explains. Cmd is always the app's; Ctrl is the app's only where no text field
 * or terminal is listening for it.
 *
 * PREVENTDEFAULT IS NOT CONDITIONAL. Each shortcut used to cancel the browser default
 * only when its precondition held, so ⌘R reloaded the page whenever nothing suitable
 * was selected, ⌘D bookmarked, and ⌘1–9 switched browser tabs. A shortcut this app
 * claims is claimed always: failing to act is a no-op, not a fallthrough to the browser.
 *
 * CMD IS NOT A TYPING KEY. isTypingTarget() used to stand every shortcut down whenever
 * xterm's textarea had focus — which is nearly always, since that is where you work. So
 * ⌘D, ⌘R and the rest quietly did nothing in the one state the app is normally in, and
 * only worked after clicking away. But ⌘ combinations never reach a shell on macOS:
 * there is no control code to steal. Only Ctrl has to stand down, and it already does.
 * The typing guard now covers Ctrl and bare keys, not ⌘ and ⌥.
 */

import { ui } from '$lib/stores/ui.svelte.js';
import { world } from '$lib/stores/world.svelte.js';
import { overlays } from '$lib/stores/overlays.svelte.js';
import { uiDialog } from '$lib/stores/dialog.svelte.js';
import { promote, runStack } from '$lib/ops.svelte.js';

const ROWS: [string, string][] = [
  ['⌘K', 'Command palette'],
  ['⌘N', 'New session'],
  ['⌘\\', 'Toggle Insights'],
  ['⌥1–9', 'Jump to the Nth rail row'],
  ['⌘↵', 'Promote current to worktree'],
  ['⌘D', 'Review changes'],
  ['⌘R', 'Run stack'],
  ['⇧↵', 'New line in the terminal (sent as ESC+CR)'],
  ['?', 'This help'],
];

export function showShortcuts(): void {
  const html = `<div class="kbd-list">${ROWS.map(([k, d]) => `<div class="kbd-row"><kbd>${k}</kbd><span>${d}</span></div>`).join('')}</div>`;
  uiDialog({ title: 'Keyboard shortcuts', messageHtml: html, okLabel: 'Done', cancelLabel: '' });
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function handleShortcut(e: KeyboardEvent): void {
  const typing = isTypingTarget(e.target);
  // Cmd is always ours. Ctrl is ours only when nothing is listening for control codes.
  const mod = e.metaKey || (e.ctrlKey && !typing);

  if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); overlays.togglePalette(); return; }

  // Only swallow Escape when there is something to close. A bare Escape is how you
  // interrupt the agent, and it has to reach the pty.
  if (e.key === 'Escape') { if (overlays.any) { e.preventDefault(); overlays.escape(); } return; }

  if (e.key === '?' && !typing && !overlays.any) { e.preventDefault(); showShortcuts(); return; }

  /*
   * ⌥1–9 rather than ⌘1–9. Chrome reserves ⌘1–8 for tab switching in a normal tab and a
   * page cannot take them back, so the shortcut fired or did not depending on the
   * browser's mood. Option is unclaimed.
   *
   * Matched on `e.code`, not `e.key`: on macOS Option+1 produces '¡', so keying off the
   * character finds nothing. `Digit1`..`Digit9` is the physical key either way.
   */
  if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code) && !overlays.any) {
    e.preventDefault();
    // The rail draws agents then features, and a feature may have no session — so a row
    // is picked by what it IS, not by a session id it might not have.
    const pick = ui.railOrder[Number(e.code.slice(5)) - 1];
    if (!pick) return;
    if (pick.id) ui.goToSession(pick.id);
    else ui.selectFeature(world.features.find((f) => f.name === pick.name));
    return;
  }

  if (overlays.any || !mod) return;

  const s = ui.selected;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); overlays.openIntake(); return; }
  if (e.key === '\\') { e.preventDefault(); ui.toggleUsage(); return; }
  if (e.key === 'Enter') { e.preventDefault(); if (s && !s.worktreePath) promote(s); return; }
  if (e.key === 'd' || e.key === 'D') {
    e.preventDefault();
    if (s && s.worktreePath) { ui.goToSession(s.id); ui.dockView = 'changes'; }
    return;
  }
  // ⌘R is 'Run stack' in the cheatsheet, so it runs the stack — it used to call the
  // session-addressed op, which is the same worktrees without the conflict handling.
  if (e.key === 'r' || e.key === 'R') { e.preventDefault(); if (s && s.worktreePath && s.feature) runStack(s.feature); }
}
