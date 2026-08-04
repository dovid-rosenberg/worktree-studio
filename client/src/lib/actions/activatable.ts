/**
 * Make a click-only span/div keyboard-operable: focusable, role=button (unless one is
 * already set), and Enter/Space activate. ADDITIVE — the existing click still fires.
 *
 * The `e.target === node` guard means a focusable descendant (e.g. a tab's ✕ close
 * button) handles its own keys without double-firing this one. That guard is the whole
 * reason this exists as a shared helper rather than being inlined per call site; it is
 * easy to forget and the resulting double-activation is invisible to mouse users.
 *
 * Svelte action, so it replaces the imperative `activatable(el, fn)` from app.js:
 *   <span use:activatable={() => selectTab(i)}>…</span>
 *
 * Prefer a real <button> where the layout allows one — this is for the cases where it
 * doesn't (grid rows, tab chips with nested controls).
 */
export type ActivateHandler = (e?: Event) => void;

export interface ActivatableAction {
  update(next: ActivateHandler): void;
  destroy(): void;
}

export function activatable(node: HTMLElement, fn: ActivateHandler): ActivatableAction {
  let handler = fn;

  node.setAttribute('tabindex', '0');
  if (!node.getAttribute('role')) node.setAttribute('role', 'button');

  const onClick = (e: Event) => handler?.(e);
  const onKeydown = (e: KeyboardEvent) => {
    if (e.target !== node) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handler?.(e);
    }
  };

  node.addEventListener('click', onClick);
  node.addEventListener('keydown', onKeydown);

  return {
    // Rebinding the callback rather than tearing down keeps focus on the node when a
    // re-render hands us a fresh closure — otherwise keyboard users lose their place.
    update(next: ActivateHandler) {
      handler = next;
    },
    destroy() {
      node.removeEventListener('click', onClick);
      node.removeEventListener('keydown', onKeydown);
    },
  };
}
