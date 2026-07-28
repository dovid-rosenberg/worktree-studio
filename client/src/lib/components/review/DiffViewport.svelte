<script lang="ts">
  import type { Item } from './model';
  /*
   * The windowed diff surface: one scroll container for the whole detail view — every
   * file header, group label, hunk header and diff row of every file in the selected
   * commit — rendering only the slice that is on screen.
   *
   * WHY IT IS WINDOWED. A single commit in this repo's own history reaches ~4k diff
   * lines; a vendored-lockfile commit reaches far more, and side-by-side doubles the
   * element count per row. Rendering all of it produces tens of thousands of DOM nodes,
   * which is what locks the browser. Here the item list is flat and every item's height
   * is known up front (see model.js), so:
   *
   *   scrollTop ─binary search→ first visible item ─prefix sums→ last visible item
   *   render only [first-OVERSCAN, last+OVERSCAN], absolutely positioned at their offsets
   *
   * The scroll canvas is a fixed-size box (total height from the prefix sum, width from
   * the widest line in `ch`), so the scrollbar is correct and stable from the first frame
   * and the canvas does not resize as rows scroll in and out. Cost per frame is O(window),
   * independent of diff size.
   *
   * TRADE-OFF, stated plainly: off-screen rows are not in the DOM, so the browser's own
   * Ctrl-F cannot find them. That is why `n`/`p`/`[`/`]` navigation and the cursor exist.
   */
  import { buildItems, indexAt, navigable, statusInfo, H } from './model.js';
  import { activatable } from '$lib/actions/activatable.js';
  import { trapFocus } from '$lib/actions/trapFocus.js';

  let {
    /** @type {import('./model.js').Block[]} */
    blocks,
    view = ('unified' as 'unified'|'split'),
    /** True on the uncommitted entry: hunk and file staging controls are shown. */
    stageable = false,
    /** @type {(file:string) => void} */
    ontoggle = () => {},
    /** @type {(a:{ op:'stage'|'unstage', file:string, hunks:number[], expect:string[] }) => void} */
    onapply = () => {},
  } = $props();

  /** Extra items rendered above and below the viewport so a fast flick never shows blank. */
  const OVERSCAN = 8;

  let scroller = $state<HTMLElement|null>(null);
  let scrollTop = $state(0);
  let viewH = $state(600);
  let cursor = $state(0);
  let focused = $state(false);

  /*
   * SIDE-BY-SIDE HORIZONTAL SCROLLING. Unified has one text column, so the canvas can
   * simply be as wide as the widest line and the pane's own scrollbar does the work.
   * Side-by-side cannot: a canvas holding two columns of the widest line is routinely
   * 3000px+ — ONE long line anywhere in the diff is enough — and the right-hand column
   * then begins past the edge of the pane. Scroll to reach it and the left-hand column
   * is gone instead. Both columns have to stay on screen at all times.
   *
   * So in split the canvas is exactly the pane width, each column clips its own text,
   * and each column carries its OWN offset — `--hxl` and `--hxr` — driven by its own
   * scrollbar under the pane. Independent by design: a 260-column line on the right is
   * a fact about the new file, and dragging the unchanged left column sideways to read
   * it would be pure collateral damage. Vertical stays shared and therefore exactly in
   * step, because both sides of a row are still one element in one scroller.
   */
  let barL = $state<HTMLElement|null>(null);
  let barR = $state<HTMLElement|null>(null);
  let hxL = $state(0);
  let hxR = $state(0);
  /** Percent-of-travel for each scrollbar's `aria-valuenow`. */
  let pctL = $state(0);
  let pctR = $state(0);
  /** One arrow-key press of sideways travel, in px. Roughly eight monospace columns. */
  const HSTEP = 60;

  const model = $derived(buildItems(blocks, view));
  const items = $derived(model.items);
  const split = $derived(view === 'split');

  // Reset the cursor whenever the underlying list identity changes (new commit, view
  // flip, a file collapsed) rather than leaving it pointing at an unrelated row.
  $effect(() => {
    const n = items.length;
    if (cursor >= n) cursor = Math.max(0, n - 1);
  });

  // A new commit or a layout flip starts at column 0 — carrying a horizontal offset over
  // would open the next file scrolled halfway into a line for no reason.
  $effect(() => {
    void blocks; void view;
    hxL = 0; hxR = 0; pctL = 0; pctR = 0;
    if (barL) barL.scrollLeft = 0;
    if (barR) barR.scrollLeft = 0;
  });

  const first = $derived(Math.max(0, indexAt(model.offsets, scrollTop, items.length) - OVERSCAN));
  const last = $derived(Math.min(items.length, indexAt(model.offsets, scrollTop + viewH, items.length) + OVERSCAN + 1));
  /** Absolute indexes of the rendered slice — keyed by index so Svelte reuses nodes. */
  const window_ = $derived(Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i));

  function onScroll() {
    if (scroller) scrollTop = scroller.scrollTop;
  }

  /** Publish a bar's scrollLeft to the column it drives. @param {'l'|'r'} which */
  function onBarScroll(which: 'l' | 'r') {
    const bar = which === 'l' ? barL : barR;
    if (!bar) return;
    const max = bar.scrollWidth - bar.clientWidth;
    const pct = max > 0 ? Math.round((bar.scrollLeft / max) * 100) : 0;
    if (which === 'l') { hxL = bar.scrollLeft; pctL = pct; }
    else { hxR = bar.scrollLeft; pctR = pct; }
  }

  /**
   * Trackpad sideways swipes and Shift+wheel are how people actually scroll a diff
   * horizontally. In split the canvas itself does not scroll, so the gesture would fall
   * on the floor — route it to the bar for the column the pointer is over, which is the
   * only reading of "scroll this sideways" that respects two independent columns.
   * @param {WheelEvent} e
   */
  function onWheel(e: WheelEvent) {
    if (!split || !scroller) return;
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    if (!dx) return;
    const box = scroller.getBoundingClientRect();
    const bar = e.clientX < box.left + box.width / 2 ? barL : barR;
    if (!bar || bar.scrollWidth <= bar.clientWidth) return;
    e.preventDefault();
    bar.scrollLeft += dx;
  }

  $effect(() => {
    if (!scroller) return;
    const ro = new ResizeObserver(() => { if (scroller) viewH = scroller.clientHeight; });
    ro.observe(scroller);
    viewH = scroller.clientHeight;
    return () => ro.disconnect();
  });

  /**
   * Scroll an item into view. The window is derived from scrollTop, so moving the cursor
   * and then scrolling is enough — the item is guaranteed to be rendered on the next tick.
   * @param {number} i
   */
  function reveal(i: number) {
    if (!scroller || i < 0 || i >= items.length) return;
    const top = model.offsets[i];
    const bottom = top + H[items[i].k];
    const pad = H.row * 2;
    if (top - pad < scroller.scrollTop) scroller.scrollTop = Math.max(0, top - pad);
    else if (bottom + pad > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom + pad - scroller.clientHeight;
    }
  }

  /**
   * Move the cursor to the next item matching `pred`, in `dir`. Used for ↑/↓ (any
   * navigable item), n/p (hunk headers) and [/] (file headers).
   * @param {number} dir
   * @param {(it:import('./model.js').Item) => boolean} pred
   */
  function move(dir: number, pred: (it: Item) => boolean) {
    for (let i = cursor + dir; i >= 0 && i < items.length; i += dir) {
      if (pred(items[i])) { cursor = i; reveal(i); return true; }
    }
    return false;
  }

  /** The hunk indexes + `@@` headers a stage/unstage of `g` would send. */
  function selectionOf(g: import('./model.js').Group) {
    return { hunks: g.hunks.map((h) => h.index), expect: g.hunks.map((h) => h.header) };
  }

  /**
   * Apply the cursor's implied stage/unstage. On a hunk header that is one hunk; on a
   * group or file header it is every hunk on the matching side — which is exactly the
   * file-level staging the panel also exposes as a button, driven from the keyboard.
   * @param {'stage'|'unstage'} op
   */
  function applyAtCursor(op: 'stage' | 'unstage') {
    const it = items[cursor];
    if (!it || !stageable) return;
    const side = op === 'stage' ? 'unstaged' : 'staged';
    if (it.k === 'hunk') {
      if (it.g.side !== side) return;
      onapply({ op, file: it.b.file, hunks: [it.hunk.index], expect: [it.hunk.header] });
      return;
    }
    const b = it.k === 'gap' ? null : it.b;
    if (!b) return;
    const g = (it.k === 'group' && it.g.side === side ? it.g : b.groups.find((x) => x.side === side));
    if (!g || !g.hunks.length) return;
    onapply({ op, file: b.file, ...selectionOf(g) });
  }

  /** @param {KeyboardEvent} e */
  function onKeydown(e: KeyboardEvent) {
    // A real control inside a rendered row owns its own keys; only the panel-wide
    // shortcuts that cannot collide with typing are honoured from there.
    const inControl = e.target !== scroller;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (inControl && e.key !== 'Escape') return;

    switch (e.key) {
      case 'ArrowDown': case 'j': move(1, navigable); break;
      case 'ArrowUp': case 'k': move(-1, navigable); break;
      // In unified the pane itself scrolls sideways, so let the browser have the key.
      // In split, ←/→ from the diff surface walk BOTH columns — reading across a row is
      // the common case. The two scrollbars below are in the tab order for the times the
      // columns need to move apart.
      case 'ArrowLeft': case 'ArrowRight': {
        if (!split) return;
        const dx = e.key === 'ArrowRight' ? HSTEP : -HSTEP;
        if (barL) barL.scrollLeft += dx;
        if (barR) barR.scrollLeft += dx;
        break;
      }
      case 'PageDown': jump(Math.floor(viewH / H.row)); break;
      case 'PageUp': jump(-Math.floor(viewH / H.row)); break;
      case 'Home': cursor = 0; reveal(0); break;
      case 'End': cursor = items.length - 1; reveal(cursor); break;
      case 'n': move(1, (it) => it.k === 'hunk'); break;
      case 'p': move(-1, (it) => it.k === 'hunk'); break;
      case ']': move(1, (it) => it.k === 'file'); break;
      case '[': move(-1, (it) => it.k === 'file'); break;
      case 's': applyAtCursor('stage'); break;
      case 'u': applyAtCursor('unstage'); break;
      case 'f': case '/': openJump(); break;
      case 'Enter': case ' ': {
        const it = items[cursor];
        if (it && it.k === 'file') ontoggle(it.b.file);
        else return; // let the browser have the key
        break;
      }
      case 'Escape': if (scroller) scroller.focus(); break;
      default: return;
    }
    e.preventDefault();
  }

  /** @param {number} n */
  function jump(n: number) {
    const dir = n < 0 ? -1 : 1;
    for (let i = 0; i < Math.abs(n); i++) if (!move(dir, navigable)) break;
  }

  /**
   * Clicking the diff must put the keyboard ON the diff. Nothing inside the surface is
   * focusable except the row controls, so a plain click on a diff line left focus on
   * <body>: a mouse user who clicked a hunk and pressed `s` got nothing, and the cursor,
   * `n`/`p` and `f` were reachable only by tabbing in from elsewhere.
   *
   * Deferred, and only when the press left focus on <body>, so it can never steal focus
   * from a Stage button or a file header that legitimately took it.
   */
  function onPointerDown() {
    queueMicrotask(() => {
      if (scroller && document.activeElement === document.body) scroller.focus({ preventScroll: true });
    });
  }

  /**
   * Keyboard focus can be sitting on a button inside a row that the next scroll unmounts.
   * Without this the focus falls to <body> and arrow keys stop working mid-review, which
   * is the classic way a virtualized list breaks for keyboard users.
   */
  function onFocusout() {
    queueMicrotask(() => {
      if (!scroller || !focused) return;
      if (!scroller.contains(document.activeElement) && document.activeElement === document.body) {
        scroller.focus({ preventScroll: true });
      }
    });
  }

  /* ---------------- the file list (`f`) ----------------
   *
   * Windowing has one honest cost — off-screen rows are not in the DOM, so the browser's
   * own Ctrl-F cannot find them — and `[` / `]` walk files one at a time, which is fine
   * for the third file of five and useless for the fortieth of sixty. This is the way
   * back: type part of a path, land on its header.
   *
   * It reads the same item list the viewport draws, so "jump" is just a cursor move; no
   * second model of what is in the diff, and nothing to keep in sync.
   */
  let jumpOpen = $state(false);
  let jumpQuery = $state('');
  let jumpAt = $state(0);
  let jumpInput = $state<HTMLInputElement|null>(null);

  /** Built only while open — on a 100k-item list this is a full pass. */
  const jumpFiles = $derived.by(() => {
    if (!jumpOpen) return [];
        const out: { i:number, b:import('./model.js').Block }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.k === 'file') out.push({ i, b: it.b });
    }
    return out;
  });
  const jumpHits = $derived.by(() => {
    const q = jumpQuery.trim().toLowerCase();
    return q ? jumpFiles.filter((f) => f.b.file.toLowerCase().includes(q)) : jumpFiles;
  });

  function openJump() {
    jumpQuery = '';
    jumpAt = 0;
    jumpOpen = true;
  }
  function closeJump() {
    jumpOpen = false;
    // trapFocus restores focus on destroy, but only to whatever was focused at mount —
    // be explicit, because a jump should always leave the keyboard on the diff.
    if (scroller) scroller.focus({ preventScroll: true });
  }
  /** @param {number} i */
  function jumpTo(i: number) {
    cursor = i;
    closeJump();
    reveal(i);
  }

  /** @param {KeyboardEvent} e */
  function onJumpKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { closeJump(); }
    else if (e.key === 'ArrowDown') { jumpAt = Math.min(jumpAt + 1, jumpHits.length - 1); }
    else if (e.key === 'ArrowUp') { jumpAt = Math.max(jumpAt - 1, 0); }
    else if (e.key === 'Enter') { const hit = jumpHits[jumpAt]; if (hit) jumpTo(hit.i); }
    else return;
    e.preventDefault();
  }

  $effect(() => { if (jumpOpen && jumpInput) jumpInput.focus(); });
  // A query that filters everything away must not leave the highlight past the end.
  $effect(() => { if (jumpAt >= jumpHits.length) jumpAt = 0; });

  /** One-line description of the cursor, for the polite live region. */
  const cursorLabel = $derived.by(() => {
    const it = items[cursor];
    if (!it) return '';
    if (it.k === 'file') return `file ${it.b.file}, ${statusInfo(it.b.status).label}${it.b.collapsed ? ', collapsed' : ''}`;
    if (it.k === 'hunk') return `hunk ${it.hunk.index + 1}, ${it.hunk.header}${it.g.side ? `, ${it.g.side}` : ''}`;
    if (it.k === 'group') return it.g.label;
    if (it.k === 'note') return it.note.text;
    if (it.k === 'row') {
      const l = it.right || it.left;
      const n = it.type === 'del' ? it.left && it.left.oldLine : l && l.newLine;
      return `${it.type} line ${n ?? ''}: ${(l && l.text) || 'empty'}`;
    }
    return '';
  });

  /** @param {import('./model.js').Item} it */
  const rowCls = (it: Item) => (it.k === 'row' ? it.type : '');
