<script lang="ts">
  /*
   * One live terminal attached to one multiplexer pane.
   *
   * Every instance owns its xterm, socket, fit addon and ResizeObserver privately, so
   * two terminals on screen cannot reach into each other's state.
   *
   * Wire protocol (server/server.js, wss.on('connection')) — unchanged:
   *   GET /ws/term?session=<id>[&tab=<i>]&cols=<n>&rows=<n>
   *   client → server: raw bytes (written straight to the pty), or JSON
   *                    {type:'resize',cols,rows} / {type:'input',data}
   *   server → client: raw pty output, text or binary frames
   */
  import { untrack } from 'svelte';
  import { Terminal as XTerm } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import '@xterm/xterm/css/xterm.css';
  import { termTheme } from '$lib/theme.svelte.js';
  import { TOKEN } from '$lib/api.js';
  // A VALUE from server/types, not just a type — the close code has to be the same
  // number on both ends, and types.ts is the file both ends already agree on.
  import { TERM_CLOSE_DEAD } from '../../../../server/types';

  let {
    /** Session id from /api/state. */
    sessionId,
    /** Optional pane/window index, forwarded as `tab`. */
    tab = null,
    /** False while the pane is hidden — suppresses fitting against a zero-sized box. */
    active = true,
    /** Take keyboard focus once connected. Only one pane on screen should do this. */
    autofocus = true,
    /** Reconnect attempts after an unintended drop, backing off 1s→2s→4s. */
    maxRetries = 5,
    /** @type {((s: 'connecting'|'open'|'reconnecting'|'closed') => void)|undefined} */
    onstatus = undefined,
  } = $props();

  // Matches the pre-port terminal exactly — font metrics decide cols/rows, so changing
  // any of this silently reshapes every tmux window the UI attaches to.
  const XTERM_OPTIONS = {
    fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
    fontSize: 13.5,
    cursorBlink: true,
    scrollback: 8000,
    allowProposedApi: true,
  };

  let host = $state<HTMLElement|null>(null);
  let term = $state<XTerm|null>(null);
  let fitAddon = (null as FitAddon|null);
  let socket = (null as WebSocket|null);
  let retryTimer = (null as ReturnType<typeof setTimeout>|null);
  let lastTarget = (null as string|null);

  // Bumped on every teardown and retarget. Socket callbacks capture the value they were
  // created under and bail if it moved on, which is how a superseded socket's late
  // onopen/onclose stays silent instead of writing into a terminal that has moved to
  // another session. app.js did this by comparing captured `term` identity; a counter
  // says the same thing without depending on object identity surviving a retarget.
  let generation = 0;

  /**
   * A ResizeObserver whose callback fits a terminal synchronously can retrigger itself
   * in the same frame — the browser then reports "ResizeObserver loop completed with
   * undelivered notifications". Coalescing to the next animation frame breaks that loop.
   * @param {() => void} cb
   */
  function rafObserver(cb: () => void) {
    let scheduled = false;
    return new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        try { cb(); } catch { /* element detached between frames */ }
      });
    });
  }

  /** @param {XTerm} t @param {string} s */
  function note(t: XTerm, s: string) {
    // Dim, so daemon-level notices never read as program output.
    try { t.write(`\r\n\x1b[2m${s}\x1b[0m\r\n`); } catch { /* disposed mid-flight */ }
  }

  function sendResize() {
    if (!term || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }

  function closeSocket() {
    generation++;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const s = socket;
    socket = null;
    if (!s) return;
    // Drop the handlers BEFORE closing: otherwise our own close() arrives as an onclose
    // and starts a reconnect chain against a socket we are deliberately abandoning.
    s.onclose = null; s.onmessage = null; s.onopen = null; s.onerror = null;
    try { s.close(); } catch { /* already closing */ }
  }

  /**
   * @param {XTerm} t
   * @param {number} attempt
   * @param {number} gen
   */
  function connect(t: XTerm, attempt: number, gen: number) {
    if (gen !== generation) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams({ session: sessionId, cols: String(t.cols), rows: String(t.rows) });
    if (tab != null) qs.set('tab', String(tab));
    // A WebSocket handshake cannot carry a header, so the boot token rides in the query
    // string — the form server/security.js accepts for exactly this reason. Without it
    // the upgrade is refused with 401 before any pty is spawned.
    if (TOKEN) qs.set('token', TOKEN);

    const sock = new WebSocket(`${proto}://${location.host}/ws/term?${qs}`);
    sock.binaryType = 'arraybuffer';
    socket = sock;
    onstatus?.('connecting');

    sock.onmessage = (e) => {
      // Raw pty output. It passes through unparsed — anything that inspected or
      // re-encoded it would break escape sequences mid-frame.
      if (typeof e.data === 'string') t.write(e.data);
      else t.write(new Uint8Array(e.data));
    };

    sock.onopen = () => {
      if (gen !== generation) { try { sock.close(); } catch { /* */ } return; }
      if (attempt > 0) note(t, '[reconnected]');
      // The pty spawned at the cols/rows in the query string, but the box may have been
      // resized between constructing the URL and the handshake completing.
      sendResize();
      if (autofocus) t.focus();
      onstatus?.('open');
    };

    sock.onclose = (e) => {
      // Reaching here means an unintended drop — closeSocket() nulls this handler first,
      // so intentional teardowns never land in the retry path.
      if (gen !== generation) return;
      // ...unintended, but not always retryable. TERM_CLOSE_DEAD says the multiplexer
      // session is gone, which no amount of reconnecting brings back — the server has
      // already written the line saying so, and retrying would only scroll it away.
      if (e.code === TERM_CLOSE_DEAD) {
        onstatus?.('closed');
        return;
      }
      if (attempt >= maxRetries) {
        note(t, '[disconnected — reselect to reattach]');
        onstatus?.('closed');
        return;
      }
      note(t, '[reconnecting…]');
      onstatus?.('reconnecting');
      // Capped backoff revives the pane after a daemon restart, which manager.restore()
      // handles on the other side.
      const delay = Math.min(4000, 1000 * 2 ** attempt);
      retryTimer = setTimeout(() => connect(t, attempt + 1, gen), delay);
    };
  }

  // ---- lifecycle ----

  // Own the xterm instance. Deliberately independent of sessionId: retargeting reuses
  // the same xterm (and its DOM/renderer) instead of paying a full teardown per switch.
  $effect(() => {
    const el = host;
    if (!el) return;

    const t = new XTerm({ ...XTERM_OPTIONS, theme: untrack(termTheme) });
    const f = new FitAddon();
    t.loadAddon(f);
    // Link detection is a nicety; a failure here must not cost us the terminal.
    try { t.loadAddon(new WebLinksAddon()); } catch { /* */ }
    t.open(el);
    try { f.fit(); } catch { /* not laid out yet — the observer refits */ }

    /*
     * Refit once the font metrics have settled.
     *
     * The first fit runs against whatever font is resolved at that instant. If the real
     * monospace face loads afterwards the cell height shifts, and the row count chosen
     * for the old metrics no longer matches the box.
     *
     * Nothing else would catch it: the ResizeObserver fires on SIZE changes, and the
     * container does not change size — only the contents of a cell do. (This is
     * insurance; the row overflow that prompted it was the padding bug, see the CSS.)
     */
    document.fonts?.ready?.then(() => {
      if (host !== el) return; // remounted while the fonts loaded
      try { f.fit(); sendResize(); } catch { /* disposed mid-flight */ }
    }).catch(() => { /* no font loading API, or it rejected — the fit above stands */ });

    /*
     * Shift+Enter has to be spelled differently from Enter, or it does not exist.
     *
     * xterm has no binding for it: both emit a bare CR, so an app on the other end of
     * the pty cannot tell them apart — Claude never saw a Shift+Enter to ignore.
     *
     * It sends LF (0x0A). That is exactly what Ctrl+J puts on the wire, and Ctrl+J is
     * Claude Code's documented "insert a newline" key, so this is the spelling the TUI
     * already understands rather than one it has to be configured for. ESC+CR (the
     * meta-Enter spelling `/terminal-setup` installs into iTerm2) was tried first and
     * did not take — and `cat -v` in a scratch tmux window confirms ESC survives the
     * multiplexer, so the sequence was arriving and simply is not what Claude reads.
     *
     * Returning false stops xterm's default handling; the sequence goes out through the
     * same socket send onData uses, so ordering with ordinary typing is preserved.
     */
    /*
     * ---- Command-key chords ----
     *
     * There is no ANSI encoding for ⌘. A real terminal implements ⌘←/⌘→ at the EMULATOR
     * level: it recognises the chord and writes the bytes the shell already understands.
     * xterm.js does not, so every ⌘ chord fell through its default handling (which
     * ignores meta) and then to the browser, and nothing reached the pty — which is why
     * none of them appeared to work.
     *
     * So Studio does what a terminal does: translate the chord. Each target below is a
     * control code readline and Claude Code's TUI both already bind, so nothing has to be
     * configured on the other end.
     *
     *   ⌘←  ^A  beginning of line        ⌘⌫  ^U  delete to beginning of line
     *   ⌘→  ^E  end of line              ⌘↵  LF  newline without submitting
     *   ⌥←  ESC b  back one word         ⌥→  ESC f  forward one word
     *
     * ⌥←/⌥→ are here for the same reason: macOS terminals send those word-wise
     * sequences, and ⌥ is otherwise only claimed by the rail's ⌥1–9 (digits, no clash).
     */
    const CHORDS: Record<string, string> = {
      'meta:ArrowLeft': '\x01',
      'meta:ArrowRight': '\x05',
      'meta:Backspace': '\x15',
      'meta:Enter': '\n',
      'alt:ArrowLeft': '\x1bb',
      'alt:ArrowRight': '\x1bf',
    };

    const send = (bytes: string): boolean => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(bytes));
      }
      // false stops xterm's default handling; the bytes go out through the same socket
      // onData uses, so ordering with ordinary typing is preserved.
      return false;
    };

    t.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        return send('\n');
      }
      // Exactly one modifier, so ⌘⇧← (select to line start, the browser's) is not stolen.
      if (ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
        const hit = CHORDS[`meta:${ev.key}`];
        if (hit) { ev.preventDefault(); return send(hit); }
      }
      if (ev.altKey && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey) {
        const hit = CHORDS[`alt:${ev.key}`];
        if (hit) { ev.preventDefault(); return send(hit); }
      }
      return true;
    });

    const data = t.onData((d) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(d));
    });

    const ro = rafObserver(() => {
      // A hidden pane measures 0×0. Fitting against that would push a nonsense geometry
      // to the pty and reflow the real tmux window behind the user's back.
      if (!el.clientWidth || !el.clientHeight) return;
      try { f.fit(); } catch { /* */ }
      sendResize();
    });
    ro.observe(el);

    fitAddon = f;
    term = t;

    return () => {
      term = null;
      fitAddon = null;
      closeSocket();
      try { ro.disconnect(); } catch { /* */ }
      try { data.dispose(); } catch { /* */ }
      try { t.dispose(); } catch { /* */ }
    };
  });

  // Own the socket. Re-runs whenever the attach target changes; the returned cleanup is
  // what guarantees a destroyed pane leaves no socket and no pending retry behind.
  $effect(() => {
    // \0 as an escape, not a literal NUL byte. Written raw, those two bytes made
    // `file` classify this source as binary, and every -I grep (ripgrep, ugrep,
    // git grep) then skipped the file SILENTLY — a search for anything in here
    // came back empty rather than wrong, which is the worse failure.
    const target = `${sessionId}\0${tab ?? ''}`;
    const t = term;
    if (!t || !sessionId) return;

    // On a retarget the old session's screen is still painted. tmux redraws on attach,
    // but only what it considers dirty, so clear first rather than blend two sessions.
    if (lastTarget !== null && lastTarget !== target) t.reset();
    lastTarget = target;

    connect(t, 0, ++generation);
    return () => closeSocket();
  });

  // Re-theme in place. app.js only ever re-themed the primary terminal, so a second one
  // kept the old palette until it was torn down; here every instance follows.
  $effect(() => {
    const t = term;
    const next = termTheme();
    if (t) t.options.theme = next;
  });

  // Refit when the pane becomes visible or its column count changes. rAF lets the grid
  // settle first — entering/leaving split changes the layout in the same frame the flag
  // flips, and measuring the old box would send the pty a size it never had. This is
  // app.js's refitPrimary(), now automatic instead of a call the caller must remember.
  $effect(() => {
    if (!active || !term || !fitAddon) return;
    const id = requestAnimationFrame(() => refit());
    return () => cancelAnimationFrame(id);
  });

  // ---- imperative API, for parents holding `bind:this` ----

  export function focus() { term?.focus(); }

  export function refit() {
    if (!term || !fitAddon || !host?.clientWidth || !host?.clientHeight) return;
    try { fitAddon.fit(); } catch { /* */ }
    sendResize();
  }

  /**
   * Send text as if typed. Uses the protocol's {type:'input'} frame rather than raw
   * bytes so a payload that happens to be valid JSON can't be misread as a control
   * message by the server's parse-then-fallback branch.
   * @param {string} data
   */
  export function sendText(data: string) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'input', data }));
    return true;
  }
