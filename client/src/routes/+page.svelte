<script>
  /*
   * Foundation harness. The real shell — rail, dock chrome, tab strips, fleet — is not
   * ported yet, so this page exists to exercise what is: the design tokens and the
   * Terminal component, against a live daemon.
   *
   * The one-shot /api/state fetch below is NOT the state layer. It is the smallest thing
   * that yields a real session id to attach to; the SSE-driven store replaces it.
   */
  import TopBar from '$lib/components/TopBar.svelte';
  import Terminal from '$lib/components/Terminal.svelte';
  import { activatable } from '$lib/actions/activatable.js';

  let mux = $state('…');
  let sessions = $state(/** @type {{id:string,title:string,state:string}[]} */ ([]));
  let sessionId = $state('');
  let split = $state(false);
  let loadError = $state('');

  let mainStatus = $state('idle');
  let splitStatus = $state('idle');
  let mainTerm = $state(/** @type {any} */ (null));
  let splitTerm = $state(/** @type {any} */ (null));

  /** @param {string} s */
  const onMainStatus = (s) => { mainStatus = s; };
  /** @param {string} s */
  const onSplitStatus = (s) => { splitStatus = s; };

  $effect(() => {
    fetch('/api/state')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s) => {
        mux = s.mux || 'none';
        sessions = s.sessions || [];
        if (!sessionId && sessions.length) sessionId = sessions[0].id;
      })
      .catch((e) => { loadError = `Cannot reach the daemon: ${e.message}`; });
  });
</script>

<svelte:head><title>Worktree Studio</title></svelte:head>

<TopBar {mux}>
  {#snippet actions()}
    <select class="mini-select" bind:value={sessionId} aria-label="Session">
      {#each sessions as s (s.id)}<option value={s.id}>{s.title}</option>{/each}
    </select>
    <!-- `activatable` on a span that behaves as a button, to keep the ported action
         exercised by something real rather than only by a future call site. -->
    <span
      class="btn xs split-toggle"
      class:on={split}
      use:activatable={() => (split = !split)}
      aria-pressed={split}
      title="Open an independent working shell in this worktree, beside the Claude terminal"
    >⊟ Split</span>
  {/snippet}
</TopBar>

<div class="main">
  <section class="dock">
    {#if loadError}
      <div class="empty">
        <div class="empty-glyph">⚠</div>
        <h2>Daemon unreachable</h2>
        <p>{loadError}</p>
      </div>
    {:else if !sessionId}
      <div class="empty">
        <div class="empty-glyph">⎇</div>
        <h2>No session selected</h2>
        <p>
          Start one from any source — free text, a GitHub / GitLab issue, or an Asana task. It boots
          a real Claude&nbsp;Code session on your CLAUDE.md, and you promote it to a worktree when
          it&rsquo;s real work.
        </p>
      </div>
    {:else}
      <div class="term-area" class:term-split={split}>
        <div class="panewrap">
          <div class="panehd">
            <span>claude</span><span class="st">{mainStatus}</span>
          </div>
          <Terminal
            bind:this={mainTerm}
            {sessionId}
            onstatus={onMainStatus}
          />
        </div>

        {#if split}
          <!-- Same component, different props. The split attaches the standalone `-split`
               session, so it is a second independent socket, not a mirror of the first. -->
          <div class="panewrap">
            <div class="panehd">
              <span>shell</span><span class="st">{splitStatus}</span>
            </div>
            <Terminal
              bind:this={splitTerm}
              {sessionId}
              pane="split"
              autofocus={false}
              onstatus={onSplitStatus}
            />
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  /* The rail column is reserved even though the rail itself is not ported yet, so the
     dock measures the same width it will in the finished app — the terminal sizes itself
     from that box and a later width change would mean a pty resize on every session. */
  .main { flex:1; display:grid; grid-template-columns: var(--rail-w) 1fr; min-height:0; }
  .dock { display:flex; flex-direction:column; min-height:0; min-width:0; grid-column:2; }

  .empty { margin:auto; text-align:center; max-width:440px; padding:40px; color:var(--muted); }
  .empty-glyph { font-size:40px; color:var(--border-strong); }
  .empty h2 { margin:12px 0 6px; color:var(--ink); font-size:20px; }
  .empty p { font-size:14px; line-height:1.55; }

  .term-area { flex:1; min-height:0; min-width:0; display:grid; grid-template-columns:1fr; }
  /* The 2px gap showing --border is the divider; no extra element to keep aligned. */
  .term-area.term-split { grid-template-columns:1fr 1fr; gap:2px; background:var(--border); }
  .panewrap { display:flex; flex-direction:column; min-width:0; min-height:0; }
  .panehd { font-family:var(--mono); font-size:10.5px; color:var(--muted); padding:5px 10px; background:var(--elevated); border-bottom:1px solid var(--border); display:flex; align-items:center; gap:6px; flex:none; }
  .panehd .st { margin-left:auto; color:var(--faint); }

  .split-toggle.on { border-color:var(--brand); color:var(--brand); }
</style>
