import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The two rules this handler kept getting wrong, both found by using the app.
 *
 * Ctrl belongs to the shell: the modifier used to be `metaKey || ctrlKey`, and since
 * the palette branch runs before the typing-target check, Ctrl+K opened the palette
 * with a shell focused.
 *
 * preventDefault is not conditional: shortcuts used to cancel the browser default only
 * when their precondition held, so ⌘R reloaded the page whenever nothing suitable was
 * selected. A shortcut this app claims is claimed always.
 */
vi.mock('$lib/ops.svelte.js', () => ({ promote: vi.fn(), runStack: vi.fn() }));

const { handleShortcut } = await import('./shortcuts.svelte.js');
const { overlays } = await import('$lib/stores/overlays.svelte.js');
const { ui } = await import('$lib/stores/ui.svelte.js');

/** A keydown carrying a real target, since the typing check reads it. */
function press(key: string, opts: KeyboardEventInit = {}, target?: HTMLElement) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  const el = target ?? document.body;
  Object.defineProperty(e, 'target', { value: el, configurable: true });
  handleShortcut(e);
  return e;
}

const textarea = () => {
  const t = document.createElement('textarea');
  document.body.appendChild(t);
  return t;
};

beforeEach(() => {
  document.body.innerHTML = '';
  ui.selectedId = null;
  ui.selectedFeatureName = null;
  while (overlays.any) overlays.escape();
});

describe('the app modifier vs the shell', () => {
  it('does not treat Ctrl+K as the palette — that is the shell’s kill-to-end-of-line', () => {
    // xterm focuses a textarea, so this is what a keypress in a live terminal looks like.
    press('k', { ctrlKey: true }, textarea());
    expect(overlays.any).toBe(false);
  });

  it('still opens the palette on the real modifier', () => {
    const e = press('k', { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves Ctrl+R for the shell rather than running the stack', () => {
    const e = press('r', { ctrlKey: true }, textarea());
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('preventDefault is unconditional', () => {
  // Each of these used to fall through to the browser when its precondition failed:
  // ⌘R reloaded the page, ⌘D bookmarked, ⌘1–9 switched tabs. Same key, different
  // outcome depending on state you cannot see.
  it.each([
    ['r', 'reloading the page'],
    ['d', 'bookmarking'],
    ['1', 'switching browser tabs'],
    ['Enter', 'submitting something'],
  ])('⌘%s does nothing rather than %s when there is no selection', (key) => {
    const e = press(key, { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('Escape', () => {
  it('reaches the terminal when no overlay is open — it is how you interrupt', () => {
    const e = press('Escape', {}, textarea());
    expect(e.defaultPrevented).toBe(false);
  });

  it('closes an overlay when there is one, instead of reaching the pty', () => {
    overlays.togglePalette();
    expect(overlays.any).toBe(true);
    const e = press('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(overlays.any).toBe(false);
  });
});
