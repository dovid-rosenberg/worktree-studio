// Tab-focusable descendants of an open overlay, in DOM order (visible ones only).
const FOCUSABLE_SEL =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function focusablesIn(container) {
  return /** @type {HTMLElement[]} */ ([...container.querySelectorAll(FOCUSABLE_SEL)]).filter(
    // offsetParent is null for display:none subtrees — a cheap visibility test that
    // keeps hidden tab panels out of the cycle. The activeElement exception covers
    // position:fixed elements, whose offsetParent is also null.
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Trap Tab / Shift+Tab within `node` so focus can't reach the background while an
 * overlay is open. Svelte action form of app.js's `trapFocus(container)`; the returned
 * `destroy` replaces the cleanup fn the old code stored in `modalTrap`/`settingsTrap`.
 *
 * The list is recomputed on every keypress rather than cached at setup, because overlay
 * contents change while open (issue lists load, fields appear) and a stale list would
 * strand focus on a removed node.
 *
 * @param {HTMLElement} node
 * @param {{ enabled?: boolean, restoreFocus?: boolean }} [opts]
 */
export function trapFocus(node, opts = {}) {
  let enabled = opts.enabled !== false;
  const restoreFocus = opts.restoreFocus !== false;
  // Captured at mount so closing returns keyboard focus where it was — the pairing the
  // old code kept in `modalPrevFocus`, now owned by the overlay's own lifetime.
  const prevFocus = /** @type {HTMLElement|null} */ (document.activeElement);

  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (!enabled || e.key !== 'Tab') return;
    const items = focusablesIn(node);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  node.addEventListener('keydown', onKey);

  return {
    update(/** @type {{ enabled?: boolean }} */ next = {}) { enabled = next.enabled !== false; },
    destroy() {
      node.removeEventListener('keydown', onKey);
      if (restoreFocus && prevFocus && document.contains(prevFocus)) {
        try { prevFocus.focus(); } catch { /* node may have become unfocusable */ }
      }
    },
  };
}
