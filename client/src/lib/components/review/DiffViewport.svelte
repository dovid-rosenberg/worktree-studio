<script>
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

  let {
    /** @type {import('./model.js').Block[]} */
    blocks,
    view = /** @type {'unified'|'split'} */ ('unified'),
    /** True on the uncommitted entry: hunk and file staging controls are shown. */
    stageable = false,
    /** @type {(file:string) => void} */
    ontoggle = () => {},
    /** @type {(a:{ op:'stage'|'unstage', file:string, hunks:number[], expect:string[] }) => void} */
    onapply = () => {},
  } = $props();

  /** Extra items rendered above and below the viewport so a fast flick never shows blank. */
  const OVERSCAN = 8;

  let scroller = $state(/** @type {HTMLElement|null} */ (null));
  let scrollTop = $state(0);
  let viewH = $state(600);
  let cursor = $state(0);
  let focused = $state(false);

  const model = $derived(buildItems(blocks, view));
  const items = $derived(model.items);

  // Reset the cursor whenever the underlying list identity changes (new commit, view
  // flip, a file collapsed) rather than leaving it pointing at an unrelated row.
  $effect(() => {
    const n = items.length;
    if (cursor >= n) cursor = Math.max(0, n - 1);
  });

  const first = $derived(Math.max(0, indexAt(model.offsets, scrollTop, items.length) - OVERSCAN));
  const last = $derived(Math.min(items.length, indexAt(model.offsets, scrollTop + viewH, items.length) + OVERSCAN + 1));
  /** Absolute indexes of the rendered slice — keyed by index so Svelte reuses nodes. */
  const window_ = $derived(Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i));

  function onScroll() {
    if (scroller) scrollTop = scroller.scrollTop;
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
  function reveal(i) {
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
  function move(dir, pred) {
    for (let i = cursor + dir; i >= 0 && i < items.length; i += dir) {
      if (pred(items[i])) { cursor = i; reveal(i); return true; }
    }
    return false;
  }

  /** The hunk indexes + `@@` headers a stage/unstage of `g` would send. */
  function selectionOf(/** @type {import('./model.js').Group} */ g) {
    return { hunks: g.hunks.map((h) => h.index), expect: g.hunks.map((h) => h.header) };
  }

  /**
   * Apply the cursor's implied stage/unstage. On a hunk header that is one hunk; on a
   * group or file header it is every hunk on the matching side — which is exactly the
   * file-level staging the panel also exposes as a button, driven from the keyboard.
   * @param {'stage'|'unstage'} op
   */
  function applyAtCursor(op) {
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
  function onKeydown(e) {
    // A real control inside a rendered row owns its own keys; only the panel-wide
    // shortcuts that cannot collide with typing are honoured from there.
    const inControl = e.target !== scroller;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (inControl && e.key !== 'Escape') return;

    switch (e.key) {
      case 'ArrowDown': case 'j': move(1, navigable); break;
      case 'ArrowUp': case 'k': move(-1, navigable); break;
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
  function jump(n) {
    const dir = n < 0 ? -1 : 1;
    for (let i = 0; i < Math.abs(n); i++) if (!move(dir, navigable)) break;
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
  const rowCls = (it) => (it.k === 'row' ? it.type : '');
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
    onkeydown={onKeydown}
    onfocusin={() => { focused = true; }}
    onfocusout={onFocusout}
    onblur={() => { focused = false; }}
    tabindex="0"
    role="group"
    aria-label="Diff — arrow keys move, n and p jump hunks, bracket keys jump files{stageable ? ', s stages, u unstages' : ''}"
    style="--cols:{model.cols}"
  >
    <div class="canvas" class:split={view === 'split'} style="height:{model.total}px">
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
        {:else if view === 'split'}
          <div class="row split {rowCls(it)}" class:cursor={i === cursor} style="top:{model.offsets[i]}px" aria-current={i === cursor ? 'true' : undefined}>
            <div class="side {it.left ? (it.type === 'context' ? 'ctx' : 'del') : 'empty'}">
              <span class="ln">{it.left ? (it.left.oldLine ?? '') : ''}</span>
              <span class="tx">{it.left ? it.left.text : ''}{#if it.left && it.left.noNewline}<span class="nonl" title="No newline at end of file">↵̸</span>{/if}</span>
            </div>
            <div class="side {it.right ? (it.type === 'context' ? 'ctx' : 'add') : 'empty'}">
              <span class="ln">{it.right ? (it.right.newLine ?? '') : ''}</span>
              <span class="tx">{it.right ? it.right.text : ''}{#if it.right && it.right.noNewline}<span class="nonl" title="No newline at end of file">↵̸</span>{/if}</span>
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

  <p class="sr-only" aria-live="polite">{cursorLabel}</p>
  <div class="legend">
    <span><kbd>↑</kbd><kbd>↓</kbd> line</span>
    <span><kbd>n</kbd><kbd>p</kbd> hunk</span>
    <span><kbd>[</kbd><kbd>]</kbd> file</span>
    <span><kbd>↵</kbd> collapse</span>
    {#if stageable}<span><kbd>s</kbd> stage</span><span><kbd>u</kbd> unstage</span>{/if}
    <span class="spacer"></span>
    <span class="count">{items.length.toLocaleString()} rows{items.length > window_.length ? ` · ${window_.length} drawn` : ''}</span>
  </div>
</div>

<style>
  .viewport-shell { display:flex; flex-direction:column; min-height:0; flex:1; }
  .viewport {
    flex:1; min-height:0; overflow:auto; background:var(--bg);
    font-family:var(--mono); font-size:12px; tab-size:4; outline-offset:-2px;
  }
  .viewport.focused { box-shadow:inset 0 0 0 1px var(--border-strong); }

  /* The scroll canvas. Its height is the prefix sum of every item; its width is the
     widest line, so the horizontal scrollbar does not twitch as rows are recycled. */
  .canvas { position:relative; width:max(100%, calc(96px + var(--cols) * 1ch)); }
  .canvas.split { width:max(100%, calc(2 * (52px + var(--cols) * 1ch))); }

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
  .row.add { background:var(--add-bg); } .row.add .tx, .row.add .mk { color:var(--add); }
  .row.del { background:var(--del-bg); } .row.del .tx, .row.del .mk { color:var(--del); }
  .row.context .tx { color:var(--muted); }

  .row.split { display:grid; grid-template-columns:1fr 1fr; }
  .row.split .side { display:flex; min-width:0; overflow:hidden; }
  .row.split .side + .side { border-left:1px solid var(--border); }
  .row.split .side.del { background:var(--del-bg); } .row.split .side.del .tx { color:var(--del); }
  .row.split .side.add { background:var(--add-bg); } .row.split .side.add .tx { color:var(--add); }
  .row.split .side.ctx .tx { color:var(--muted); }
  /* A one-sided change gets a hatched filler on the other side, so the eye can tell
     "nothing here" from "an empty line here". */
  .row.split .side.empty { background:repeating-linear-gradient(45deg, transparent, transparent 4px, var(--border) 4px, var(--border) 5px); opacity:.35; }

  .nonl { color:var(--waiting); padding-left:4px; }

  .cursor { box-shadow:inset 2px 0 0 var(--brand), inset 0 0 0 1px var(--border-strong); }

  .legend { flex:none; display:flex; align-items:center; gap:12px; padding:4px 14px; border-top:1px solid var(--border); background:var(--panel); font-family:var(--mono); font-size:10px; color:var(--faint); }
  .legend .spacer { flex:1; }
  .legend kbd { font-family:var(--mono); font-size:9.5px; border:1px solid var(--border-strong); border-bottom-width:2px; border-radius:3px; padding:0 3px; margin-right:2px; color:var(--muted); }

  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; margin:0; }
</style>
