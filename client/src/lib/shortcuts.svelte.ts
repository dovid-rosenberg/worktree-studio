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
import { overlays } from '$lib/stores/overlays.svelte.js';
import { uiDialog } from '$lib/stores/dialog.svelte.js';
import { runStack } from '$lib/ops.svelte.js';
import { toast } from '$lib/stores/toasts.svelte.js';

/*
 * What the app ACTUALLY binds — checked against the handlers, not remembered.
 *
 * The previous list carried `⇧↵` twice, and the second row described it as "sent as
 * ESC+CR" — which is not merely a duplicate but a description of an approach
 * Terminal.svelte's own comment records as having been tried and specifically NOT
 * working. It sends LF. Five real bindings were missing, including Escape, which is the
 * most consequential key in the app.
 *
 * Grouped, because a flat list of eleven gives no clue that half of them only do anything
 * while the terminal has focus.
 */
const ROWS: [string, string][] = [
  ['⌘K', 'Command palette'],
  ['⌘⇧F', 'Search every transcript'],
  // Genuinely bound (and Ctrl+N works), but Chrome and Safari claim ⌘N at the browser
  // level and a page cannot preventDefault it — so on macOS this may never reach us.
  // Kept rather than dropped: the binding is real, and ＋ New session is always there.
  ['⌘N', 'New session'],
  ['⌘\\', 'Toggle Insights'],
  ['⌘D', 'Review changes'],
  ['⌘R', 'Run stack'],
  ['⌥1–9', 'Jump to the Nth rail row — the number is on the card'],
  ['F2', 'Rename the current terminal tab'],
  ['Esc', 'Close the topmost overlay, or interrupt the agent when nothing is open'],
  ['?', 'This help'],
  // Terminal-only: these are handled by the pane and do nothing elsewhere.
  ['⌘↵ / ⇧↵', 'Terminal: new line without submitting'],
  ['⌘← / ⌘→', 'Terminal: start / end of line'],
  ['⌘⌫', 'Terminal: delete to start of line'],
  ['⌥← / ⌥→', 'Terminal: move by word'],
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

  if (mod && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    overlays.togglePalette();
    return;
  }

  /*
   * ⌘⇧F — search every transcript, from anywhere.
   *
   * Checked BEFORE the `overlays.any` gate further down, because it has to work while
   * the palette is open: "Search transcripts" is one of the palette's commands, so the
   * two are the same thought and the key should not stop working half way through it.
   *
   * ⇧ is what keeps it usable: a bare ⌘F is the browser's find-in-page, and ⌘⇧F is what
   * editors already use for search-across-everything.
   */
  if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    overlays.openSearch();
    return;
  }

  // Only swallow Escape when there is something to close. A bare Escape is how you
  // interrupt the agent, and it has to reach the pty.
  if (e.key === 'Escape') {
    if (overlays.any) {
      e.preventDefault();
      overlays.escape();
    }
    return;
  }

  if (e.key === '?' && !typing && !overlays.any) {
    e.preventDefault();
    showShortcuts();
    return;
  }

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
    /*
     * A row is picked by WHAT IT IS — the tagged selection railOrder carries — not by a
     * name looked up in a list.
     *
     * The lookup was `world.features.find(f => f.name === pick.name)`, and a review row
     * came through as a feature named after a merge-request title. Nothing matched, so
     * `selectFeature(undefined)` fell through to clearing the selection: ⌥ on any review
     * row wiped whatever you had open.
     */
    const pick = ui.railOrder[Number(e.code.slice(5)) - 1];
    if (pick) ui.goTo(pick);
    return;
  }

  if (overlays.any || !mod) return;

  const s = ui.selected;
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    overlays.openIntake();
    return;
  }
  if (e.key === '\\') {
    e.preventDefault();
    ui.toggleUsage();
    return;
  }
  /*
   * ⌘↵ belongs to the TERMINAL — it is "newline without submitting" there (Terminal.svelte
   * maps it to LF, like every macOS terminal).
   *
   * It used to be Promote, and it was broken as well as conflicting: preventDefault() ran
   * BEFORE the `!s.worktreePath` guard, so on an already-promoted session — which is most
   * of them — the key was swallowed and did nothing at all. Promote is still on the
   * ActionBar and in the palette, which is where a once-per-session verb belongs.
   */
  /*
   * preventDefault stays UNCONDITIONAL — see the tests of the same name.
   *
   * The review proposed falling through to the browser when there is nothing to act on.
   * That trades one problem for a worse one: ⌘R would reload the page, destroying every
   * terminal view, depending on invisible selection state. A key whose outcome varies
   * with something you cannot see is harder to live with than one that reliably does
   * nothing. What was actually wrong is that it did nothing SILENTLY — so it now says why.
   */
  if (e.key === 'd' || e.key === 'D') {
    e.preventDefault();
    if (!s?.worktreePath) {
      toast('Select a session with a worktree to review its changes');
      return;
    }
    ui.goToSession(s.id);
    // setDockView, not the field: it is the only writer that persists the choice.
    ui.setDockView('changes');
    return;
  }
  // ⌘R is 'Run stack' in the cheatsheet, so it runs the stack — it used to call the
  // session-addressed op, which is the same worktrees without the conflict handling.
  if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    if (!s?.worktreePath || !s.feature) {
      toast('Select a promoted session to run its stack');
      return;
    }
    runStack(s.feature);
  }
}
