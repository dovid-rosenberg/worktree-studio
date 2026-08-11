import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Block } from './model';

/*
 * The header of the file you are currently inside, held at the top edge while you scroll.
 *
 * The viewport is VIRTUAL: every row is absolutely positioned at a computed offset inside
 * a fixed-height canvas, so `position: sticky` has nothing to stick to. The pinned header
 * is therefore a second rendering of the same snippet drawn over the scroller — which is
 * what these tests are really about, since a copy is exactly the kind of thing that drifts
 * away from the original.
 */
// jsdom ships no ResizeObserver, and the viewport uses one to track its own height. It
// never fires here — nothing lays out — so a no-op stub is the whole requirement.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const { default: DiffViewport } = await import('./DiffViewport.svelte');
const { H } = await import('./model.js');

/** A file with `lines` unified rows, enough to scroll past. */
const block = (file: string, lines: number, over: Partial<Block> = {}): Block => ({
  file,
  status: 'M',
  added: lines,
  deleted: 0,
  collapsed: false,
  rename: null,
  busy: false,
  note: null,
  error: null,
  groups: [
    {
      label: '',
      side: null,
      hunks: [
        {
          header: `@@ -1,${lines} +1,${lines} @@`,
          lines: Array.from({ length: lines }, (_, i) => ({ type: 'add', text: `line ${i}` })),
        },
      ],
    },
  ] as unknown as Block['groups'],
  ...over,
});

/** Filenames as the PINNED header shows them, in order. */
const pinnedNames = (c: HTMLElement) =>
  [...c.querySelectorAll('.fileline.pinned .nm')].map((n) => n.textContent);

/** Filenames drawn in the canvas at their own offsets. */
const inlineNames = (c: HTMLElement) =>
  [...c.querySelectorAll('.fileline:not(.pinned) .nm')].map((n) => n.textContent);

/**
 * Scroll the viewport and let the derived state settle.
 *
 * jsdom does not lay anything out, so `clientHeight` is 0 and `scrollTop` is whatever we
 * assign — which is all this component needs, because it positions from the model rather
 * than from measurement.
 */
async function scrollTo(c: HTMLElement, top: number) {
  const vp = c.querySelector('.viewport') as HTMLElement;
  Object.defineProperty(vp, 'scrollTop', { value: top, writable: true, configurable: true });
  vp.dispatchEvent(new Event('scroll'));
  await tick();
}

beforeEach(() => vi.clearAllMocks());

describe('DiffViewport pinned file header', () => {
  it('pins nothing at the top of the list — the real header is right there', async () => {
    const { container } = render(DiffViewport, { props: { blocks: [block('a.ts', 40)] } });
    await tick();
    expect(pinnedNames(container)).toEqual([]);
    expect(inlineNames(container)).toContain('a.ts');
  });

  it('holds the current file once its own row has scrolled past the top', async () => {
    const { container } = render(DiffViewport, { props: { blocks: [block('a.ts', 60)] } });
    // Past the file header and several rows into its body.
    await scrollTo(container, H.file + H.hunk + H.row * 10);
    expect(pinnedNames(container)).toEqual(['a.ts']);
  });

  it('names exactly one file at a time, and it is the one you are inside', async () => {
    /*
     * The bug this guards is an off-by-one at a boundary: pinning the file whose header is
     * the NEXT thing down, so the strip names a file whose contents are not on screen yet.
     */
    const { container } = render(DiffViewport, {
      props: { blocks: [block('a.ts', 20), block('b.ts', 20)] },
    });
    const firstFileEnd = H.file + H.hunk + H.row * 20 + H.gap;

    await scrollTo(container, H.file + H.row * 5);
    expect(pinnedNames(container)).toEqual(['a.ts']);

    await scrollTo(container, firstFileEnd + H.file + H.row * 5);
    expect(pinnedNames(container)).toEqual(['b.ts']);
  });

  it('goes away again when you scroll back to the very top', async () => {
    const { container } = render(DiffViewport, { props: { blocks: [block('a.ts', 60)] } });
    await scrollTo(container, H.file + H.row * 10);
    expect(pinnedNames(container)).toEqual(['a.ts']);
    await scrollTo(container, 0);
    expect(pinnedNames(container)).toEqual([]);
  });

  it('is drawn from the same snippet as the real row, so it carries the same detail', async () => {
    /*
     * Two hand-written copies of this header would drift — it carries a caret, a status
     * letter, a rename note, +/− counts and (while staging) two buttons. Asserting on the
     * rename and the counts is asserting that the copy is a render of one definition.
     */
    const { container } = render(DiffViewport, {
      props: {
        blocks: [block('new/name.ts', 60, { rename: 'was old/name.ts', added: 7, deleted: 3 })],
        stageable: true,
      },
    });
    await scrollTo(container, H.file + H.row * 10);
    const strip = container.querySelector('.fileline.pinned') as HTMLElement;
    expect(strip.querySelector('.ren')?.textContent).toBe('was old/name.ts');
    expect(strip.querySelector('.fstat')?.textContent).toContain('+7');
    expect(strip.querySelector('.fstat')?.textContent).toContain('−3');
    expect(strip.querySelectorAll('.fileacts button')).toHaveLength(2);
  });

  it('collapses from the pinned header and brings that header back into view', async () => {
    /*
     * The row you pressed is off-screen above. Collapsing it without scrolling would drop
     * you into the middle of some later file with nothing to say what happened.
     */
    const ontoggle = vi.fn();
    const { container } = render(DiffViewport, {
      props: { blocks: [block('a.ts', 60), block('b.ts', 60)], ontoggle },
    });
    const vp = container.querySelector('.viewport') as HTMLElement;
    await scrollTo(container, H.file + H.row * 20);

    (container.querySelector('.fileline.pinned .filehd') as HTMLElement).click();
    await tick();
    expect(ontoggle).toHaveBeenCalledWith('a.ts');
    await tick();
    expect(vp.scrollTop).toBeLessThan(H.file + H.row * 20);
  });

  it('hides the copy from assistive technology, and leaves nothing focusable inside it', async () => {
    /*
     * The real row is still in the document (the overscan keeps it rendered for a while
     * after it leaves the viewport), so a screen reader meeting both would hear the
     * filename twice — hence aria-hidden.
     *
     * The second half is the part that is easy to get wrong: a FOCUSABLE element inside an
     * aria-hidden subtree lets you tab to something the screen reader has been told is not
     * there. `use:activatable` sets tabindex="0", so the pinned header must not use it, and
     * its Stage buttons carry tabindex="-1". `[` and `]` already jump file headers, so the
     * keyboard loses nothing.
     */
    const { container } = render(DiffViewport, {
      props: { blocks: [block('a.ts', 60)], stageable: true },
    });
    await scrollTo(container, H.file + H.row * 10);
    const strip = container.querySelector('.fileline.pinned') as HTMLElement;
    expect(strip).toHaveAttribute('aria-hidden', 'true');
    for (const el of strip.querySelectorAll('button, [tabindex]')) {
      expect(Number(el.getAttribute('tabindex'))).toBeLessThan(0);
    }
  });
});