</script>

<div class="viewport-shell">
  <!--
    The scroller is a focusable, keyboard-driven surface, which the a11y rules flag
    because `group` is not an interactive role. The alternatives are worse here:
    `role="application"` would make screen readers stop reading the diff in browse
    mode — the exact content the user came for — and `role="listbox"` cannot legally
    hold the Stage buttons that sit in the hunk headers. So: keep the content plainly
    readable, keep the buttons real buttons, and announce the cursor through the polite
    live region below. Suppressed knowingly, not by accident.
  -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="viewport"
    class:focused
    bind:this={scroller}
    onscroll={onScroll}
    onwheel={onWheel}
    onpointerdown={onPointerDown}
    onkeydown={onKeydown}
    onfocusin={() => { focused = true; }}
    onfocusout={onFocusout}
    onblur={() => { focused = false; }}
    tabindex="0"
    role="group"
    aria-label="Diff — arrow keys move, n and p jump hunks, bracket keys jump files, f lists the files in this change{stageable ? ', s stages, u unstages' : ''}"
    style="--cols:{model.cols}"
  >
    <div
      id="diff-canvas"
      class="canvas"
      class:split
      style="height:{model.total}px; --hxl:{hxL}px; --hxr:{hxR}px"
    >
      {#each window_ as i (i)}
        {@const it = items[i]}
        {#if it.k === 'gap'}
          <div class="gap" style="top:{model.offsets[i]}px"></div>
        {:else if it.k === 'file'}
          {@const st = statusInfo(it.b.status)}
          <div
            class="fileline"
            class:cursor={i === cursor}
            style="top:{model.offsets[i]}px"
            aria-current={i === cursor ? 'true' : undefined}
          >
            <div class="stick">
              <span
                class="filehd"
                class:collapsed={it.b.collapsed}
                use:activatable={() => { cursor = i; ontoggle(it.b.file); }}
                title={it.b.collapsed ? 'Expand' : 'Collapse'}
              >
                <span class="tw" aria-hidden="true">{it.b.collapsed ? '▸' : '▾'}</span>
                <span class="st {st.cls}" title={st.label}>{st.letter}</span>
                <span class="nm">{it.b.file}</span>
                {#if it.b.rename}<span class="ren" title="probable rename">{it.b.rename}</span>{/if}
                <span class="fstat">
                  {#if it.b.added}<span class="add">+{it.b.added}</span>{/if}
                  {#if it.b.deleted}<span class="del">−{it.b.deleted}</span>{/if}
                </span>
              </span>
              {#if stageable}
                {@const un = it.b.groups.find((g) => g.side === 'unstaged')}
                {@const st2 = it.b.groups.find((g) => g.side === 'staged')}
                <span class="fileacts">
                  <button
                    class="btn xs" disabled={!un || !un.hunks.length || it.b.busy}
                    onclick={() => { cursor = i; if (un) onapply({ op: 'stage', file: it.b.file, ...selectionOf(un) }); }}
                    title="Stage every hunk in this file (file-level staging)"
                  >Stage file</button>
                  <button
                    class="btn xs" disabled={!st2 || !st2.hunks.length || it.b.busy}
                    onclick={() => { cursor = i; if (st2) onapply({ op: 'unstage', file: it.b.file, ...selectionOf(st2) }); }}
                    title="Unstage every hunk in this file"
                  >Unstage file</button>
                </span>
              {/if}
            </div>
          </div>
        {:else if it.k === 'note'}
          <div class="noteline {it.note.tone}" class:cursor={i === cursor} style="top:{model.offsets[i]}px" aria-current={i === cursor ? 'true' : undefined}>
            <div class="stick"><span class="notetx">{it.note.text}</span></div>
          </div>
        {:else if it.k === 'group'}
          <div class="groupline" class:cursor={i === cursor} style="top:{model.offsets[i]}px" aria-current={i === cursor ? 'true' : undefined}>
            <div class="stick">
              <span class="glabel {it.g.side ?? ''}">{it.g.label}</span>
              {#if stageable && it.g.action}
                <button
                  class="btn xs" disabled={it.b.busy}
                  onclick={() => { cursor = i; onapply({ op: it.g.action === 'stage' ? 'stage' : 'unstage', file: it.b.file, ...selectionOf(it.g) }); }}
                >{it.g.action === 'stage' ? 'Stage all' : 'Unstage all'}</button>
              {/if}
            </div>
          </div>
        {:else if it.k === 'hunk'}
          <div class="hunkline" class:cursor={i === cursor} style="top:{model.offsets[i]}px" aria-current={i === cursor ? 'true' : undefined}>
            <div class="stick">
              <span class="hh">{it.hunk.header}</span>
              <span class="hstat">
                {#if it.hunk.added}<span class="add">+{it.hunk.added}</span>{/if}
                {#if it.hunk.deleted}<span class="del">−{it.hunk.deleted}</span>{/if}
              </span>
              {#if stageable && it.g.action}
                <button
                  class="btn xs" disabled={it.b.busy}
                  onclick={() => { cursor = i; onapply({ op: it.g.action === 'stage' ? 'stage' : 'unstage', file: it.b.file, hunks: [it.hunk.index], expect: [it.hunk.header] }); }}
                  title={it.g.action === 'stage' ? 'Stage this hunk (s)' : 'Unstage this hunk (u)'}
                >{it.g.action === 'stage' ? 'Stage' : 'Unstage'}</button>
              {/if}
            </div>
          </div>
        {:else if split}
          <!--
            `.tx` is the clip box and `.txi` the thing that moves. The wrapper is not
            decoration: a bare transform on the text would slide it left OVER the line
            number, which is not clipped by the row. The gutters must stay put — reading
            a wide line while its line number scrolls away is the bug this whole layout
            exists to avoid.
          -->
          <div class="row split {rowCls(it)}" class:cursor={i === cursor} style="top:{model.offsets[i]}px" aria-current={i === cursor ? 'true' : undefined}>
            <div class="side l {it.left ? (it.type === 'context' ? 'ctx' : 'del') : 'empty'}">
              <span class="ln">{it.left ? (it.left.oldLine ?? '') : ''}</span>
              <span class="tx"><span class="txi">{it.left ? it.left.text : ''}{#if it.left && it.left.noNewline}<span class="nonl" title="No newline at end of file">↵̸</span>{/if}</span></span>
            </div>
            <div class="side r {it.right ? (it.type === 'context' ? 'ctx' : 'add') : 'empty'}">
              <span class="ln">{it.right ? (it.right.newLine ?? '') : ''}</span>
              <span class="tx"><span class="txi">{it.right ? it.right.text : ''}{#if it.right && it.right.noNewline}<span class="nonl" title="No newline at end of file">↵̸</span>{/if}</span></span>
            </div>
          </div>
        {:else}
          {@const line = it.right ?? it.left}
          <div class="row uni {rowCls(it)}" class:cursor={i === cursor} style="top:{model.offsets[i]}px" aria-current={i === cursor ? 'true' : undefined}>
            <span class="ln">{line && line.oldLine != null ? line.oldLine : ''}</span>
            <span class="ln">{line && line.newLine != null ? line.newLine : ''}</span>
            <span class="mk">{it.type === 'add' ? '+' : it.type === 'del' ? '−' : ' '}</span>
            <span class="tx">{line ? line.text : ''}{#if line && line.noNewline}<span class="nonl" title="No newline at end of file">↵̸</span>{/if}</span>
          </div>
        {/if}
      {/each}
    </div>
  </div>

  {#if split}
    <!--
      One scrollbar per column, each sized to ITS OWN widest line, sitting under the text
      area it drives (past the line-number gutter, which never moves). Real scroll
      containers rather than drawn widgets, so they are focusable, arrow-key operable and
      draggable with no code of ours — and each one is the independent control for its
      column that the shared-canvas layout could never offer.

      Styled explicitly because macOS overlay scrollbars are invisible until something
      scrolls, and an invisible affordance for the only way to reach the end of a long
      line is no affordance at all. A column whose lines all fit shows no thumb: the
      track is transparent, so the strip simply reads as empty.
    -->
    <div class="hbars">
      <div class="hcell">
        <div
          class="hbar" bind:this={barL} onscroll={() => onBarScroll('l')}
          style="--w:{model.colsLeft}"
          role="scrollbar" aria-controls="diff-canvas" aria-orientation="horizontal"
          aria-label="Scroll the old (left) column sideways"
          aria-valuenow={pctL} tabindex="0"
        ><div class="hspace"></div></div>
      </div>
      <div class="hcell">
        <div
          class="hbar" bind:this={barR} onscroll={() => onBarScroll('r')}
          style="--w:{model.colsRight}"
          role="scrollbar" aria-controls="diff-canvas" aria-orientation="horizontal"
          aria-label="Scroll the new (right) column sideways"
          aria-valuenow={pctR} tabindex="0"
        ><div class="hspace"></div></div>
      </div>
    </div>
  {/if}

  {#if jumpOpen}
    <button class="jump-scrim" tabindex="-1" aria-label="Close the file list" onclick={closeJump}></button>
    <div
      class="jump"
      use:trapFocus
      onkeydown={onJumpKeydown}
      role="dialog"
      aria-modal="true"
      aria-label="Go to a file in this change"
      tabindex="-1"
    >
      <input
        class="jumpq"
        bind:this={jumpInput}
        bind:value={jumpQuery}
        placeholder="Go to file…"
        aria-label="Filter files by path"
        aria-controls="jump-hits"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="jumplist" id="jump-hits" role="listbox" aria-label="Files in this change">
        {#each jumpHits as h, n (h.i)}
          {@const st = statusInfo(h.b.status)}
          <button
            class="jumprow" class:at={n === jumpAt}
            role="option" aria-selected={n === jumpAt}
            onmouseenter={() => { jumpAt = n; }}
            onclick={() => jumpTo(h.i)}
          >
            <span class="st {st.cls}" title={st.label}>{st.letter}</span>
            <span class="nm">{h.b.file}</span>
            <span class="fstat">
              {#if h.b.added}<span class="add">+{h.b.added}</span>{/if}
              {#if h.b.deleted}<span class="del">−{h.b.deleted}</span>{/if}
            </span>
          </button>
        {/each}
        {#if !jumpHits.length}<div class="jumpnone">No file matches “{jumpQuery}”.</div>{/if}
      </div>
      <div class="jumpfoot"><kbd>↑</kbd><kbd>↓</kbd> pick · <kbd>↵</kbd> go · <kbd>esc</kbd> close</div>
    </div>
  {/if}

  <p class="sr-only" aria-live="polite">{cursorLabel}</p>
  <div class="legend">
    <span><kbd>↑</kbd><kbd>↓</kbd> line</span>
    {#if split}<span><kbd>←</kbd><kbd>→</kbd> pan</span>{/if}
    <span><kbd>n</kbd><kbd>p</kbd> hunk</span>
    <span><kbd>[</kbd><kbd>]</kbd> file</span>
    <span><kbd>f</kbd> go to file</span>
    <span><kbd>↵</kbd> collapse</span>
    {#if stageable}<span><kbd>s</kbd> stage</span><span><kbd>u</kbd> unstage</span>{/if}
    <span class="spacer"></span>
    <span class="count">{items.length.toLocaleString()} rows{items.length > window_.length ? ` · ${window_.length} drawn` : ''}</span>
  </div>
</div>

<style>
  .viewport-shell { position:relative; display:flex; flex-direction:column; min-height:0; flex:1; }
  .viewport {
    flex:1; min-height:0; overflow:auto; background:var(--bg);
    font-family:var(--mono); font-size:12px; tab-size:4; outline-offset:-2px;
  }
  .viewport.focused { box-shadow:inset 0 0 0 1px var(--border-strong); }

  /* The scroll canvas. Its height is the prefix sum of every item; its width is the
     widest line, so the horizontal scrollbar does not twitch as rows are recycled. */
  .canvas { position:relative; width:max(100%, calc(96px + var(--cols) * 1ch)); }
  /* Split pins the canvas to the pane: the columns clip and .hbar scrolls their text. */
  .canvas.split { width:100%; }

  .canvas > :global(*) { position:absolute; left:0; width:100%; }
  .gap { height:9px; }

  /* Headers keep their controls pinned to the left edge while the diff scrolls
     sideways — otherwise a wide file scrolls its own Stage button out of reach. */
  .stick { position:sticky; left:0; display:flex; align-items:center; gap:9px; width:max-content; max-width:100%; padding:0 14px; height:100%; }

  .fileline { height:34px; background:var(--panel); border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
  .filehd { display:flex; align-items:center; gap:9px; font-size:11.5px; cursor:pointer; border-radius:5px; padding:2px 4px; min-width:0; }
  .filehd:hover { background:var(--elevated); }
  .filehd .tw { color:var(--faint); font-size:9px; width:9px; }
  .filehd .st { width:13px; text-align:center; font-weight:700; flex:none; }
  .filehd .st.m { color:var(--waiting); } .filehd .st.a { color:var(--add); }
  .filehd .st.d { color:var(--del); } .filehd .st.r { color:var(--working); }
  .filehd .nm { color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .filehd .ren { color:var(--working); font-size:10.5px; white-space:nowrap; }
  .fstat { display:inline-flex; gap:6px; font-size:10.5px; white-space:nowrap; }
  .fileacts { display:inline-flex; gap:5px; flex:none; }

  .groupline { height:24px; background:var(--elevated); }
  .glabel { font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); }
  .glabel.unstaged { color:var(--waiting); }
  .glabel.staged { color:var(--done); }

  .hunkline { height:24px; background:var(--working-bg); }
  .hh { color:var(--working); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .hstat { display:inline-flex; gap:6px; font-size:10px; }

  .noteline { height:30px; }
  .noteline .notetx { font-size:11px; color:var(--muted); }
  .noteline.warn .notetx { color:var(--waiting); }
  .noteline.error .notetx { color:var(--del); }

  .row { height:19px; line-height:19px; white-space:pre; display:flex; }
  .row .ln { width:44px; flex:none; color:var(--faint); text-align:right; padding-right:8px; user-select:none; font-size:10.5px; }
  .row .mk { width:12px; flex:none; text-align:center; user-select:none; }
  .row .tx { flex:1; }
  /* Tint per row in unified; per SIDE in split. Scoping these to `.uni` is load-bearing:
     a split row also carries its type class, and an unscoped rule painted the whole
     two-column row green for an added line — including the column where nothing was
     added. */
  .row.uni.add { background:var(--add-bg); } .row.uni.add .tx, .row.uni.add .mk { color:var(--add); }
  .row.uni.del { background:var(--del-bg); } .row.uni.del .tx, .row.uni.del .mk { color:var(--del); }
  .row.uni.context .tx { color:var(--muted); }

  .row.split { display:grid; grid-template-columns:1fr 1fr; }
  .row.split .side { display:flex; min-width:0; overflow:hidden; }
  .row.split .side + .side { border-left:1px solid var(--border); }
  .row.split .side.del { background:var(--del-bg); } .row.split .side.del .tx { color:var(--del); }
  .row.split .side.add { background:var(--add-bg); } .row.split .side.add .tx { color:var(--add); }
  .row.split .side.ctx .tx { color:var(--muted); }
  /* The clip box stops at the gutter; only `.txi` moves, and each side moves by its own
     column's offset. `width:max-content` keeps a long line on one line inside a box that
     is narrower than it is. */
  .row.split .side .tx { overflow:hidden; }
  .row.split .side .txi { display:block; width:max-content; will-change:transform; }
  .row.split .side.l .txi { transform:translateX(calc(-1 * var(--hxl, 0px))); }
  .row.split .side.r .txi { transform:translateX(calc(-1 * var(--hxr, 0px))); }
  /* A one-sided change gets a hatched filler on the other side, so the eye can tell
     "nothing here" from "an empty line here". */
  .row.split .side.empty { background:repeating-linear-gradient(45deg, transparent, transparent 4px, var(--border) 4px, var(--border) 5px); opacity:.35; }

  .nonl { color:var(--waiting); padding-left:4px; }

  .cursor { box-shadow:inset 2px 0 0 var(--brand), inset 0 0 0 1px var(--border-strong); }

  /* The two column scrollbars. `.hcell` mirrors the row grid exactly — same 1fr/1fr
     split, same 44px gutter offset, same divider — so each bar's travel is that column's
     real overflow and its thumb sits directly under the text it moves. */
  .hbars { flex:none; display:grid; grid-template-columns:1fr 1fr; background:var(--panel); border-top:1px solid var(--border); }
  .hcell { min-width:0; padding-left:44px; }
  .hcell + .hcell { border-left:1px solid var(--border); }
  .hbar { overflow-x:auto; overflow-y:hidden; height:11px; font-family:var(--mono); font-size:12px; outline-offset:-2px; }
  .hbar::-webkit-scrollbar { height:9px; }
  .hbar::-webkit-scrollbar-track { background:transparent; }
  .hbar::-webkit-scrollbar-thumb { background:var(--border-strong); border-radius:5px; border:2px solid var(--panel); }
  .hbar::-webkit-scrollbar-thumb:hover { background:var(--muted); }
  .hbar:focus-visible { outline:2px solid var(--brand); }
  .hspace { width:calc(var(--w) * 1ch); height:1px; }

  .legend { flex:none; display:flex; align-items:center; gap:12px; padding:4px 14px; border-top:1px solid var(--border); background:var(--panel); font-family:var(--mono); font-size:10px; color:var(--faint); }
  .legend .spacer { flex:1; }
  .legend kbd { font-family:var(--mono); font-size:9.5px; border:1px solid var(--border-strong); border-bottom-width:2px; border-radius:3px; padding:0 3px; margin-right:2px; color:var(--muted); }

  /* The file list. Sits over the diff rather than in a portal: it belongs to this
     surface, and `trapFocus` keeps Tab inside it while it is open. */
  .jump-scrim { position:absolute; inset:0; z-index:4; border:0; padding:0; background:var(--bg); opacity:.55; cursor:default; }
  .jump {
    position:absolute; z-index:5; top:18px; left:50%; transform:translateX(-50%);
    width:min(560px, calc(100% - 32px)); max-height:min(60%, 420px);
    display:flex; flex-direction:column;
    background:var(--panel); border:1px solid var(--border-strong); border-radius:10px;
    box-shadow:0 12px 34px rgb(0 0 0 / .38); overflow:hidden;
  }
  .jumpq {
    flex:none; border:0; border-bottom:1px solid var(--border); background:transparent;
    color:var(--ink); font-family:var(--mono); font-size:12.5px; padding:10px 13px; outline:none;
  }
  .jumpq::placeholder { color:var(--faint); }
  .jumplist { overflow:auto; min-height:0; }
  .jumprow {
    display:flex; align-items:center; gap:9px; width:100%; text-align:left;
    border:0; background:none; cursor:pointer; padding:5px 13px;
    font-family:var(--mono); font-size:11.5px; color:var(--ink);
  }
  .jumprow.at { background:var(--elevated); box-shadow:inset 2px 0 0 var(--brand); }
  .jumprow .st { width:13px; text-align:center; font-weight:700; flex:none; }
  .jumprow .st.m { color:var(--waiting); } .jumprow .st.a { color:var(--add); }
  .jumprow .st.d { color:var(--del); } .jumprow .st.r { color:var(--working); }
  /* Long paths matter at the END — `.../review/DiffViewport.svelte` — so clip the head. */
  .jumprow .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; }
  .jumprow .fstat { flex:none; display:inline-flex; gap:6px; font-size:10.5px; }
  .jumpnone { padding:12px 13px; font-family:var(--mono); font-size:11.5px; color:var(--faint); }
  .jumpfoot { flex:none; padding:5px 13px; border-top:1px solid var(--border); font-family:var(--mono); font-size:9.5px; color:var(--faint); }
  .jumpfoot kbd { font-family:var(--mono); font-size:9.5px; border:1px solid var(--border-strong); border-bottom-width:2px; border-radius:3px; padding:0 3px; margin-right:2px; color:var(--muted); }

  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; margin:0; }
</style>