</script>

<div class="term-wrap" bind:this={host} data-session={sessionId}></div>

<style>
  /* Follows the theme via --term-bg. That token and TERM_THEMES in theme.svelte.ts
     must stay in step: xterm cannot read a CSS custom property, so the palette is
     declared twice — here for the padding around the canvas, there for the canvas. */
  /*
   * `overflow:hidden` is load-bearing, not tidiness.
   *
   * FitAddon picks a whole number of rows, and a container height that is not an exact
   * multiple of the cell height leaves a remainder. xterm still lays `.xterm-screen` out
   * at rows × cellHeight, so that layer can end up TALLER than this box — measured at 6px
   * over, which with the default `overflow:visible` painted the last partial row straight
   * through the action bar below.
   *
   * It only became visible when the type scale went up a point and changed the cell
   * height; the geometry was always able to do it. Clipping here is what makes the
   * terminal end where its box ends, whatever the remainder happens to be.
   */
  /*
   * THE PADDING LIVES ON .xterm, NOT ON .term-wrap. This is not cosmetic.
   *
   * FitAddon computes its row count as:
   *
   *     available = getComputedStyle(PARENT).height − padding of the XTERM ELEMENT
   *     rows      = floor(available / cellHeight)
   *
   * It reads the height off the parent and the padding off the child. With
   * `box-sizing: border-box` (set globally in app.css) the parent's computed height
   * INCLUDES its own padding — so padding on the parent is invisible to that formula and
   * gets counted as usable space. Measured: parent 691.5px, real content box 676px,
   * FitAddon believed 691. It laid out one row too many, and that row hung 13px past the
   * bottom, over the action bar.
   *
   * Moving the padding onto .xterm makes the two halves of the formula agree, and
   * `floor()` then does what it was always supposed to: the terminal ends exactly where
   * its box ends.
   *
   * overflow:hidden stays as a guard, not as the fix — so any future disagreement clips a
   * pixel instead of painting over the bar.
   */
  .term-wrap { flex:1; min-height:0; min-width:0; overflow:hidden; background:var(--term-bg); }
  .term-wrap :global(.xterm) { height:100%; padding:8px 10px; }
</style>
