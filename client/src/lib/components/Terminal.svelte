<script>
  /*
   * One live terminal attached to one multiplexer pane.
   *
   * This replaces the duplicated globals in public/app.js — term/term2, fit/fit2,
   * ws/ws2, ro/ro2 and their parallel open/connect/resize/destroy functions. Every
   * instance owns its xterm, socket, fit addon and ResizeObserver privately, so the
   * primary pane and the split pane are the same code with different props and
   * neither can reach into the other's state. Mount it twice to get a split.
   *
   * Wire protocol (server/server.js, wss.on('connection')) — unchanged:
   *   GET /ws/term?session=<id>[&pane=split][&tab=<i>]&cols=<n>&rows=<n>
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

  let {
    /** Session id from /api/state. */
    sessionId,
    /** `'split'` attaches the standalone `-split` session; null/undefined is the primary. */
    pane = null,
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
    fontSize: 12.5,
    cursorBlink: true,
    scrollback: 8000,
    allowProposedApi: true,
  };

  let host = $state(/** @type {HTMLElement|null} */ (null));
  let term = $state(/** @type {XTerm|null} */ (null));
  let fitAddon = /** @type {FitAddon|null} */ (null);
  let socket = /** @type {WebSocket|null} */ (null);
  let retryTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  let lastTarget = /** @type {string|null} */ (null);

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
  function rafObserver(cb) {
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
  function note(t, s) {
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
  function connect(t, attempt, gen) {
    if (gen !== generation) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams({ session: sessionId, cols: String(t.cols), rows: String(t.rows) });
    if (pane) qs.set('pane', pane);
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

    sock.onclose = () => {
      // Reaching here means an unintended drop — closeSocket() nulls this handler first,
      // so intentional teardowns never land in the retry path.
      if (gen !== generation) return;
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
    const target = `${sessionId} ${pane ?? ''} ${tab ?? ''}`;
    const t = term;
    if (!t || !sessionId) return;

    // On a retarget the old session's screen is still painted. tmux redraws on attach,
    // but only what it considers dirty, so clear first rather than blend two sessions.
    if (lastTarget !== null && lastTarget !== target) t.reset();
    lastTarget = target;

    connect(t, 0, ++generation);
    return () => closeSocket();
  });

  // Re-theme in place. app.js only ever re-themed the primary terminal, so a split pane
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
  export function sendText(data) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'input', data }));
    return true;
  }
</script>

<div class="term-wrap" bind:this={host} data-session={sessionId} data-pane={pane ?? 'main'}></div>

<style>
  /* Dark in both themes via --term-bg: a light-on-white terminal reads as a different
     application sitting inside this one. */
  .term-wrap { flex:1; min-height:0; min-width:0; background:var(--term-bg); padding:8px 10px; }
  .term-wrap :global(.xterm) { height:100%; }
</style>
