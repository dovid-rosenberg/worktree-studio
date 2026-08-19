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
const { world } = await import('$lib/stores/world.svelte.js');

/** Drive the store the way the stream does: the same three halves the daemon sends. */
function give(sessions: unknown[], reviews: unknown[]) {
  world.topology = { features: [], groups: [], repos: [], webRepos: [], baseDirs: [] } as never;
  world.sessionHalf = { sessions, servers: {} } as never;
  world.ciHalf = { ci: {}, reviews } as never;
  ui.repoFilter = '';
  ui.rootFilter = '';
}

const review = (number: number, title: string) => ({
  repo: 'accept-blue',
  number,
  title,
  author: 'kim',
  draft: false,
  url: `https://example.invalid/${number}`,
  updatedAt: new Date().toISOString(),
});

const session = (id: string) => ({
  id,
  title: id,
  state: 'idle',
  activity: '',
  muxName: `m-${id}`,
  repoName: 'accept-blue',
  worktreePath: null,
});

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
  ui.clearSelection();
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
  ])('⌘%s does nothing rather than %s when there is no selection', (key) => {
    const e = press(key, { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
  });

  /*
   * ⌘↵ is the exception, and deliberately so: it belongs to the TERMINAL, where it is
   * "newline without submitting". It used to be Promote — and was broken as well as
   * conflicting, because preventDefault() ran before the `!worktreePath` guard, so on an
   * already-promoted session it was swallowed and did nothing at all.
   */
  it('⌘↵ is NOT swallowed — the terminal needs it for a newline', () => {
    const e = press('Enter', { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
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

describe('⌘ works where you actually are — with the terminal focused', () => {
  // isTypingTarget used to stand every shortcut down whenever xterm's textarea had
  // focus, which is nearly always. ⌘D quietly did nothing until you clicked away, and
  // that state is invisible. ⌘ never reaches a shell, so it has no reason to defer.
  it.each(['d', 'r', 'n'])('⌘%s still fires from the terminal', (key) => {
    const e = press(key, { metaKey: true }, textarea());
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('⌥1–9 for the rail', () => {
  it('matches the physical key, since ⌥1 types “¡” on macOS', () => {
    // Keying off e.key would find '¡' and never match — the bug this guards.
    const e = press('¡', { altKey: true, code: 'Digit1' } as KeyboardEventInit);
    expect(e.defaultPrevented).toBe(true);
  });

  it('no longer answers to ⌘1, which Chrome reserves for its own tabs', () => {
    const e = press('1', { metaKey: true, code: 'Digit1' } as KeyboardEventInit);
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores ⌥ combined with another modifier', () => {
    const e = press('¡', { altKey: true, ctrlKey: true, code: 'Digit1' } as KeyboardEventInit);
    expect(e.defaultPrevented).toBe(false);
  });

  /*
   * A REVIEW ROW IS A REAL TARGET, not a hole and not a landmine.
   *
   * railOrder counted reviews (a hole would shift every digit below it) but flattened
   * them to `{kind:'feature', name:<merge-request title>}`, and the handler resolved that
   * by looking the name up in `world.features`. No feature is named after a merge
   * request, so `selectFeature(undefined)` cleared the selection: ⌥ on any review row
   * discarded whatever you had open, and the card did not even show the digit.
   */
  describe('a review row', () => {
    it('selects the review — it does not clear the selection', () => {
      give([], [review(4821, 'Retry the webhook')]);
      expect(ui.railOrder).toHaveLength(1);

      press('¡', { altKey: true, code: 'Digit1' } as KeyboardEventInit);

      expect(ui.selection).toEqual({ kind: 'review', id: 'accept-blue!4821' });
    });

    it('does not wipe the row above it — reviews sort last, so ⌥2 is the review', () => {
      give([session('s1')], [review(4821, 'Retry the webhook')]);
      press('¡', { altKey: true, code: 'Digit1' } as KeyboardEventInit);
      expect(ui.selection).toEqual({ kind: 'session', id: 's1' });

      press('™', { altKey: true, code: 'Digit2' } as KeyboardEventInit);
      expect(ui.selection).toEqual({ kind: 'review', id: 'accept-blue!4821' });
    });

    it('the digit the card advertises is the one that selects it', () => {
      give([session('s1')], [review(4821, 'Retry the webhook'), review(4822, 'Drop the index')]);
      // The card looks its digit up by row key; the handler indexes railOrder. They are
      // built from one filter, so the two have to agree for every row.
      const rows = ui.railRows.filter((r) => r.kind !== 'mainserver');
      expect(ui.railDigits.get(rows[2].key)).toBe(3);

      press('£', { altKey: true, code: 'Digit3' } as KeyboardEventInit);

      expect(ui.selection).toEqual({ kind: 'review', id: 'accept-blue!4822' });
    });
  });
});

/*
 * Search has been buried twice — a section of the session-scoped Insights tab, then a
 * drill-down inside fleet Insights. Both times it was something you could only reach
 * after arriving somewhere else for a different reason. These pin that it is reachable
 * on its own.
 */
describe('⌘⇧F opens transcript search', () => {
  it('opens search from anywhere', () => {
    const e = press('f', { metaKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(overlays.search).toBe(true);
    overlays.closeSearch();
  });

  it('still works with the palette open — they are the same thought', () => {
    overlays.togglePalette();
    expect(overlays.any).toBe(true);
    press('f', { metaKey: true, shiftKey: true });
    expect(overlays.search).toBe(true);
    // Opening search closes the palette rather than stacking two overlays.
    expect(overlays.palette).toBe(false);
    overlays.closeSearch();
  });

  it('does not fire without shift — a bare ⌘F is the browser find-in-page', () => {
    press('f', { metaKey: true });
    expect(overlays.search).toBe(false);
  });

  /*
   * This used to assert the opposite — that Escape closed search even with settings
   * opened on top of it — because the dismissal order was hardcoded as palette, search,
   * settings, intake regardless of what happened. Escape now closes whatever is actually
   * on top, so the surface you are looking at is the one that goes. See overlays.test.ts.
   */
  it('Escape closes whichever of the two was opened last', () => {
    overlays.openSearch();
    overlays.openSettings();
    press('Escape');
    expect(overlays.settings, 'settings was opened on top, so settings closes').toBe(false);
    expect(overlays.search, 'search is underneath and survives').toBe(true);

    press('Escape');
    expect(overlays.search).toBe(false);
    expect(overlays.any).toBe(false);
  });
});
