<script lang="ts">
/*
 * The drag handle between rail and dock.
 *
 * Pointer events (not mouse) with setPointerCapture, so a fast drag that outruns the
 * 5px handle keeps tracking instead of dropping — the classic splitter bug. The width
 * is committed to the store on every move because the store is what `--rail-w` reads;
 * localStorage is only written on release, so a drag is one write, not two hundred.
 *
 * Keyboard-resizable too: it is a real separator, and a pointer-only splitter is
 * unreachable for anyone who cannot drag.
 */
import { ui, RAIL_MIN, RAIL_MAX } from '$lib/stores/ui.svelte.js';

let dragging = $state(false);

/** @param {PointerEvent} e */
function down(e: PointerEvent) {
  dragging = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
}

/** @param {PointerEvent} e */
function move(e: PointerEvent) {
  if (!dragging) return;
  // The rail starts at the viewport's left edge, so clientX IS the width.
  ui.railWidth = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(e.clientX)));
}

/** @param {PointerEvent} e */
function up(e: PointerEvent) {
  if (!dragging) return;
  dragging = false;
  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  ui.setRailWidth(ui.railWidth); // clamp + persist once, at the end of the gesture
}

/** @param {KeyboardEvent} e */
function key(e: KeyboardEvent) {
  const step = e.shiftKey ? 40 : 12;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    ui.setRailWidth(ui.railWidth - step);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    ui.setRailWidth(ui.railWidth + step);
  } else if (e.key === 'Home') {
    e.preventDefault();
    ui.setRailWidth(RAIL_MIN);
  } else if (e.key === 'End') {
    e.preventDefault();
    ui.setRailWidth(RAIL_MAX);
  }
}
</script>

<!--
  A <button> element carrying role="separator".

  The pattern being implemented is the WAI-ARIA window splitter: a FOCUSABLE separator
  with aria-valuenow/min/max, which is how a resizable pane divider is specified. Getting
  there from a <div> needs tabindex="0" plus handlers on a non-interactive element, which
  is both a lint failure and a genuine accessibility smell — the element is interactive,
  so it should be an interactive element.

  Using the button element and overriding its role gives the correct answer on both
  counts: native focusability and activation semantics (no tabindex needed, no synthetic
  keyboard handling to get focus), while `role="separator"` keeps assistive tech
  announcing a divider with a width value rather than a button that does nothing when
  pressed. type="button" so it can never submit anything.

  The linter objects in BOTH directions — a <div> "cannot have nonnegative tabIndex" and
  a <button> "cannot have role 'separator'" — so one suppression is unavoidable. This is
  the cheaper one: it silences a rule about role overriding, on markup that is otherwise
  natively correct, rather than two rules covering up a non-interactive element pretending
  to be interactive.
-->
<!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
<button
  type="button"
  class="splitter"
  class:on={dragging}
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize the rail"
  aria-valuenow={ui.railWidth}
  aria-valuemin={RAIL_MIN}
  aria-valuemax={RAIL_MAX}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
></button>

<style>
  /* 5px of hit area, 1px of visible line — a 1px target is not draggable.
     padding/appearance are reset because this is a <button>: see the markup note. */
  .splitter {
    width: 5px; margin-left: -2px; margin-right: -2px; cursor: col-resize;
    background: transparent; position: relative; z-index: 5; flex: none;
    padding: 0; border: 0; appearance: none; font: inherit; color: inherit;
    align-self: stretch; /* a button does not fill its grid row on its own */
    touch-action: none; /* or the browser scrolls instead of dragging */
  }
  .splitter::after {
    content: ''; position: absolute; inset: 0 2px; background: var(--border);
    transition: background .12s;
  }
  .splitter:hover::after, .splitter.on::after, .splitter:focus-visible::after { background: var(--brand); }
  @media (prefers-reduced-motion: reduce) { .splitter::after { transition: none; } }
</style>
